import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { DapReader, encodeDap, type DapMessage } from '../src/main/debug/dap-framing';
import { NodeAdapter } from '../src/main/debug/node-adapter';

/**
 * Отладочный адаптер Node: сквозной прогон против настоящего `node --inspect-brk`.
 *
 * Адаптер — код в процессе, поэтому поднимаем его не отдельным файлом, а прямо
 * классом, соединив с ним два потока `PassThrough`: в один пишем DAP-запросы, из
 * другого читаем ответы и события. Отлаживаемая программа настоящая — так
 * проверяется вся цепочка: запуск инспектора, поиск адреса в stderr, CDP-сессия,
 * точки останова, стек, переменные, шаги и вывод.
 */

interface DapResponse {
  success?: boolean;
  body?: Record<string, unknown>;
  message?: string;
}

/** Простейший DAP-клиент: запросы с ожиданием ответа и события с ожиданием наступления. */
class DapClient {
  private seq = 1;
  private readonly pending = new Map<number, (message: DapMessage) => void>();
  private readonly events: DapMessage[] = [];
  private readonly reader: DapReader;

  constructor(
    private readonly toAdapter: PassThrough,
    fromAdapter: PassThrough,
  ) {
    this.reader = new DapReader((message) => this.onMessage(message));
    fromAdapter.on('data', (chunk: Buffer) => this.reader.push(chunk));
  }

  request(command: string, args?: Record<string, unknown>): Promise<DapResponse> {
    const seq = this.seq;
    this.seq += 1;
    const answered = new Promise<DapResponse>((resolve) => this.pending.set(seq, (message) => resolve(message)));
    this.toAdapter.write(encodeDap({ seq, type: 'request', command, ...(args ? { arguments: args } : {}) }));
    return answered;
  }

  /** Дождаться события `name`, при желании — первого подходящего под `match`. */
  async waitEvent(name: string, match?: (message: DapMessage) => boolean, timeout = 8000): Promise<DapMessage> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const index = this.events.findIndex((message) => message.event === name && (!match || match(message)));
      if (index >= 0) return this.events.splice(index, 1)[0];
      if (Date.now() > deadline) throw new Error(`Не дождались события «${name}»`);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Назревшие события с таким именем: ими проверяют, что события НЕ случилось. */
  pendingEvents(name: string): DapMessage[] {
    return this.events.filter((message) => message.event === name);
  }

  private onMessage(message: DapMessage): void {
    if (message.type === 'response' && message.request_seq !== undefined) {
      this.pending.get(message.request_seq)?.(message);
      this.pending.delete(message.request_seq);
      return;
    }
    if (message.type === 'event') this.events.push(message);
  }
}

const dirs: string[] = [];
/** Процессы, запущенные тестами: подключение требует, чтобы цель уже работала. */
const children: ChildProcess[] = [];

/**
 * Поднять процесс с открытым инспектором — так его поднял бы человек, а отладчик
 * к нему только подключается. Порт Node печатает сам (`--inspect=…:0`), поэтому
 * вычитываем его из stderr, а не назначаем заранее: занятый порт ломал бы прогон.
 */
function startInspectable(program: string, cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // stdout не наследуем и не читаем: программа живёт долго и печатать может много,
    // а незакрытая труба однажды застопорила бы её — и точка останова не сработала бы.
    const child = spawn('node', ['--inspect=127.0.0.1:0', program], { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child);

    const timer = setTimeout(() => reject(new Error('Инспектор процесса не открылся')), 8000);
    let probe = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      probe += chunk.toString('utf8');
      const match = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(probe);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    child.on('error', reject);
  });
}

function startAdapter(): { input: PassThrough; client: DapClient } {
  const input = new PassThrough();
  const output = new PassThrough();
  new NodeAdapter(input, output).run();
  return { input, client: new DapClient(input, output) };
}

/**
 * Ссылка на каталог — второе имя того же места.
 *
 * Так устроены macOS и Windows: временный каталог `/var/folders/…` на самом деле
 * лежит в `/private/var/folders/…`, а `process.cwd()` и Node называют скрипты уже
 * развёрнутым путём. Клиент при этом зовёт файл своим именем — через симлинк, — и
 * без сопоставления имён точка останова не совпала бы со скриптом.
 */
function linkDir(target: string): string {
  const parent = mkdtempSync(path.join(tmpdir(), 'chui-node-link-'));
  dirs.push(parent);
  const link = path.join(parent, 'alias');
  // junction — единственная ссылка на каталог в Windows, не требующая прав.
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  return link;
}

/** Маленькая программа для отладки: сумма в функции и вывод результата. */
function writeProgram(dir: string): string {
  const program = path.join(dir, 'app.js');
  writeFileSync(
    program,
    [
      'function add(a, b) {',
      '  const sum = a + b;',
      '  return sum;',
      '}',
      "console.log('result', add(2, 3));",
      '',
    ].join('\n'),
    'utf8',
  );
  return program;
}

/** Программа с циклом: точка на строке 3 срабатывает пять раз. */
function writeLoop(dir: string): string {
  const program = path.join(dir, 'loop.js');
  writeFileSync(
    program,
    [
      'let total = 0;',
      'for (let i = 0; i < 5; i += 1) {',
      '  total += i;',
      '}',
      "console.log('total', total);",
      '',
    ].join('\n'),
    'utf8',
  );
  return program;
}

/**
 * Программа «TypeScript, собранный в JavaScript»: рядом лежат исходник, сборка и
 * карта между ними. Строки сдвинуты (`"use strict"` и развёрнутая шапка функции),
 * поэтому перевод позиций виден: точка в `.ts` не совпала бы со строкой в `.js`.
 */
function writeCompiled(dir: string): { original: string; generated: string } {
  const original = path.join(dir, 'app.ts');
  const generated = path.join(dir, 'app.js');
  writeFileSync(
    original,
    [
      'function add(a: number, b: number): number {',
      '  const sum: number = a + b;',
      '  return sum;',
      '}',
      "console.log('result', add(2, 3));",
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    generated,
    [
      '"use strict";',
      'function add(a, b) {',
      '  const sum = a + b;',
      '  return sum;',
      '}',
      "console.log('result', add(2, 3));",
      '//# sourceMappingURL=app.js.map',
      '',
    ].join('\n'),
    'utf8',
  );
  // Карта переводит строки исходника в строки сборки и обратно.
  const mappings = {
    version: 3,
    file: 'app.js',
    sources: ['app.ts'],
    names: [],
    mappings: ';AAAA;EACE;EACA;AACF;AACA',
  };
  writeFileSync(`${generated}.map`, JSON.stringify(mappings), 'utf8');
  return { original, generated };
}

describe('NodeAdapter', () => {
  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('отлаживает JS: точки останова, стек, переменные, вычисление, шаг, продолжение', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chui-node-debug-'));
    dirs.push(dir);
    const program = writeProgram(dir);
    const { input, client } = startAdapter();

    const init = await client.request('initialize', { adapterID: 'node' });
    expect(init.success).toBe(true);
    expect(init.body?.supportsConfigurationDoneRequest).toBe(true);

    const launch = client.request('launch', { program, cwd: dir });
    await client.waitEvent('initialized');
    expect((await launch).success).toBe(true);

    // Точка останова на строке `const sum = a + b;` (строка 2).
    const bp = await client.request('setBreakpoints', {
      source: { path: program },
      breakpoints: [{ line: 2 }],
    });
    const breakpoints = bp.body?.breakpoints as Array<{ verified: boolean; line: number }>;
    expect(breakpoints[0]?.verified).toBe(true);

    await client.request('configurationDone', {});
    await client.waitEvent('stopped');

    const stack = await client.request('stackTrace', { threadId: 1 });
    const frames = stack.body?.stackFrames as Array<{
      id: number;
      name: string;
      line: number;
      source?: { path?: string };
    }>;
    expect(frames[0]?.source?.path).toBe(program);
    expect(frames[0]?.line).toBe(2);
    const frameId = frames[0].id;

    const scopes = await client.request('scopes', { frameId });
    const scopeList = scopes.body?.scopes as Array<{ name: string; variablesReference: number }>;
    const locals = scopeList.find((scope) => scope.name === 'Локальные');
    expect(locals).toBeTruthy();

    const vars = await client.request('variables', { variablesReference: locals?.variablesReference });
    const list = vars.body?.variables as Array<{ name: string; value: string }>;
    expect(list.find((item) => item.name === 'a')?.value).toBe('2');
    expect(list.find((item) => item.name === 'b')?.value).toBe('3');

    const evaluated = await client.request('evaluate', { expression: 'a + b', frameId });
    expect(evaluated.body?.result).toBe('5');

    const assigned = await client.request('setVariable', {
      variablesReference: locals?.variablesReference,
      name: 'a',
      value: '10',
    });
    expect(assigned.body?.value).toBe('10');

    // Шаг с обходом: со строки 2 на строку 3 того же файла.
    await client.request('next', { threadId: 1 });
    await client.waitEvent('stopped');
    const stack2 = await client.request('stackTrace', { threadId: 1 });
    const frames2 = stack2.body?.stackFrames as Array<{ line: number }>;
    expect(frames2[0]?.line).toBe(3);

    // Продолжение: программа доходит до конца и печатает результат.
    await client.request('continue', { threadId: 1 });
    const output = await client.waitEvent('output', (message) =>
      String((message.body as { output?: string }).output ?? '').includes('result 5'),
    );
    expect(output.body).toBeTruthy();

    await client.request('disconnect', { terminateDebuggee: true });
    input.end();
  }, 20_000);

  it('точка в файле, названном через симлинк, попадает в развёрнутый путь скрипта', async () => {
    const real = mkdtempSync(path.join(tmpdir(), 'chui-node-debug-'));
    dirs.push(real);
    const alias = linkDir(real);
    const viaAlias = path.join(alias, path.basename(writeProgram(real)));
    const { input, client } = startAdapter();

    await client.request('initialize', { adapterID: 'node' });
    const launch = client.request('launch', { program: viaAlias, cwd: alias });
    await client.waitEvent('initialized');
    expect((await launch).success).toBe(true);

    await client.request('setBreakpoints', { source: { path: viaAlias }, breakpoints: [{ line: 2 }] });
    await client.request('configurationDone', {});
    await client.waitEvent('stopped');

    const stack = await client.request('stackTrace', { threadId: 1 });
    const frames = stack.body?.stackFrames as Array<{ line: number; source?: { path?: string } }>;
    expect(frames[0]?.line).toBe(2);
    // Стек называет файл так, как его назвал клиент: по этому имени кадр кликается.
    expect(frames[0]?.source?.path).toBe(viaAlias);

    await client.request('disconnect', { terminateDebuggee: true });
    input.end();
  }, 20_000);

  it('сообщает об ошибке, если отлаживаемый Node не запускается', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chui-node-debug-'));
    dirs.push(dir);
    const program = writeProgram(dir);
    const { input, client } = startAdapter();

    await client.request('initialize', { adapterID: 'node' });
    const launch = await client.request('launch', { program, cwd: dir, runtimeExecutable: '/nonexistent/node' });
    expect(launch.success).toBe(false);
    expect(launch.message).toBeTruthy();

    input.end();
  }, 20_000);

  it('отлаживает собранный JS: точка в .ts встаёт в .js, а стек ведёт в .ts', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chui-node-debug-'));
    dirs.push(dir);
    const { original, generated } = writeCompiled(dir);
    const { input, client } = startAdapter();

    await client.request('initialize', { adapterID: 'node' });
    const launch = client.request('launch', { program: generated, cwd: dir });
    await client.waitEvent('initialized');
    expect((await launch).success).toBe(true);

    // Точка задана в исходнике: строка 2 в `.ts` — это строка 3 в собранном `.js`.
    const bp = await client.request('setBreakpoints', {
      source: { path: original },
      breakpoints: [{ line: 2 }],
    });
    const breakpoints = bp.body?.breakpoints as Array<{ line: number; verified: boolean }>;
    expect(breakpoints[0]?.line).toBe(2);

    await client.request('configurationDone', {});
    await client.waitEvent('stopped');

    // Стек: кадр из собранного `.js` показывается строкой исходника, а не сборки.
    const stack = await client.request('stackTrace', { threadId: 1 });
    const frames = stack.body?.stackFrames as Array<{ line: number; source?: { path?: string } }>;
    expect(frames[0]?.source?.path).toBe(original);
    expect(frames[0]?.line).toBe(2);

    await client.request('continue', { threadId: 1 });
    const output = await client.waitEvent('output', (message) =>
      String((message.body as { output?: string }).output ?? '').includes('result 5'),
    );
    expect(output.body).toBeTruthy();

    await client.request('disconnect', { terminateDebuggee: true });
    input.end();
  }, 20_000);

  it('точка со счётчиком попаданий останавливает только на заданном', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chui-node-debug-'));
    dirs.push(dir);
    const program = writeLoop(dir);
    const { input, client } = startAdapter();

    await client.request('initialize', { adapterID: 'node' });
    const launch = client.request('launch', { program, cwd: dir });
    await client.waitEvent('initialized');
    expect((await launch).success).toBe(true);

    // Точка в теле цикла со счётчиком: останов только на третьем попадании.
    await client.request('setBreakpoints', {
      source: { path: program },
      breakpoints: [{ line: 3, hitCondition: '3' }],
    });
    await client.request('configurationDone', {});
    await client.waitEvent('stopped');

    const stack = await client.request('stackTrace', { threadId: 1 });
    const frames = stack.body?.stackFrames as Array<{ id: number; line: number }>;
    expect(frames[0]?.line).toBe(3);
    // Третье попадание — это `i = 2`: счётчик считает попадания, а не строки.
    const value = await client.request('evaluate', { expression: 'i', frameId: frames[0].id });
    expect(value.body?.result).toBe('2');

    // Дальше счётчик уже не совпадёт: программа доходит до конца без остановов.
    await client.request('continue', { threadId: 1 });
    await client.waitEvent('output', (message) =>
      String((message.body as { output?: string }).output ?? '').includes('total 10'),
    );
    expect(client.pendingEvents('stopped')).toHaveLength(0);

    await client.request('disconnect', { terminateDebuggee: true });
    input.end();
  }, 20_000);

  it('подключается к уже запущенному процессу и останавливает его на точке', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chui-node-debug-'));
    dirs.push(dir);
    // Программа, которая живёт сама: у неё нет входа и выхода, её нельзя «запустить».
    const program = path.join(dir, 'serve.js');
    writeFileSync(
      program,
      ['let count = 0;', 'function tick() {', '  count += 1;', '}', 'setInterval(tick, 25);', ''].join('\n'),
      'utf8',
    );

    const port = await startInspectable(program, dir);
    const { input, client } = startAdapter();

    await client.request('initialize', { adapterID: 'node' });
    const attached = await client.request('attach', { port });
    expect(attached.success).toBe(true);
    await client.waitEvent('initialized');

    const bp = await client.request('setBreakpoints', {
      source: { path: program },
      breakpoints: [{ line: 3 }],
    });
    const breakpoints = bp.body?.breakpoints as Array<{ verified: boolean }>;
    expect(breakpoints[0]?.verified).toBe(true);

    // Программа уже работала: после настройки она остановится сама, на точке.
    await client.request('configurationDone', {});
    // Ждём дольше обычного: под нагрузкой (весь прогон идёт в параллель) таймер
    // до следующего попадания может сработать не сразу.
    await client.waitEvent('stopped', undefined, 15_000);

    const stack = await client.request('stackTrace', { threadId: 1 });
    const frames = stack.body?.stackFrames as Array<{ name: string; line: number; source?: { path?: string } }>;
    expect(frames[0]?.name).toBe('tick');
    expect(frames[0]?.source?.path).toBe(program);
    expect(frames[0]?.line).toBe(3);

    await client.request('disconnect', { terminateDebuggee: true });
    input.end();
  }, 20_000);

  it('точка-журнал печатает значения и не останавливает программу', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chui-node-debug-'));
    dirs.push(dir);
    const program = writeLoop(dir);
    const { input, client } = startAdapter();

    await client.request('initialize', { adapterID: 'node' });
    const launch = client.request('launch', { program, cwd: dir });
    await client.waitEvent('initialized');
    expect((await launch).success).toBe(true);

    // Точка-журнал: вместо останова печатает строку со значением `i`.
    await client.request('setBreakpoints', {
      source: { path: program },
      breakpoints: [{ line: 3, logMessage: 'i = {i}' }],
    });
    await client.request('configurationDone', {});
    await client.waitEvent('output', (message) =>
      String((message.body as { output?: string }).output ?? '').includes('total 10'),
    );

    // На каждое попадание — своя строка, и ни одного останова.
    const logs = client
      .pendingEvents('output')
      .map((message) => String((message.body as { output?: string }).output ?? '').trim())
      .filter((text) => text.length > 0);
    expect(logs).toEqual(['i = 0', 'i = 1', 'i = 2', 'i = 3', 'i = 4']);
    expect(client.pendingEvents('stopped')).toHaveLength(0);

    await client.request('disconnect', { terminateDebuggee: true });
    input.end();
  }, 20_000);

  it('останавливается на необработанном исключении', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chui-node-debug-'));
    dirs.push(dir);
    // Программа бросает исключение из функции: останов должен встать там, где его бросили.
    const program = path.join(dir, 'boom.js');
    writeFileSync(
      program,
      ['function fail() {', "  throw new Error('kaboom');", '}', 'fail();', ''].join('\n'),
      'utf8',
    );
    const { input, client } = startAdapter();

    await client.request('initialize', { adapterID: 'node' });
    const launch = client.request('launch', { program, cwd: dir });
    await client.waitEvent('initialized');
    expect((await launch).success).toBe(true);

    // Точки останова нет: останавливаемся именно из-за исключения.
    await client.request('setExceptionBreakpoints', { filters: ['uncaught'] });
    await client.request('configurationDone', {});

    const stopped = await client.waitEvent('stopped');
    expect((stopped.body as { reason?: string }).reason).toBe('exception');

    // Стек ведёт в бросившую функцию, а не во внутренности процесса.
    const stack = await client.request('stackTrace', { threadId: 1 });
    const frames = stack.body?.stackFrames as Array<{ name: string; line: number }>;
    expect(frames[0]?.name).toBe('fail');
    expect(frames[0]?.line).toBe(2);

    await client.request('disconnect', { terminateDebuggee: true });
    input.end();
  }, 20_000);
});
