import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LspService } from '../src/main/lsp/lsp';

/**
 * Два поведения, которых у клиента не было вовсе.
 *
 * 1. Сервер сам говорит «пересчитай» (`workspace/diagnostic/refresh` и родня).
 *    Это уведомление, а не запрос: без его разбора пометки живут устаревшими
 *    до сохранения файла, хотя сервер знает, что правка в другом файле
 *    изменила вывод в этом.
 *
 * 2. Форматирование по набранному знаку (`textDocument/onTypeFormatting`).
 *    Сервер объявляет свои знаки-триггеры; запрос на прочий знак он отверг бы
 *    как ошибку, поэтому клиент обязан сперва сверить знак со списком.
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

/**
 * Заглушка умеет три вещи: отвечает на `initialize`, по команде шлёт уведомление
 * `workspace/diagnostic/refresh` и отвечает на `onTypeFormatting` правкой отступа.
 */
const FAKE_SERVER = [
  'let buffer = Buffer.alloc(0);',
  'function send(message) {',
  '  const body = JSON.stringify(message);',
  "  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);",
  '}',
  'function handle(message) {',
  "  if (message.method === 'initialize') {",
  "    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {",
  "      documentOnTypeFormattingProvider: { firstTriggerCharacter: ';', moreTriggerCharacter: ['}'] },",
  '    } } });',
  '    return;',
  '  }',
  "  if (message.method === 'refresh/please') {",
  "    send({ jsonrpc: '2.0', id: message.id, result: null });\n" +
    "    send({ jsonrpc: '2.0', method: 'workspace/diagnostic/refresh' });",
  '    return;',
  '  }',
  "  if (message.method === 'textDocument/onTypeFormatting') {",
  '    const end = { line: message.params.position.line, character: 0 };',
  "    send({ jsonrpc: '2.0', id: message.id, result: [",
  "      { range: { start: end, end }, newText: '    ' },",
  '    ] });',
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lsp-refresh-'));
  dirs.push(root);
  const script = path.join(root, 'fake-lsp.cjs');
  await fs.writeFile(script, FAKE_SERVER, 'utf8');
  const file = path.join(root, 'sample.py');
  await fs.writeFile(file, 'x = 1;\n', 'utf8');
  return {
    root,
    file,
    server: { language: 'python', command: process.execPath, args: [script], enabled: true, label: 'заглушка' },
  };
}

/** Поднять сервис и запомнить, о каких пересчётах он сообщал наружу. */
async function service(p: FakeProject): Promise<{ lsp: LspService; refreshed: string[] }> {
  const refreshed: string[] = [];
  const lsp = new LspService(
    () => p.root,
    () => ({ enabled: true, servers: [p.server] }) as never,
    () => {},
    (method) => refreshed.push(method),
    () => null,
    async () => ({}),
    async () => [],
    () => null,
    undefined as never,
  );
  services.push(lsp);
  await lsp.open(p.file, 'python', 'x = 1;\n');
  return { lsp, refreshed };
}

describe('сервер просит пересчитать', () => {
  it('уведомление пересчёта доходит до окна как есть', async () => {
    const p = await project();
    const { lsp, refreshed } = await service(p);
    // Сервер говорит о пересчёте по своей воле; команда — только чтобы он это сделал.
    await lsp.request(p.file, 'refresh/please', {});
    // Уведомление едет отдельной строкой — ждём, пока оно осядет.
    for (let i = 0; i < 40 && refreshed.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(refreshed).toEqual(['workspace/diagnostic/refresh']);
  });
});

describe('форматирование по набранному знаку', () => {
  it('знак из списка триггеров — сервер правит отступ', async () => {
    const p = await project();
    const { lsp } = await service(p);
    const edits = await lsp.formatOnType(p.file, { line: 0, character: 6 }, ';');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.newText).toBe('    ');
  });

  it('знак не из списка — запрос не уходит вовсе', async () => {
    const p = await project();
    const { lsp } = await service(p);
    // Сервер отвечает на любой `onTypeFormatting`, поэтому пустота здесь значит
    // ровно одно: клиент не спросил.
    expect(await lsp.formatOnType(p.file, { line: 0, character: 6 }, 'a')).toEqual([]);
  });

  it('файл без сервера — молча пусто, а не падение', async () => {
    const p = await project();
    const { lsp } = await service(p);
    expect(await lsp.formatOnType(path.join(p.root, 'other.ts'), { line: 0, character: 0 }, ';')).toEqual([]);
  });
});
