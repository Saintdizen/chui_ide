import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LspService } from '../src/main/lsp/lsp';
import type { LspDiagnostic } from '../src/shared/api';

/**
 * Пометки проекта должны появиться САМИ, без открытия файлов человеком.
 *
 * Грабля: сервер публикует `publishDiagnostics` только для открытых документов, а
 * обход символов на тёплом кэше файлов ему не показывает — счётчик ошибок оставался
 * пустым до первого открытого файла. Теперь после обхода идёт `sweepDiagnostics`:
 * файл открывается, ждёт ответа сервера и только потом закрывается.
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
  services.push(lsp);
  return lsp;
}

/**
 * Заглушка сервера: на `didOpen` публикует одну ошибку и — важно — с задержкой:
 * именно поэтому мгновенный `didClose` успевал выбросить пометки.
 */
const FAKE_SERVER = [
  'let buffer = Buffer.alloc(0);',
  'function send(message) {',
  '  const body = JSON.stringify(message);',
  "  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);",
  '}',
  'function handle(message) {',
  "  if (message.method === 'initialize') {",
  "    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { documentSymbolProvider: true } } });",
  '    return;',
  '  }',
  "  if (message.method !== 'textDocument/didOpen') {",
  "    if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: null });",
  '    return;',
  '  }',
  '  const uri = message.params.textDocument.uri;',
  '  setTimeout(() => {',
  '    send({',
  "      jsonrpc: '2.0',",
  "      method: 'textDocument/publishDiagnostics',",
  '      params: {',
  '        uri,',
  '        diagnostics: [',
  '          {',
  '            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },',
  '            severity: 1,',
  "            code: 'fake',",
  "            message: 'нарочно',",
  '          },',
  '        ],',
  '      },',
  '    });',
  '  }, 120);',
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

async function project(): Promise<{ root: string; file: string; server: FakeServer }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lsp-sweep-'));
  dirs.push(root);
  const script = path.join(root, 'fake-lsp.cjs');
  await fs.writeFile(script, FAKE_SERVER, 'utf8');
  const file = path.join(root, 'sample.ts');
  await fs.writeFile(file, 'const value = 1;\n', 'utf8');
  return {
    root,
    file,
    server: {
      language: 'typescript',
      command: process.execPath,
      args: [script],
      enabled: true,
      label: 'заглушка',
    },
  };
}

/** Ждём, пока условие сбудется: подъём сервера и обход идут в фоне. */
async function until(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались пометок');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('пометки проекта приходят после обхода, без открытых файлов', () => {
  it('обход открывает файл, дожидается пометок и отдаёт их в приёмник', async () => {
    const { root, file, server } = await project();
    const lsp = service(root, server);
    const got = new Map<string, LspDiagnostic[]>();
    lsp.collectDiagnostics((target, diagnostics) => got.set(target, diagnostics));

    await lsp.prewarm(['typescript']);
    await until(() => got.has(file));

    // Ошибка сервера доехала — значит, файл держали открытым до ответа.
    expect(got.get(file)?.[0]).toMatchObject({ severity: 'error', message: 'нарочно' });
  });

  it('без приёмника обход не вредит: просто тишина', async () => {
    const { root, server } = await project();
    const lsp = service(root, server);

    await expect(lsp.prewarm(['typescript'])).resolves.toBeUndefined();
  });
});
