import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LspService } from '../src/main/lsp/lsp';

/**
 * Мультикорень (TASKS п.85): один язык в двух проектах не должен делить процесс.
 * Фейковый сервер пишет в лог `метод + cwd`: по cwd видно, какой корень ответил.
 * Иначе сервер второго проекта видит чужой tsconfig и подсказывает чужое.
 */
const services: LspService[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const FAKE_SERVER = [
  "const { appendFileSync } = require('node:fs');",
  'const LOG = process.argv[2];',
  'let buffer = Buffer.alloc(0);',
  'function send(message) {',
  '  const body = JSON.stringify(message);',
  "  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);",
  '}',
  'function handle(message) {',
  "  if (message.method === 'initialize') {",
  "    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { textDocumentSync: { openClose: true, change: 1 }, hoverProvider: true } } });",
  '    return;',
  '  }',
  '  if (message.method) {',
  "    appendFileSync(LOG, message.method + ' @ ' + process.cwd() + '\\n');",
  "    if (message.method === 'textDocument/hover') {",
  "      return send({ jsonrpc: '2.0', id: message.id, result: { contents: { kind: 'plaintext', value: process.cwd() } } });",
  '    }',
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
  '    try { handle(JSON.parse(body)); } catch {}',
  '  }',
  '});',
  '',
].join('\n');

async function until(check: () => Promise<boolean>, timeout = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timeout');
}

describe('мультикорень: свой сервер на корень', () => {
  it('файлы двух корней обслуживают отдельные процессы, ответы не смешиваются', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-multi-root-')));
    dirs.push(base);
    const rootA = path.join(base, 'a');
    const rootB = path.join(base, 'b');
    await fs.mkdir(rootA, { recursive: true });
    await fs.mkdir(rootB, { recursive: true });
    const fileA = path.join(rootA, 'x.ts');
    const fileB = path.join(rootB, 'y.ts');
    await fs.writeFile(fileA, 'const a = 1;\n', 'utf8');
    await fs.writeFile(fileB, 'const b = 2;\n', 'utf8');

    const script = path.join(base, 'fake-lsp.cjs');
    await fs.writeFile(script, FAKE_SERVER, 'utf8');
    const log = path.join(base, 'calls.log');
    await fs.writeFile(log, '', 'utf8');

    const server = {
      language: 'typescript',
      command: process.execPath,
      args: [script, log],
      enabled: true,
      label: 'fake',
    };

    const lsp = new LspService(
      () => rootA,
      () => ({ enabled: true, servers: [server] }) as never,
      () => {},
      () => null,
      async () => ({}),
      async () => [],
      () => null,
      undefined as never,
      () => [rootA, rootB],
    );
    services.push(lsp);

    // Открываем файлы обоих корней: должны подняться ДВА процесса.
    await lsp.prewarm(['typescript']);
    lsp.open(fileA, 'typescript', 'const a = 1;\n');
    lsp.open(fileB, 'typescript', 'const b = 2;\n');
    await until(async () =>
      (await fs.readFile(log, 'utf8')).split('\n').some((l) => l.includes('didOpen') && l.endsWith(rootB)),
    );

    const hovers = await Promise.all([
      lsp.request(fileA, 'textDocument/hover', {}),
      lsp.request(fileB, 'textDocument/hover', {}),
    ]);

    // Ответ A — из сервера корня A (его cwd), ответ B — из сервера корня B.
    expect((hovers[0] as { contents: { value: string } }).contents.value).toBe(rootA);
    expect((hovers[1] as { contents: { value: string } }).contents.value).toBe(rootB);

    // В журнале — два разных cwd: процессы не один.
    const lines = (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean);
    const roots = new Set(lines.map((line) => line.slice(line.indexOf('@ ') + 2)));
    expect(roots.has(rootA)).toBe(true);
    expect(roots.has(rootB)).toBe(true);
  });

  it('потолок экземпляров', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-cap-')));
    dirs.push(base);
    const roots = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const d = path.join(base, `r${i}`);
        await fs.mkdir(d, { recursive: true });
        return d;
      }),
    );
    const script = path.join(base, 'fake-lsp.cjs');
    await fs.writeFile(script, FAKE_SERVER, 'utf8');
    const log = path.join(base, 'calls.log');
    await fs.writeFile(log, '', 'utf8');
    const server = { language: 'typescript', command: process.execPath, args: [script, log], enabled: true };
    const lsp = new LspService(
      () => roots[0] ?? null,
      () => ({ enabled: true, servers: [server] }) as never,
      () => {},
      () => null,
      async () => ({}),
      async () => [],
      () => null,
      undefined as never,
      () => roots,
    );
    services.push(lsp);
    await lsp.prewarm(['typescript']);
    expect(lsp.status().running.length).toBeLessThanOrEqual(8);
  });
});
