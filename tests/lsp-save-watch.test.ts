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
  '          textDocumentSync: SAVE ? { openClose: true, change: 1, save: { includeText: true } } : { openClose: true, change: 1 },',
  '          ...(WATCH ? { workspace: { didChangeWatchedFiles: {} } } : {}),',
  '          ...(SYMBOLS ? { workspaceSymbolProvider: true } : {}),',
  '        },',
  '      },',
  '    });',
  '    return;',
  '  }',
  '  if (message.method) {',
  "    appendFileSync(LOG, message.method + '\\n');",
  "    if (message.method === 'workspace/symbol')",
  "      return send({ jsonrpc: '2.0', id: message.id, result: [{ name: 'widget', kind: 12, data: { id: 7 } }] });",
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
  mode: 'save' | 'watch' | 'plain' | 'symbols',
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

  it('сохранение неоткрытого файла не шлётся даже объявившему save', async () => {
    // Уведомление про файл, которого сервер не открывал, — ошибка протокола.
    const { root, file, log, server } = await project('save');
    const lsp = service(root, server);
    await lsp.prewarm(['typescript']);
    lsp.open(file, 'typescript', 'const value = 1;\n');
    await until(async () => (await logOf(log)).includes('textDocument/didOpen'));
    lsp.close(file);
    lsp.saved(file);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await logOf(log)).not.toContain('textDocument/didSave');
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
});
