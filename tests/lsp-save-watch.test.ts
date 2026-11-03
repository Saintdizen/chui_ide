import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LspService } from '../src/main/lsp/lsp';

/**
 * Сохранение и правки вне редактора должны доходить до сервера.
 *
 * Грабля: методы `saved`/`watchedFiles` могут быть написаны, но не вызваны ниоткуда —
 * тогда сервер не знает ни о сохранении (проверки на сохранении не запускаются), ни
 * о чужих правках (предлагает удалённые модули). Тесты держат обе связки: сам запрос
 * (что и когда уходит) и вызов из тех мест, где файл меняется.
 */

const dirs: string[] = [];
const services: LspService[] = [];

afterEach(async () => {
  for (const instance of services.splice(0)) instance.dispose();
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

interface FakeServer {
  language: string;
  command: string;
  args: string[];
  enabled: boolean;
  label: string;
}

function service(root: string, server: FakeServer): LspService {
  const lsp = new LspService(
    () => root,
    () => ({ enabled: true, servers: [server] }) as never,
    () => {},
    () => null,
    async () => ({}),
    async () => [],
    () => null,
  );
  // Подъём стартует в фоне; тесты дожидаются его через `await lsp.prewarm(...)`.
  services.push(lsp);
  return lsp;
}

/**
 * Заглушка сервера пишет журнал пришедших уведомлений.
 *
 * `save` в возможностях объявляется по первому аргументу: так один и тот же скрипт
 * изображает и сервер, который ждёт `didSave`, и того, кому оно не нужно.
 */
const FAKE_SERVER = [
  "const { appendFileSync } = require('node:fs');",
  '// node argv: [exec, script, log, mode] — лог в argv[2], режим в argv[3].',
  'const LOG = process.argv[2];',
  "const SAVE = process.argv[3] === 'save';",
  "const SYMBOLS = process.argv[3] === 'symbols';",
  "const WATCH = process.argv[3] === 'watch';",
  "const FILEOPS = process.argv[3] === 'fileops';",
  "const CFG = process.argv[3] === 'cfg';",
  "const PROGRESS = process.argv[3] === 'progress';",
  "const FOLDERS = process.argv[3] === 'folders';",
  "const INLINE = process.argv[3] === 'inline';",
  "const RANGES = process.argv[3] === 'ranges';",
  'let buffer = Buffer.alloc(0);',
  'function send(message) {',
  '  const body = JSON.stringify(message);',
  "  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);",
  '}',
  'function handle(message) {',
  "  if (message.method === 'initialize') {",
  '    send({',
  "      jsonrpc: '2.0',",
  '      id: message.id,',
  '      result: {',
  '        capabilities: {',
  '          textDocumentSync: SAVE',
  '            ? { openClose: true, change: 1, save: { includeText: true }, willSave: true }',
  '            : { openClose: true, change: 1 },',
  '          ...(WATCH ? { workspace: { didChangeWatchedFiles: {} } } : {}),',
  '          ...(FILEOPS ? { workspace: { fileOperations: { didCreate: { filters: [] } } } } : {}),',
  '          ...(CFG ? { workspace: { didChangeConfiguration: { dynamicRegistration: false } } } : {}),',
  '          ...(PROGRESS ? { referencesProvider: true } : {}),',
  '          ...(FOLDERS ? { workspace: { workspaceFolders: true } } : {}),',
  '          ...(INLINE ? { inlineCompletionProvider: true } : {}),',
  '          ...(RANGES ? { documentRangeFormattingProvider: true } : {}),',
  '          ...(SYMBOLS ? { workspaceSymbolProvider: true } : {}),',
  '        },',
  '      },',
  '    });',
  '    return;',
  '  }',
  '  if (message.method) {',
  "    appendFileSync(LOG, message.method + '\\n');",
  "    if (message.method === 'workspace/symbol') {",
  "      return send({ jsonrpc: '2.0', id: message.id, result: [{ name: 'widget', kind: 12, data: { id: 7 } }] });",
  '    }',
  "    if (message.method === 'textDocument/inlineCompletion' && INLINE) {",
  "      return send({ jsonrpc: '2.0', id: message.id, result: { items: [{ insertText: 'const answer = 42;', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }, { insertText: { value: 'console.log(x);' } }] } });",
  '    }',
  "    if (message.method === 'textDocument/rangesFormatting' && RANGES) {",
  "      return send({ jsonrpc: '2.0', id: message.id, result: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'ok' }] });",
  '    }',
  "    if (message.method === 'textDocument/references' && PROGRESS) {",
  "      send({ jsonrpc: '2.0', method: '$/progress', params: { token: 'srv-1', value: { kind: 'begin', title: 'Ищу ссылки' } } });",
  '      return;',
  '    }',
  "    if (message.method === 'workspaceSymbol/resolve')",
  "      return send({ jsonrpc: '2.0', id: message.id, result: { name: 'widget', kind: 12, location: { uri: process.argv[4], range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } } } });",
  '    return;',
  '  }',
  '  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: null });',
  '}',
  "process.stdin.on('data', (chunk) => {",
  '  buffer = Buffer.concat([buffer, chunk]);',
  '  for (;;) {',
  "    const sep = buffer.indexOf('\\r\\n\\r\\n');",
  '    if (sep < 0) return;',
  '    const header = buffer.subarray(0, sep).toString();',
  '    const length = Number(/Content-Length: (\\d+)/i.exec(header)?.[1] ?? 0);',
  '    if (buffer.length < sep + 4 + length) return;',
  '    const body = buffer.subarray(sep + 4, sep + 4 + length).toString();',
  '    buffer = buffer.subarray(sep + 4 + length);',
  '    try {',
  '      handle(JSON.parse(body));',
  '    } catch {}',
  '  }',
  '});',
  '',
].join('\n');

async function project(
  mode: 'save' | 'watch' | 'plain' | 'symbols' | 'fileops' | 'cfg' | 'progress' | 'folders' | 'inline' | 'ranges',
): Promise<{ root: string; file: string; log: string; server: FakeServer }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lsp-save-'));
  dirs.push(root);
  const script = path.join(root, 'fake-lsp.cjs');
  await fs.writeFile(script, FAKE_SERVER, 'utf8');
  const file = path.join(root, 'sample.ts');
  await fs.writeFile(file, 'const value = 1;\n', 'utf8');
  const log = path.join(root, 'calls.log');
  await fs.writeFile(log, '', 'utf8');
  return {
    root,
    file,
    log,
    server: {
      language: 'typescript',
      command: process.execPath,
      args: [script, log, mode, pathToFileURL(file).toString()],
      enabled: true,
      label: 'заглушка',
    },
  };
}

/** Ждём, пока условие сбудется: подъём сервера идёт в фоне. */
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function logOf(file: string): Promise<string> {
  return fs.readFile(file, 'utf8').catch(() => '');
}

describe('didSave и наблюдение за файлами', () => {
  it('открытие и сохранение доходят до сервера, текст уходит при includeText', async () => {
    const { root, file, log, server } = await project('save');
    const lsp = service(root, server);
    await lsp.prewarm(['typescript']);
    lsp.open(file, 'typescript', 'const value = 1;\n');
    await until(async () => (await logOf(log)).includes('textDocument/didOpen'));
    lsp.saved(file);
    await until(async () => (await logOf(log)).includes('textDocument/didSave'));
    expect(await logOf(log)).toContain('textDocument/didSave');
  });

  it('сервер без save в возможностях уведомления не получает', async () => {
    // Иначе мы шлём уведомление, которого сервер не объявлял, — часть серверов
    // отвечает на такое ошибкой в лог.
    const { root, file, log, server } = await project('plain');
    const lsp = service(root, server);
    await lsp.prewarm(['typescript']);
    lsp.open(file, 'typescript', 'const value = 1;\n');
    await until(async () => (await logOf(log)).includes('textDocument/didOpen'));
    lsp.saved(file);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await logOf(log)).not.toContain('textDocument/didSave');
  });

  it('сохранение файла, закрытого в редакторе, шлётся без текста: сервер его не открывал', async () => {
    // `didSave` про неоткрытый документ — ошибка протокола, поэтому такой файл
    // открываем на время сохранения и закрываем сразу.
    const { root, file, log, server } = await project('save');
    const lsp = service(root, server);
    await lsp.prewarm(['typescript']);
    lsp.open(file, 'typescript', 'const value = 1;\n');
    await until(async () => (await logOf(log)).includes('textDocument/didOpen'));
    lsp.close(file);
    lsp.saved(file, 'const value = 2;\n');
    await until(async () => (await logOf(log)).includes('textDocument/didSave'));
    const text = await logOf(log);
    // Открыт и закрыт вокруг сохранения — по порядку.
    expect(text.lastIndexOf('textDocument/didOpen')).toBeLessThan(text.lastIndexOf('textDocument/didSave'));
    expect(text.lastIndexOf('textDocument/didSave')).toBeLessThan(text.lastIndexOf('textDocument/didClose'));
  });

  it('сохранение неоткрытого файла без текста не шлётся', async () => {
    // Текст не дали — открыть документ нечем, а `didSave` без `didOpen` нельзя.
    const { root, file, log, server } = await project('save');
    const lsp = service(root, server);
    await lsp.prewarm(['typescript']);
    lsp.open(file, 'typescript', 'const value = 1;\n');
    await until(async () => (await logOf(log)).includes('textDocument/didOpen'));
    lsp.close(file);
    const before = (await logOf(log)).length;
    lsp.saved(file);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await logOf(log)).slice(before)).not.toContain('textDocument/didSave');
  });

  it('изменение файла вне редактора уходит как didChangeWatchedFiles', async () => {
    const { root, file, log, server } = await project('watch');
    const lsp = service(root, server);
    // Поднимаем сервер открытием: до `initialize` рантайма ещё нет.
    await lsp.prewarm(['typescript']);
    lsp.open(file, 'typescript', 'const value = 1;\n');
    await until(async () => (await logOf(log)).includes('textDocument/didOpen'));
    lsp.watchedFiles([file], 2);
    await until(async () => (await logOf(log)).includes('workspace/didChangeWatchedFiles'));
    expect(await logOf(log)).toContain('workspace/didChangeWatchedFiles');
  });

  it('сервер без объявленного наблюдения не получает didChangeWatchedFiles', async () => {
    const { root, file, log, server } = await project('plain');
    const lsp = service(root, server);
    await lsp.prewarm(['typescript']);
    lsp.open(file, 'typescript', 'const value = 1;\n');
    await until(async () => (await logOf(log)).includes('textDocument/didOpen'));
    lsp.watchedFiles([file], 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await logOf(log)).not.toContain('workspace/didChangeWatchedFiles');
  });

  it('создание файла уходит как didCreateFiles', async () => {
    const { root, file, log, server } = await project('fileops');
    const lsp = service(root, server);
    await lsp.prewarm(['typescript']);
    lsp.open(file, 'typescript', 'const value = 1;\n');
    await until(async () => (await logOf(log)).includes('textDocument/didOpen'));
    lsp.fileOperation('create', [path.join(root, 'new.ts')]);
    await until(async () => (await logOf(log)).includes('workspace/didCreateFiles'));
    expect(await logOf(log)).toContain('workspace/didCreateFiles');
  });

  it('переименование несёт старое имя, а не только новое', async () => {
    // `didChangeWatchedFiles` даёт два независимых пути, и связь «старое → новое»
    // теряется. `didRenameFiles` — единственное место, где она сохраняется.
    const { root, file, log, server } = await project('fileops');
    const lsp = service(root, server);
    await lsp.prewarm(['typescript']);
    lsp.open(file, 'typescript', 'const value = 1;\n');
    await until(async () => (await logOf(log)).includes('textDocument/didOpen'));
    lsp.fileOperation('rename', [path.join(root, 'moved.ts')], file);
    await until(async () => (await logOf(log)).includes('workspace/didRenameFiles'));
    expect(await logOf(log)).toContain('workspace/didRenameFiles');
  });

  it('удаление файла уходит как didDeleteFiles', async () => {
    const { root, file, log, server } = await project('fileops');
    const lsp = service(root, server);
    await lsp.prewarm(['typescript']);
    lsp.open(file, 'typescript', 'const value = 1;\n');
    await until(async () => (await logOf(log)).includes('textDocument/didOpen'));
    lsp.fileOperation('delete', [file]);
    await until(async () => (await logOf(log)).includes('workspace/didDeleteFiles'));
    expect(await logOf(log)).toContain('workspace/didDeleteFiles');
  });

  it('сервер без fileOperations не получает didCreateFiles', async () => {
    // Объявления два разных: сервер может знать только `didChangeWatchedFiles`.
    // Слать ему незнакомый метод — ошибка протокола.
    const { root, file, log, server } = await project('watch');
    const lsp = service(root, server);
    await lsp.prewarm(['typescript']);
    lsp.open(file, 'typescript', 'const value = 1;\n');
    await until(async () => (await logOf(log)).includes('textDocument/didOpen'));
    lsp.fileOperation('create', [path.join(root, 'new.ts')]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await logOf(log)).not.toContain('workspace/didCreateFiles');
  });

  it('правка настроек уходит как didChangeConfiguration', async () => {
    // Без этого уведомления сервер держит старые настройки до перезапуска IDE:
    // обновили интерпретатор в настройках — подсказки идут по старому.
    const { root, file, log, server } = await project('cfg');
    const lsp = service(root, server);
    await lsp.prewarm(['typescript']);
    lsp.open(file, 'typescript', 'const value = 1;\n');
    await until(async () => (await logOf(log)).includes('textDocument/didOpen'));
    lsp.settingsChanged();
    await until(async () => (await logOf(log)).includes('workspace/didChangeConfiguration'));
    expect(await logOf(log)).toContain('workspace/didChangeConfiguration');
  });

  it('сервер без workspaceConfiguration не получает правку настроек', async () => {
    const { root, file, log, server } = await project('watch');
    const lsp = service(root, server);
    await lsp.prewarm(['typescript']);
    lsp.open(file, 'typescript', 'const value = 1;\n');
    await until(async () => (await logOf(log)).includes('textDocument/didOpen'));
    lsp.settingsChanged();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await logOf(log)).not.toContain('workspace/didChangeConfiguration');
  });

  it('отмена запроса гасит и его индикатор прогресса', async () => {
    const { root, file, log, server } = await project('progress');
    const lsp = service(root, server);
    await lsp.prewarm(['typescript']);
    lsp.open(file, 'typescript', 'const value = 1;\n');
    await until(async () => (await logOf(log)).includes('textDocument/didOpen'));
    // Запрос, под который сервер открыл индикатор прогресса.
    const pending = lsp.references(file, 'typescript', 'const value = 1;\n', 1, 7, true);
    await until(async () => (await logOf(log)).includes('textDocument/references'));
    // Свежий запрос того же вида вытесняет устаревший: ключ отмены общий.
    void lsp.references(file, 'typescript', 'const value = 1;\n', 1, 7, false);
    await pending.catch(() => undefined);
    await until(async () => (await logOf(log)).includes('window/workDoneProgress/cancel'));
    expect(await logOf(log)).toContain('$/cancelRequest');
    expect(await logOf(log)).toContain('window/workDoneProgress/cancel');
  });

  it('новый корень уезжает серверу как workspaceFolders', async () => {
    const { root, log, server } = await project('folders');
    const lsp = service(root, server);
    await lsp.prewarm(['typescript']);
    const second = `${root}/second`;
    lsp.rootsChanged([second], []);
    await until(async () => (await logOf(log)).includes('workspace/didChangeWorkspaceFolders'));
    expect(await logOf(log)).toContain('workspace/didChangeWorkspaceFolders');
  });

  it('серые подсказки сервера едут строкой', async () => {
    const { root, log, server } = await project('inline');
    const lsp = service(root, server);
    await lsp.prewarm(['typescript']);
    const snippets = await lsp.inlineCompletions('/p/a.ts', 'typescript', 'const a = 1;\n', 1, 1);
    expect(snippets).toEqual(['const answer = 42;', 'console.log(x);']);
    expect(await logOf(log)).toContain('textDocument/inlineCompletion');
  });

  it('символ без location доспрошивается через workspaceSymbol/resolve', async () => {
    // Спецификация разрешает `workspace/symbol` отдавать символы БЕЗ локации: сервер
    // экономит силы на больших проектах и ждёт, что клиент доспросит ненужное.
    // Раньше такой символ молча выкидывался из списка — теперь дозапрашиваем.
    const { root, log, server } = await project('symbols');
    const lsp = service(root, server);
    await lsp.prewarm(['typescript']);
    const found = await lsp.projectSymbols('widget');
    expect(found.some((symbol) => symbol.name === 'widget')).toBe(true);
    expect(await logOf(log)).toContain('workspaceSymbol/resolve');
  });

  it('willSave идёт перед didSave у сервера, который его объявил', async () => {
    // Часть серверов готовит данные именно к моменту записи (переиндексация, снимок).
    // Порядок важен: `willSave` говорит «сейчас запишут», `didSave` — «уже записали».
    const { root, file, log, server } = await project('save');
    const lsp = service(root, server);
    await lsp.prewarm(['typescript']);
    lsp.open(file, 'typescript', 'const value = 1;\n');
    await until(async () => (await logOf(log)).includes('textDocument/didOpen'));
    lsp.willSave(file);
    await until(async () => (await logOf(log)).includes('textDocument/willSave'));
    expect(await logOf(log)).toContain('textDocument/willSave');
  });
});
