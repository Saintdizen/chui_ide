import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LspService } from '../src/main/lsp/lsp';

/**
 * Дополнение обязано находить сервер ДО того, как придёт `open`.
 *
 * Грабля (тот же корень, что у семантической подсветки): `request` брал сервер
 * через `runtimeForPath`, а тот смотрел только в карту `languageOfPath` — туда
 * пишет ТОЛЬКО `open`. Renderer шлёт `open` отдельным `void`-запросом, порядок
 * с `completion` не гарантирован. Опоздал `open` — сервера нет, `request`
 * вернул `null`, и после точки молча не появлялось подсказки.
 *
 * Вторая половина той же грабли: `open` при неудачном подъёме сервера СТИРАЛ
 * файл из `languageOfPath`/`latestText`. После этого даже повторный запрос
 * сервера не находил — файл как будто не открыт.
 */

const dirs: string[] = [];
const services: LspService[] = [];

afterEach(async () => {
  for (const instance of services.splice(0)) instance.dispose();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface FakeServer {
  language: string;
  command: string;
  args: string[];
  enabled: boolean;
  label: string;
}

function service(root: string, servers: FakeServer[]): LspService {
  const lsp = new LspService(
    () => root,
    () => ({ enabled: true, servers }) as never,
    () => {},
    () => null,
    async () => ({}),
    async () => [],
    () => null,
  );
  services.push(lsp);
  return lsp;
}

/** Заглушка: отвечает на `initialize` и на дополнение одним членом `member` (поле `label`). */
const FAKE_SERVER = [
  'let buffer = Buffer.alloc(0);',
  'function send(message) {',
  '  const body = JSON.stringify(message);',
  "  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);",
  '}',
  'function handle(message) {',
  "  if (message.method === 'initialize') {",
  "    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { completionProvider: { triggerCharacters: ['.'] } } } });",
  '    return;',
  '  }',
  "  if (message.method === 'textDocument/completion') {",
  "    send({ jsonrpc: '2.0', id: message.id, result: { isIncomplete: false, items: [{ label: 'member', kind: 2 }] } });",
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lsp-complete-'));
  dirs.push(root);
  const script = path.join(root, 'fake-lsp.cjs');
  await fs.writeFile(script, FAKE_SERVER, 'utf8');
  const file = path.join(root, 'sample.py');
  await fs.writeFile(file, 'page.\n', 'utf8');
  return {
    root,
    file,
    server: { language: 'python', command: process.execPath, args: [script], enabled: true, label: 'заглушка' },
  };
}

const AT_DOT = { line: 1, character: 5 };

function completions(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const items = (result as { items?: unknown }).items;
  const list = Array.isArray(items) ? items : Array.isArray(result) ? (result as unknown[]) : [];
  return list.map((item) => String((item as { label?: unknown }).label ?? ''));
}

describe('дополнение не обгоняет `open`', () => {
  it('запрос сразу после `open` дожидается его: иначе сервер документа не знает', async () => {
    const { root, file, server } = await project();
    const lsp = service(root, [server]);
    // Как в редакторе: `lsp.open` уходит без ожидания, а дополнение — сразу за ним.
    // Раньше запрос уходил вперёд `didOpen`, и сервер отвечал по неоткрытому
    // документу — пустота без единой ошибки.
    void lsp.open(file, 'python', 'page.\n');
    const result = await lsp.request(file, 'textDocument/completion', {
      textDocument: { uri: `file://${file}` },
      position: { line: AT_DOT.line - 1, character: AT_DOT.character - 1 },
    });
    expect(completions(result)).toEqual(['member']);
  });

  it('после `open` дополнение тоже приходит — путь через `open` не сломан', async () => {
    const { root, file, server } = await project();
    const lsp = service(root, [server]);
    await lsp.open(file, 'python', 'page.\n');
    const result = await lsp.request(file, 'textDocument/completion', {
      textDocument: { uri: `file://${file}` },
      position: { line: AT_DOT.line - 1, character: AT_DOT.character - 1 },
    });
    expect(completions(result)).toEqual(['member']);
  });

  it('неудачный подъём не забывает файл: после него сервер всё равно находится', async () => {
    const { root, file, server } = await project();
    const broken: FakeServer = { ...server, command: path.join(root, 'no-such-binary') };
    const lsp = service(root, [broken]);
    // Подъём провалится — раньше здесь файл вычищался из карты целиком.
    await lsp.open(file, 'python', 'page.\n');
    // Язык всё ещё известен (и по карте, и по расширению), поэтому запрос
    // доходит до поиска сервера, а не обрывается на пустой карте.
    expect(lsp.languageFor(file)).toBe('python');
  });
});
