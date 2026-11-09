import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LspService } from '../src/main/lsp/lsp';

/**
 * Зависший сервер не держит редактор: запрос обязан отвалиться по таймауту.
 *
 * Раньше главный путь `request` не имел сторожа вовсе — только два вызова были
 * обёрнуты `withTimeout`. Сервер, который принял запрос и замолчал, оставлял
 * `await` висеть навсегда: подсказка не появлялась и не пропадала.
 */

const dirs: string[] = [];
const services: LspService[] = [];

afterEach(async () => {
  for (const instance of services.splice(0)) instance.dispose();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Отвечает на `initialize`, но на всё прочее МОЛЧИТ — как зависший сервер. */
const DEAF_SERVER = [
  'let buffer = Buffer.alloc(0);',
  'function send(message) {',
  '  const body = JSON.stringify(message);',
  "  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);",
  '}',
  'function handle(message) {',
  "  if (message.method === 'initialize') {",
  "    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { completionProvider: {} } } });",
  '  }',
  '  // На все остальные запросы — тишина.',
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

async function project(): Promise<{ root: string; file: string; script: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lsp-timeout-'));
  dirs.push(root);
  const script = path.join(root, 'deaf-lsp.cjs');
  await fs.writeFile(script, DEAF_SERVER, 'utf8');
  const file = path.join(root, 'sample.py');
  await fs.writeFile(file, 'x = 1\n', 'utf8');
  return { root, file, script };
}

describe('зависший сервер не держит запрос', () => {
  it('запрос отваливается по таймауту, а не висит вечно', async () => {
    const { root, file, script } = await project();
    const lsp = new LspService(
      () => root,
      () =>
        ({
          enabled: true,
          requestTimeoutMs: 150,
          servers: [{ language: 'python', command: process.execPath, args: [script], enabled: true, label: 'глухой' }],
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

    const started = Date.now();
    // `request` в LspService глушит ошибку в `null` — важно, что он ВОЗВРАЩАЕТСЯ.
    const result = await lsp.request(file, 'textDocument/completion', {
      textDocument: { uri: `file://${file}` },
      position: { line: 0, character: 0 },
    });
    const elapsed = Date.now() - started;

    expect(result).toBeNull();
    // Гораздо раньше 30-секундного дефолта и без бесконечного висения.
    expect(elapsed).toBeLessThan(5_000);
  });
});
