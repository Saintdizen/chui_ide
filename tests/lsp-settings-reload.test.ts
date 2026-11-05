import { LspService } from '../src/main/lsp/lsp';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
const services: { dispose(): void }[] = [];

const QUIET_SERVER = `
const fs = require('node:fs');
const marker = process.argv[2];
fs.appendFileSync(marker, 'start\\n');
let buffer = Buffer.alloc(0);
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    const header = buffer.subarray(0, end).toString('utf8');
    const length = Number(/Content-Length: (\\d+)/.exec(header)?.[1] ?? 0);
    if (buffer.length < end + 4 + length) return;
    const body = buffer.subarray(end + 4, end + 4 + length).toString('utf8');
    buffer = buffer.subarray(end + 4 + length);
    const message = JSON.parse(body);
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {}, serverInfo: { name: 'quiet' } } });
    } else if (message.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: message.id, result: null });
    } else if (message.method === 'exit') {
      process.exit(0);
    }
  }
});
setInterval(() => {}, 1000);
`;

async function project(): Promise<{ root: string; file: string; script: string; marker: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lsp-reload-'));
  dirs.push(root);
  const script = path.join(root, 'quiet-lsp.cjs');
  const marker = path.join(root, 'starts.log');
  await fs.writeFile(script, QUIET_SERVER, 'utf8');
  const file = path.join(root, 'sample.py');
  await fs.writeFile(file, 'x = 1\n', 'utf8');
  return { root, file, script, marker };
}

async function starts(marker: string): Promise<number> {
  try {
    return (await fs.readFile(marker, 'utf8')).split('\n').filter((line) => line === 'start').length;
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

function makeService(root: string, argsOf: () => string[], enabledOf: () => boolean = () => true): LspService {
  const lsp = new LspService(
    () => root,
    () =>
      ({
        enabled: true,
        servers: [
          { language: 'python', command: process.execPath, args: argsOf(), enabled: enabledOf(), label: 'тихий' },
        ],
      }) as never,
    () => {},
    () => null,
    async () => ({}),
    async () => [],
    () => null,
  );
  services.push(lsp);
  return lsp;
}

afterEach(async () => {
  for (const service of services) service.dispose();
  services.length = 0;
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe('правка настроек сервера', () => {
  it('аргументы изменились — сервер перезапускается сам', async () => {
    const { root, file, script, marker } = await project();
    let args = [script, marker];
    const lsp = makeService(root, () => args);

    await lsp.open(file, 'python', 'x = 1\n');
    expect(await waitFor(async () => (await starts(marker)) === 1, 5_000)).toBe(true);

    // Та же команда, другие аргументы: сервер держит старое окружение в памяти.
    args = [script, marker, '--extra'];
    lsp.settingsChanged();

    expect(await waitFor(async () => (await starts(marker)) >= 2, 5_000)).toBe(true);
    expect(await waitFor(async () => lsp.status().running.includes('python'), 5_000)).toBe(true);
  }, 15_000);

  it('выключенный сервер больше не поднимается', async () => {
    const { root, file, script, marker } = await project();
    let enabled = true;
    const lsp = makeService(
      root,
      () => [script, marker],
      () => enabled,
    );

    await lsp.open(file, 'python', 'x = 1\n');
    expect(await waitFor(async () => (await starts(marker)) === 1, 5_000)).toBe(true);

    enabled = false;
    lsp.settingsChanged();

    expect(await waitFor(async () => !lsp.status().running.includes('python'), 5_000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(await starts(marker)).toBe(1);
  }, 15_000);

  it('нетронутые настройки — без перезапуска', async () => {
    const { root, file, script, marker } = await project();
    const lsp = makeService(root, () => [script, marker]);

    await lsp.open(file, 'python', 'x = 1\n');
    expect(await waitFor(async () => (await starts(marker)) === 1, 5_000)).toBe(true);

    lsp.settingsChanged();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(await starts(marker)).toBe(1);
  }, 15_000);
});
