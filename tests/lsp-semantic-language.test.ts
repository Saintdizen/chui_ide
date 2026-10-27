import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LspService } from '../src/main/lsp/lsp';

/**
 * Семантическая подсветка не должна зависеть от того, успел ли пройти `lsp.open`.
 *
 * Грабля: `semanticTokens(path)` брал сервер через `runtimeForPath` — по карте
 * `languageOfPath`, а туда пишет ТОЛЬКО `open`. У renderer'а `open` уходит
 * `void`-запросом (`LspClient.sendOpen`), отдельным RPC, и порядок с
 * `semanticTokens` не гарантирован. Опоздал `open` — `runtimeForPath` вернул
 * `null`, и подсветка молча пропадала: не падало, не мигало, просто пусто.
 *
 * Поэтому сервер ищется по языку от вызывающего (`languageId`), а
 * `runtimeForPath` остался запасным путём — как у `outline`.
 */

const dirs: string[] = [];
const services: LspService[] = [];

afterEach(async () => {
  for (const instance of services.splice(0)) instance.dispose();
  // `dispose()` только посылает сигнал: процесс-заглушка может жить ещё миг и
  // держать открытыми файлы скрипта. На Linux удаление такого каталога проходит
  // молча, на Windows — `EBUSY`/`EPERM`. Поэтому удаляем с повторами: `fs.rm`
  // сам ждёт освобождения файлов, а не падает с первого раза.
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface FakeServer {
  language: string;
  command: string;
  args: string[];
  /** Обязателен: `serverCandidates` отбрасывает всё, у чего `enabled` не `true`. */
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
  services.push(lsp);
  return lsp;
}

/**
 * Поддельный LSP-сервер: `initialize` и один токен на запрос подсветки.
 * Запускается настоящим процессом (`process.execPath`), поэтому JSON-RPC идёт
 * через настоящие stdin/stdout — живой tsserver для этого не нужен.
 */
const FAKE_SERVER = [
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
  '          documentSymbolProvider: true,',
  '          semanticTokensProvider: {',
  '            full: true,',
  "            legend: { tokenTypes: ['keyword'], tokenModifiers: [] },",
  '          },',
  '        },',
  '      },',
  '    });',
  '    return;',
  '  }',
  "  if (message.method === 'textDocument/semanticTokens/full') {",
  '    // Один токен: строка 0, колонка 0, длина 3, тип 0 (keyword), модификаторы 0.',
  "    send({ jsonrpc: '2.0', id: message.id, result: { data: [0, 0, 3, 0, 0] } });",
  '    return;',
  '  }',
  "  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: null });",
  '}',
  "process.stdin.on('data', (chunk) => {",
  '  buffer = Buffer.concat([buffer, chunk]);',
  '  for (;;) {',
  "    const sep = buffer.indexOf('\\r\\n\\r\\n');",
  '    if (sep < 0) return;',
  '    const header = buffer.slice(0, sep).toString();',
  '    const length = Number(/Content-Length: (\\d+)/i.exec(header)?.[1] ?? 0);',
  '    if (buffer.length < sep + 4 + length) return;',
  '    const body = buffer.slice(sep + 4, sep + 4 + length).toString();',
  '    buffer = buffer.slice(sep + 4 + length);',
  '    try {',
  '      handle(JSON.parse(body));',
  '    } catch {',
  '      // мусор не наш',
  '    }',
  '  }',
  '});',
  '',
].join('\n');

interface FakeProject {
  root: string;
  file: string;
  server: FakeServer;
}

async function project(): Promise<FakeProject> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lsp-semantic-'));
  dirs.push(root);
  const script = path.join(root, 'fake-lsp.cjs');
  await fs.writeFile(script, FAKE_SERVER, 'utf8');
  const file = path.join(root, 'sample.ts');
  await fs.writeFile(file, 'const value = 1;\n', 'utf8');
  // `command` — сам `process.execPath`: `spawn` не найдёт `.cjs` в PATH,
  // а скрипт-заглушка идёт первым аргументом.
  return {
    root,
    file,
    server: { language: 'typescript', command: process.execPath, args: [script], enabled: true, label: 'заглушка' },
  };
}

describe('семантическая подсветка не зависит от порядка с `open`', () => {
  it('без `open` подсветка всё равно приходит: язык — от вызывающего', async () => {
    const { root, file, server } = await project();
    const lsp = service(root, server);
    // Нарочно НЕ зовём `lsp.open`: это и есть случай, когда `open` опоздал.
    const tokens = await lsp.semanticTokens(file, 'typescript');
    // Строки и столбцы у нас 1-based (см. `SemanticToken`), у LSP — 0-based,
    // поэтому токен (0,0,3) из заглушки разобран в (1,1..4).
    expect(tokens).toEqual([{ line: 1, startColumn: 1, endColumn: 4, type: 'keyword', modifiers: [] }]);
  });

  it('без языка и без `open` сервера не найти — пусто, но без падения', async () => {
    const { root, file, server } = await project();
    const lsp = service(root, server);
    // Запасной путь — `runtimeForPath`: карта пуста, значит сервера нет.
    // Пусто здесь — правильный ответ, а не поломка.
    expect(await lsp.semanticTokens(file)).toEqual([]);
  });

  it('после `open` подсветка тоже приходит — путь через `open` не сломан', async () => {
    const { root, file, server } = await project();
    const lsp = service(root, server);
    await lsp.open(file, 'typescript', 'const value = 1;\n');
    expect(await lsp.semanticTokens(file)).toHaveLength(1);
  });
});
