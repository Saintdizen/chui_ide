import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LspService } from '../src/main/lsp/lsp';

/**
 * Диагностика по запросу (`textDocument/diagnostic`).
 *
 * `publishDiagnostics` серверы шлют сами и только про открытые документы: файл,
 * который правят редко, проверяется «когда-нибудь», а обход проекта держит файл
 * открытым и ждёт публикации. Сервер с `diagnosticProvider` можно просто спросить.
 */

const dirs: string[] = [];
const services: LspService[] = [];

afterEach(async () => {
  for (const instance of services.splice(0)) instance.dispose();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/**
 * Заглушка сервера: по запросу отдаёт одну пометку, а на второй запрос с
 * `previousResultId` — `unchanged`. Так видно обе ветки разбора.
 */
const FAKE_SERVER = `
let buffer = Buffer.alloc(0);
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
}
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      capabilities: { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } },
    } });
    return;
  }
  if (message.method === 'textDocument/diagnostic') {
    if (message.params.previousResultId) {
      send({ jsonrpc: '2.0', id: message.id, result: { kind: 'unchanged', resultId: message.params.previousResultId } });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, result: { kind: 'full', resultId: 'v1', items: [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      severity: 1,
      message: 'переменная не используется',
      source: 'ts',
    }] } });
    return;
  }
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: null });
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const sep = buffer.indexOf('\\r\\n\\r\\n');
    if (sep < 0) return;
    const header = buffer.slice(0, sep).toString();
    const length = Number(/Content-Length: (\\d+)/i.exec(header)?.[1] ?? 0);
    if (buffer.length < sep + 4 + length) return;
    const body = buffer.slice(sep + 4, sep + 4 + length).toString();
    buffer = buffer.slice(sep + 4 + length);
    try { handle(JSON.parse(body)); } catch {}
  }
});
`;

async function project() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lsp-pull-'));
  dirs.push(root);
  const script = path.join(root, 'fake-lsp.cjs');
  await fs.writeFile(script, FAKE_SERVER, 'utf8');
  const file = path.join(root, 'sample.ts');
  await fs.writeFile(file, 'const value = 1;\n', 'utf8');
  const lsp = new LspService(
    () => root,
    () =>
      ({
        enabled: true,
        servers: [
          { language: 'typescript', command: process.execPath, args: [script], enabled: true, label: 'заглушка' },
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
  return { root, file, lsp };
}

describe('диагностика по запросу', () => {
  it('сервер с diagnosticProvider отвечает о файле, которого не открывали', async () => {
    const { file, lsp } = await project();
    // Ни `open`, ни `didOpen` — как и обход проекта: спросили и получили.
    // `prewarm` тут потому, что сервер стартует по использованному языку.
    await lsp.prewarm(['typescript']);
    const diagnostics = await lsp.diagnosticsFor(file, 'const value = 1;\n');
    expect(diagnostics).toEqual([
      expect.objectContaining({ message: 'переменная не используется', severity: 'error' }),
    ]);
  });

  it('unchanged отдаёт прежний список, а не пусто', async () => {
    // `unchanged` значит «то же, что в прошлый раз»: стереть пометки было бы неверно.
    const { file, lsp } = await project();
    await lsp.prewarm(['typescript']);
    const first = await lsp.diagnosticsFor(file, 'const value = 1;\n');
    const second = await lsp.diagnosticsFor(file, 'const value = 1;\n');
    expect(second).toEqual(first);
    expect(second).toHaveLength(1);
  });

  it('файл без языка — null, чтобы осталась публикация', async () => {
    const { root, lsp } = await project();
    // Расширение, которого не знает ни один сервер: спрашивать некого.
    expect(await lsp.diagnosticsFor(path.join(root, 'data.unknownext'), '')).toBeNull();
  });
});
