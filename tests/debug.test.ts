import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DebugService } from '../src/main/debug/debug';

/**
 * Отладчик: DAP-клиент против фейкового адаптера.
 *
 * Настоящий debugpy в тесте не поднять (нужен питон с пакетом), поэтому адаптер
 * подменяется: скрипт на Node, который говорит по DAP так же, как debugpy, —
 * отвечает на запросы и шлёт события. Так проверяется наш транспорт: фрейминг
 * Content-Length, сопоставление ответов, порядок launch/configurationDone,
 * чтение стека, областей видимости и переменных.
 */

/** Мини-адаптер: повторяет поведение debugpy настолько, насколько нужно клиенту. */
const FAKE_ADAPTER = `
let buffer = Buffer.alloc(0);
let launchSeq = null;
let breakpoints = 0;
function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
}
function response(seq, command, body) {
  send({ type: 'response', request_seq: seq, success: true, command, body: body || {} });
}
function handle(message) {
  if (message.type !== 'request') return;
  const args = message.arguments || {};
  switch (message.command) {
    case 'initialize':
      response(message.seq, 'initialize', { supportsConfigurationDoneRequest: true });
      break;
    case 'launch':
      launchSeq = message.seq;
      // Эхо параметров: тест проверяет, что аргументы и окружение дошли до адаптера
      // (поля DAP args и env).
      send({ type: 'event', event: 'output', body: { category: 'stdout', output: 'launch-args:' + JSON.stringify(args.args || null) } });
      send({ type: 'event', event: 'output', body: { category: 'stdout', output: 'launch-env:' + JSON.stringify(args.env || null) } });
      send({ type: 'event', event: 'initialized' });
      break;
    case 'setBreakpoints':
      breakpoints = (args.breakpoints || []).length;
      // Отладчик возвращает только строку и подтверждение: настройки точки
      // (условие, сообщение, счётчик) он не повторяет — клиент должен помнить их сам.
      response(message.seq, 'setBreakpoints', {
        breakpoints: (args.breakpoints || []).map((b) => ({ verified: true, line: b.line })),
      });
      break;
    case 'evaluate': {
      // Как debugpy: плохое выражение — это ответ с ошибкой, а не молчание.
      const expression = String(args.expression || '');
      if (expression.includes('bad')) {
        send({ type: 'response', request_seq: message.seq, success: false, command: 'evaluate', message: 'NameError: name bad is not defined' });
        break;
      }
      response(message.seq, 'evaluate', { result: '42', type: 'int', variablesReference: 0 });
      break;
    }
    case 'setVariable':
      // Отладчик возвращает фактическое значение (может отличаться от введённого):
      // суффикс ! показывает, что клиент берёт ответ адаптера, а не то, что ввели.
      response(message.seq, 'setVariable', {
        value: String(args.value) + '!',
        type: 'int',
        variablesReference: 0,
      });
      break;
    case 'setExpression':
      // Как setVariable: возвращаем фактическое значение с тем же маркером !.
      response(message.seq, 'setExpression', {
        value: String(args.value) + '!',
        type: 'int',
        variablesReference: 0,
      });
      break;
    case 'configurationDone':
      response(message.seq, 'configurationDone');
      if (launchSeq !== null) {
        response(launchSeq, 'launch');
        launchSeq = null;
      }
      // Как debugpy: сначала программа пошла (process + thread). Останов придёт
      // только если есть точка останова — иначе программа просто выполняется.
      setTimeout(() => send({ type: 'event', event: 'process', body: { name: 'app.py', startMethod: 'launch' } }), 10);
      setTimeout(() => send({ type: 'event', event: 'thread', body: { reason: 'started', threadId: 1 } }), 15);
      if (breakpoints > 0) {
        setTimeout(() => send({ type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 1 } }), 30);
      }
      break;
    case 'stackTrace':
      response(message.seq, 'stackTrace', {
        stackFrames: [{ id: 7, name: 'main', source: { path: '/proj/app.py' }, line: 4, column: 1 }],
      });
      break;
    case 'scopes':
      response(message.seq, 'scopes', { scopes: [{ name: 'Locals', variablesReference: 21, expensive: false }] });
      break;
    case 'variables':
      response(message.seq, 'variables', {
        variables: [
          { name: 'total', value: '3', type: 'int', variablesReference: 0 },
          { name: 'items', value: 'list', type: 'list', variablesReference: 22 },
        ],
      });
      break;
    case 'continue':
      response(message.seq, 'continue');
      setTimeout(() => send({ type: 'event', event: 'terminated' }), 30);
      break;
    case 'pause': {
      // Пауза возможна только с известным threadId: клиент берёт его из события
      // thread. Не знает — молчим, и останов не придёт (прежнее поведение).
      response(message.seq, 'pause', { threadId: args.threadId });
      if (typeof args.threadId === 'number') {
        setTimeout(() => send({ type: 'event', event: 'stopped', body: { reason: 'pause', threadId: args.threadId } }), 20);
      }
      break;
    }
    case 'output':
      response(message.seq, 'output');
      break;
    default:
      response(message.seq, message.command);
  }
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString('ascii');
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    const start = headerEnd + 4;
    if (!match) {
      buffer = buffer.slice(start);
      continue;
    }
    const length = Number(match[1]);
    if (buffer.length < start + length) return;
    const body = buffer.slice(start, start + length).toString('utf8');
    buffer = buffer.slice(start + length);
    try {
      handle(JSON.parse(body));
    } catch {
      continue;
    }
  }
});
`;

const dirs: string[] = [];

/** Уведомление main → renderer: тема и произвольная нагрузка (её разбирает сам тест). */
interface Push {
  topic: string;
  payload: Record<string, unknown>;
}

function fakeService(): { service: DebugService; events: Push[] } {
  const dir = mkdtempSync(path.join(tmpdir(), 'chui-dap-'));
  dirs.push(dir);
  const fake = path.join(dir, 'fake-dap.cjs');
  writeFileSync(fake, FAKE_ADAPTER, 'utf8');

  const events: Push[] = [];
  const service = new DebugService(
    (topic, payload) => events.push({ topic, payload }),
    () => null,
    () => 'python3',
    async () => ({}),
    // Подмена адаптера: тот же протокол, но скрипт на Node.
    () => ({ command: process.execPath, args: [fake] }),
  );
  return { service, events };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Дождаться фазы: события приходят из процесса, поэтому ждём, а не спим фиксированно. */
async function waitPhase(service: DebugService, phase: string, timeout = 5000): Promise<string> {
  const started = Date.now();
  while (service.status().phase !== phase && Date.now() - started < timeout) await wait(25);
  return service.status().phase;
}

describe('DebugService', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('проходит цикл: точки останова, останов, стек, переменные, продолжение', async () => {
    const { service } = fakeService();

    await service.setBreakpoints('/proj/app.py', [{ line: 4 }]);
    expect(service.status().phase).toBe('idle');

    const started = await service.start('/proj/app.py');
    expect(started.ok).toBe(true);

    expect(await waitPhase(service, 'stopped')).toBe('stopped');

    const frames = service.stack();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: 7, name: 'main', path: '/proj/app.py', line: 4 });

    const scopes = await service.scopes(frames[0].id);
    expect(scopes.map((scope) => scope.name)).toEqual(['Locals']);

    const variables = await service.variables(scopes[0].variablesReference);
    expect(variables.map((variable) => variable.name)).toEqual(['total', 'items']);
    expect(variables[0]).toMatchObject({ value: '3', type: 'int' });
    expect(variables[1].variablesReference).toBe(22);

    await service.resume();
    expect(await waitPhase(service, 'idle')).toBe('idle');

    service.dispose();
  });

  it('сообщает об останове событием и рассылает фазы', async () => {
    const { service, events } = fakeService();
    await service.setBreakpoints('/proj/app.py', [{ line: 4 }]);
    await service.start('/proj/app.py');
    await waitPhase(service, 'stopped');

    const stopped = events.find((event) => event.topic === 'debug:stopped');
    expect(stopped?.payload.reason).toBe('breakpoint');
    const frames = stopped?.payload.frames as Array<{ name: string }> | undefined;
    expect(frames?.[0].name).toBe('main');

    const phases = events.filter((event) => event.topic === 'debug:state').map((event) => event.payload.phase);
    expect(phases).toContain('starting');
    expect(phases).toContain('stopped');

    service.dispose();
  });

  it('без точек останова программа идёт, а пауза её останавливает', async () => {
    const { service } = fakeService();
    // Точек останова не ставим: останов прийти не должен, программа просто идёт.
    await service.start('/proj/app.py');

    // Фаза не должна застревать в «starting»: иначе в панели недоступны «Пауза» и
    // «Стоп» — кнопки включаются по фазе, а не по «программа запущена».
    expect(await waitPhase(service, 'running')).toBe('running');

    // Пауза останавливает идущую программу: threadId клиент берёт из события thread.
    // Раньше его неоткуда было взять (останова ещё не было), и пауза молча ничего
    // не делала.
    await service.pause();
    expect(await waitPhase(service, 'stopped')).toBe('stopped');

    service.dispose();
  });

  it('stop() возвращает сервис в покой', async () => {
    const { service } = fakeService();
    await service.setBreakpoints('/proj/app.py', [{ line: 4 }]);
    await service.start('/proj/app.py');
    await waitPhase(service, 'stopped');

    service.stop();
    expect(service.status().phase).toBe('idle');
    service.dispose();
  });

  it('точки останова запоминаются и подтверждаются молча, пока сессия не запущена', async () => {
    const { service } = fakeService();
    // До старта отладчика подтвердить некому: возвращаем тот же набор.
    const confirmed = await service.setBreakpoints('/proj/app.py', [{ line: 3 }, { line: 1 }, { line: 3 }]);
    expect(confirmed.map((item) => item.line)).toEqual([1, 3]);
    service.dispose();
  });

  it('аргументы запуска доезжают до адаптера', async () => {
    const { service, events } = fakeService();
    await service.start('/proj/app.py', { args: ['--port', '8080', 'my file.txt'] });
    expect(await waitPhase(service, 'running')).toBe('running');

    // Адаптер шлёт эхо аргументов событием output — так тест видит, что они дошли
    // в поле `args` запроса launch, а не потерялись по дороге.
    const echo = events.find(
      (event) => event.topic === 'debug:output' && String(event.payload.text).startsWith('launch-args:'),
    );
    expect(echo?.payload.text).toBe('launch-args:["--port","8080","my file.txt"]');
    service.dispose();
  });

  it('переменные окружения запуска доезжают до адаптера', async () => {
    const { service, events } = fakeService();
    await service.start('/proj/app.py', { env: { LOG_LEVEL: 'debug', API_URL: 'http://localhost:8000' } });
    expect(await waitPhase(service, 'running')).toBe('running');

    const echo = events.find(
      (event) => event.topic === 'debug:output' && String(event.payload.text).startsWith('launch-env:'),
    );
    expect(echo?.payload.text).toBe('launch-env:{"LOG_LEVEL":"debug","API_URL":"http://localhost:8000"}');
    service.dispose();
  });

  it('пустые параметры не уходят в запрос launch', async () => {
    const { service, events } = fakeService();
    // Пустые args/env — это «настройки нет»: в запросе их быть не должно.
    await service.start('/proj/app.py', { args: [], env: {} });
    expect(await waitPhase(service, 'running')).toBe('running');

    const argsEcho = events.find(
      (event) => event.topic === 'debug:output' && String(event.payload.text).startsWith('launch-args:'),
    );
    const envEcho = events.find(
      (event) => event.topic === 'debug:output' && String(event.payload.text).startsWith('launch-env:'),
    );
    expect(argsEcho?.payload.text).toBe('launch-args:null');
    expect(envEcho?.payload.text).toBe('launch-env:null');
    service.dispose();
  });

  it('условие точки сохраняется и переживает ответ отладчика', async () => {
    const { service } = fakeService();
    // Условие задаём до старта: подтвердить некому, но и потерять его нельзя.
    const confirmed = await service.setBreakpoints('/proj/app.py', [
      { line: 2 },
      { line: 4, condition: 'n > 100' },
    ]);
    const conditional = confirmed.find((item) => item.line === 4);
    expect(conditional?.condition).toBe('n > 100');
    // У безусловной точки поля нет: пустая строка не должна выглядеть условием.
    expect(confirmed.find((item) => item.line === 2)?.condition).toBeUndefined();

    // Запускаем: адаптер отвечает по своим точкам, а условие остаётся нашим —
    // в ответе DAP его нет, и без восстановления оно бы потерялось.
    await service.start('/proj/app.py');
    await waitPhase(service, 'stopped');
    const runtime = await service.setBreakpoints('/proj/app.py', [{ line: 4, condition: 'n > 100' }]);
    expect(runtime[0]?.condition).toBe('n > 100');
    expect(runtime[0]?.verified).toBe(true);

    service.dispose();
  });

  it('пустое условие и лишние пробелы не создают условие', async () => {
    const { service } = fakeService();
    const confirmed = await service.setBreakpoints('/proj/app.py', [
      { line: 1, condition: '   ' },
      { line: 2, condition: '  x > 1  ' },
    ]);
    expect(confirmed.find((item) => item.line === 1)?.condition).toBeUndefined();
    expect(confirmed.find((item) => item.line === 2)?.condition).toBe('x > 1');
    service.dispose();
  });

  it('точка в журнал и счётчик попаданий сохраняются вместе с условием', async () => {
    const { service } = fakeService();
    const confirmed = await service.setBreakpoints('/proj/app.py', [
      { line: 1, logMessage: 'n = {n}' },
      { line: 2, hitCondition: '5' },
      { line: 3, condition: 'n > 1', logMessage: 'нашли {n}' },
    ]);

    // Сообщение не обрезаем по краям: пробелы могут быть частью формата.
    expect(confirmed.find((item) => item.line === 1)?.logMessage).toBe('n = {n}');
    expect(confirmed.find((item) => item.line === 2)?.hitCondition).toBe('5');
    const both = confirmed.find((item) => item.line === 3);
    expect(both?.condition).toBe('n > 1');
    expect(both?.logMessage).toBe('нашли {n}');
    service.dispose();
  });

  it('точка без настроек не несёт пустых полей', async () => {
    const { service } = fakeService();
    const [first] = await service.setBreakpoints('/proj/app.py', [{ line: 1, condition: '', logMessage: '', hitCondition: '  ' }]);
    // Пустое — это «настройки нет», а не «пустая настройка»: поле не должно появиться.
    expect(first).toEqual({ line: 1, verified: false });
    service.dispose();
  });

  describe('evaluate', () => {
    it('считает выражение в контексте кадра', async () => {
      const { service } = fakeService();
      await service.setBreakpoints('/proj/app.py', [{ line: 4 }]);
      await service.start('/proj/app.py');
      await waitPhase(service, 'stopped');

      const result = await service.evaluate('total * 2', service.stack()[0]!.id);
      expect(result).toMatchObject({ name: 'total * 2', value: '42', type: 'int' });
      service.dispose();
    });

    it('ошибку выражения отдаёт текстом, а не сбоем', async () => {
      const { service } = fakeService();
      await service.setBreakpoints('/proj/app.py', [{ line: 4 }]);
      await service.start('/proj/app.py');
      await waitPhase(service, 'stopped');

      // Причина важна целиком: по ней человек понимает, что опечатался.
      const result = await service.evaluate('bad_name');
      expect(result.value).toContain('NameError');
      service.dispose();
    });

    it('пустое выражение не уходит отладчику', async () => {
      const { service } = fakeService();
      const result = await service.evaluate('   ');
      expect(result.value).toBe('');
      service.dispose();
    });

    it('без останова объясняет, что программы нет', async () => {
      const { service } = fakeService();
      const result = await service.evaluate('total');
      expect(result.value).toContain('нет остановленной программы');
      service.dispose();
    });
  });

  describe('hover', () => {
    it('возвращает значение выражения в кадре', async () => {
      const { service } = fakeService();
      await service.setBreakpoints('/proj/app.py', [{ line: 4 }]);
      await service.start('/proj/app.py');
      await waitPhase(service, 'stopped');

      const result = await service.hover('total');
      expect(result).toMatchObject({ name: 'total', value: '42', type: 'int' });
      service.dispose();
    });

    it('ошибку выражения прячет: подсказка не должна ругаться', async () => {
      const { service } = fakeService();
      await service.setBreakpoints('/proj/app.py', [{ line: 4 }]);
      await service.start('/proj/app.py');
      await waitPhase(service, 'stopped');

      // Навести мышь можно на что угодно; «name 'bad' is not defined» в подсказке —
      // шум, поэтому ошибка превращается в отсутствие значения.
      expect(await service.hover('bad_name')).toBeNull();
      service.dispose();
    });

    it('без останова значения нет', async () => {
      const { service } = fakeService();
      expect(await service.hover('total')).toBeNull();
      service.dispose();
    });

    it('пустое выражение не уходит отладчику', async () => {
      const { service } = fakeService();
      expect(await service.hover('   ')).toBeNull();
      service.dispose();
    });
  });

  describe('setVariable', () => {
    it('возвращает значение от отладчика, а не введённое', async () => {
      const { service } = fakeService();
      await service.setBreakpoints('/proj/app.py', [{ line: 4 }]);
      await service.start('/proj/app.py');
      await waitPhase(service, 'stopped');

      const result = await service.setVariable(21, 'total', '7');
      // Адаптер добавил `!`: значит взяли его ответ, а не то, что ввели.
      expect(result).toMatchObject({ name: 'total', value: '7!', type: 'int' });
      service.dispose();
    });

    it('без сессии присвоить нельзя', async () => {
      const { service } = fakeService();
      expect(await service.setVariable(21, 'total', '7')).toBeNull();
      service.dispose();
    });

    it('пустое имя отладчику не шлём', async () => {
      const { service } = fakeService();
      expect(await service.setVariable(21, '   ', '7')).toBeNull();
      service.dispose();
    });
  });

  describe('setExpression', () => {
    it('задаёт значение выражению и берёт ответ отладчика', async () => {
      const { service } = fakeService();
      await service.setBreakpoints('/proj/app.py', [{ line: 4 }]);
      await service.start('/proj/app.py');
      await waitPhase(service, 'stopped');

      const result = await service.setExpression('items[0]', '9');
      expect(result).toMatchObject({ name: 'items[0]', value: '9!', type: 'int' });
      service.dispose();
    });

    it('без останова присвоить нельзя', async () => {
      const { service } = fakeService();
      expect(await service.setExpression('items[0]', '9')).toBeNull();
      service.dispose();
    });

    it('пустое выражение отладчику не шлём', async () => {
      const { service } = fakeService();
      expect(await service.setExpression('   ', '9')).toBeNull();
      service.dispose();
    });
  });
});
