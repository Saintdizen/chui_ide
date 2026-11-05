import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LspService } from '../src/main/lsp/lsp';

/**
 * Дополнительные корни сервера (`lsp.servers[].extraFolders`).
 *
 * В монорепе сервер часто один на весь репозиторий, а импорты разрешать должен
 * и в пакетах, куда сам он не смотрит. По протоколу это говорят один раз, в
 * `initialize` → `workspaceFolders`: потом сервер их уже не переспросит.
 * Поэтому провал тут — молчаливые «не найдено» на переходах внутри пакета.
 */

const dirs: string[] = [];
const services: LspService[] = [];

afterEach(async () => {
  for (const instance of services.splice(0)) instance.dispose();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Сохраняет корни из `initialize` в файл-маркер и отвечает на запрос. */
const RECORDING_SERVER = [
  "const fs = require('node:fs');",
  'let buffer = Buffer.alloc(0);',
  'function send(message) {',
  '  const body = JSON.stringify(message);',
  "  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);",
  '}',
  'function handle(message) {',
  "  if (message.method === 'initialize') {",
  '    fs.writeFileSync(process.argv[2], JSON.stringify(message.params.workspaceFolders ?? null));',
  "    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });",
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

async function waitForFile(file: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return null;
}

describe('extraFolders сервера', () => {
  it('корень проекта и существующие доп. папки уходят в initialize', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lsp-folders-'));
    dirs.push(root);
    const script = path.join(root, 'record-lsp.cjs');
    const marker = path.join(root, 'folders.json');
    await fs.writeFile(script, RECORDING_SERVER, 'utf8');
    await fs.mkdir(path.join(root, 'packages', 'api'), { recursive: true });
    const file = path.join(root, 'main.py');
    await fs.writeFile(file, 'x = 1\n', 'utf8');

    const lsp = new LspService(
      () => root,
      () =>
        ({
          enabled: true,
          servers: [
            {
              language: 'python',
              command: process.execPath,
              args: [script, marker],
              enabled: true,
              label: 'записывающий',
              // Одна папка есть, другой нет: пропавшая настройку не роняет.
              extraFolders: ['packages/api', 'нет-такой-папки'],
            },
          ],
        }) as never,
      () => {},
      () => null,
      async () => ({}),
      async () => [],
      () => null,
    );
    services.push(lsp);

    await lsp.open(file, 'python', 'x = 1\n');
    const recorded = await waitForFile(marker, 5_000);
    expect(recorded).not.toBeNull();
    const folders = JSON.parse(recorded!) as { uri: string; name: string }[];
    expect(folders.map((folder) => folder.uri)).toEqual([
      pathToFileURL(root).toString(),
      pathToFileURL(path.join(root, 'packages', 'api')).toString(),
    ]);
    expect(folders.map((folder) => folder.name)).toEqual([path.basename(root), 'api']);
  }, 15_000);
});
