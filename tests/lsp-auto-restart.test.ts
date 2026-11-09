import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LspService } from '../src/main/lsp/lsp';

/**
 * Упавший сервер поднимается сам.
 *
 * Раньше сервер, умерший посреди работы, молча ложился в `failed`, и подсказки
 * пропадали до следующего файла или ручного перезапуска. Теперь `forget`
 * планирует перезапуск с нарастающей паузой (1с, 2с, 4с). Проверяем, что после
 * падения сервер действительно стартует второй раз.
 */

const dirs: string[] = [];
const services: LspService[] = [];

afterEach(async () => {
  for (const instance of services.splice(0)) instance.dispose();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/**
 * Отвечает на `initialize`, открывает документ — и через 100мс выходит сам.
 * Каждый старт дописывает строку в файл-маркер, чтобы посчитать запуски.
 */
const CRASHING_SERVER = [
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
  "  if (message.method === 'textDocument/didOpen') {",
  '    // Проработал мгновение и упал — как настоящий крах.',
  '    setTimeout(() => process.exit(1), 100);',
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lsp-restart-'));
  dirs.push(root);
  const script = path.join(root, 'crash-lsp.cjs');
  const marker = path.join(root, 'starts.log');
  await fs.writeFile(script, CRASHING_SERVER, 'utf8');
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

describe('упавший сервер поднимается сам', () => {
  it('после падения сервер стартует повторно', async () => {
    const { root, file, script, marker } = await project();
    const lsp = new LspService(
      () => root,
      () =>
        ({
          enabled: true,
          servers: [
            { language: 'python', command: process.execPath, args: [script, marker], enabled: true, label: 'падучий' },
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

    await lsp.open(file, 'python', 'x = 1\n');
    // Первый старт случился, сервер через 100мс падает.
    expect(await waitFor(async () => (await startCount(marker)) >= 1, 3_000)).toBe(true);
    // Пауза первого перезапуска — 1с; ждём с запасом, что сервер поднимут снова.
    expect(await waitFor(async () => (await startCount(marker)) >= 2, 6_000)).toBe(true);
  }, 15_000);
});
