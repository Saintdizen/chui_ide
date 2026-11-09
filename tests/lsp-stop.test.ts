import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LspService } from '../src/main/lsp/lsp';

/**
 * Остановка серверов по кнопке.
 *
 * Stop нужен, когда сервер мешает, но не сломан: занял ядро, спорит за индекс с
 * другим клиентом. Это не выключатель: следующий файл своего языка поднимает
 * сервер снова. Сторожим оба обещания — после stop в `running` пусто, а новый
 * файл поднимает сервер второй раз (счётчик стартов в файле-маркере).
 */

const dirs: string[] = [];
const services: LspService[] = [];

afterEach(async () => {
  for (const instance of services.splice(0)) instance.dispose();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Минимальный живой сервер: отвечает на `initialize`, на остальное — молчит. */
const QUIET_SERVER = [
  "const fs = require('node:fs');",
  "fs.appendFileSync(process.argv[2], 'start\\n');",
  'let buffer = Buffer.alloc(0);',
  'function send(message) {',
  '  const body = JSON.stringify(message);',
  "  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);",
  '}',
  'function handle(message) {',
  "  if (message.method === 'initialize') {",
  "    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { completionProvider: {} } } });",
  '  }',
  "  if (message.method === 'shutdown') {",
  "    send({ jsonrpc: '2.0', id: message.id, result: null });",
  '  }',
  "  if (message.method === 'exit') {",
  '    process.exit(0);',
  '  }',
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
  '    try { handle(JSON.parse(body)); } catch {}',
  '  }',
  '});',
  '',
].join('\n');

async function project(): Promise<{ root: string; file: string; script: string; marker: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lsp-stop-'));
  dirs.push(root);
  const script = path.join(root, 'quiet-lsp.cjs');
  const marker = path.join(root, 'starts.log');
  await fs.writeFile(script, QUIET_SERVER, 'utf8');
  const file = path.join(root, 'sample.py');
  await fs.writeFile(file, 'x = 1\n', 'utf8');
  return { root, file, script, marker };
}

async function startCount(marker: string): Promise<number> {
  try {
    const text = await fs.readFile(marker, 'utf8');
    return text.split('\n').filter((line) => line === 'start').length;
  } catch {
    return 0;
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function serviceWith(root: string, script: string, marker: string): LspService {
  const lsp = new LspService(
    () => root,
    () =>
      ({
        enabled: true,
        servers: [
          { language: 'python', command: process.execPath, args: [script, marker], enabled: true, label: 'тихий' },
        ],
      }) as never,
    () => {},
    () => {},
    () => null,
    async () => ({}),
    async () => [],
    () => null,
  );
  services.push(lsp);
  return lsp;
}

describe('остановка языковых серверов', () => {
  it('stopAll гасит серверы, новый файл поднимает снова', async () => {
    const { root, file, script, marker } = await project();
    const lsp = serviceWith(root, script, marker);

    await lsp.open(file, 'python', 'x = 1\n');
    expect(await waitFor(async () => lsp.status().running.includes('python'), 5_000)).toBe(true);
    expect(await startCount(marker)).toBe(1);

    const stopped = lsp.stopAll();
    expect(stopped.running).toEqual([]);

    await lsp.open(path.join(root, 'second.py'), 'python', 'y = 2\n');
    expect(await waitFor(async () => (await startCount(marker)) >= 2, 5_000)).toBe(true);
    expect(await waitFor(async () => lsp.status().running.includes('python'), 5_000)).toBe(true);
  }, 15_000);
});
