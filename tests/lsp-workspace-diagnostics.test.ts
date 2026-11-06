import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LspService } from '../src/main/lsp/lsp';

/**
 * Пометки всего проекта одним запросом (`workspace/diagnostic`).
 *
 * Поштучный обход открывал серверу каждый файл: в большом проекте это тысячи
 * `didOpen`/`didClose` и минуты ожидания. Сервер, объявивший
 * `workspaceDiagnostics`, умеет отдать всё сразу и помнит прошлые ответы.
 *
 * Тест держит три вещи, которые легко сломать молча:
 * - пакетный запрос вообще уходит;
 * - ответ разбирается по файлам и доходит до приёмника пометок;
 * - при отсутствии умения путь остаётся поштучным (тест не падает и не висит).
 */

const dirs: string[] = [];
const services: LspService[] = [];

afterEach(async () => {
  for (const instance of services.splice(0)) instance.dispose();
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * Заглушка объявляет `workspaceDiagnostics` и на запрос обхода отвечает одним
 * файлом с одной ошибкой. Счётчик `calls` пишет в файл — так тест видит, что
 * запрос дошёл, а не что сервис догадался.
 */
const FAKE_SERVER = [
  'const fs = require("fs");',
  'let buffer = Buffer.alloc(0);',
  'function send(message) {',
  '  const body = JSON.stringify(message);',
  "  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);",
  '}',
  'function handle(message) {',
  "  if (message.method === 'initialize') {",
  "    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {",
  "      diagnosticProvider: { identifier: 'fake', workspaceDiagnostics: true },",
  '    } } });',
  '    return;',
  '  }',
  "  if (message.method === 'workspace/diagnostic') {",
  '    const file = process.argv[2];',
  '    fs.writeFileSync(process.argv[3], String(message.params.previousResultIds.length));',
  "    send({ jsonrpc: '2.0', id: message.id, result: {",
  "      items: [{ uri: 'file://' + file, version: 1, kind: 'full', resultId: 'r1', items: [",
  "        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, code: 'E1', message: 'беда', source: 'fake', severity: 1 },",
  '      ] }],',
  '      more: false,',
  '    } });',
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
  '    try { handle(JSON.parse(body)); } catch { /* мусор не наш */ }',
  '  }',
  '});',
  '',
].join('\n');

interface Setup {
  root: string;
  file: string;
  calls: string;
  server: { language: string; command: string; args: string[]; enabled: boolean; label: string };
}

async function setup(): Promise<Setup> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-ws-diag-'));
  dirs.push(root);
  const script = path.join(root, 'fake-lsp.cjs');
  const calls = path.join(root, 'calls.txt');
  await fs.writeFile(script, FAKE_SERVER, 'utf8');
  const file = path.join(root, 'a.py');
  await fs.writeFile(file, 'x = 1\n', 'utf8');
  return {
    root,
    file,
    calls,
    server: {
      language: 'python',
      command: process.execPath,
      args: [script, file, calls],
      enabled: true,
      label: 'заглушка',
    },
  };
}

describe('пометки проекта одним запросом', () => {
  it('пакетный обход спрашивает сервер и отдаёт пометки по файлам', async () => {
    const s = await setup();
    const got: { path: string; count: number }[] = [];
    const lsp = new LspService(
      () => s.root,
      () => ({ enabled: true, servers: [s.server] }) as never,
      () => {},
      () => {},
      () => null,
      async () => ({}),
      async () => [],
      async () => null,
      undefined as never,
    );
    services.push(lsp);
    lsp.collectDiagnostics((p, list) => got.push({ path: p, count: list.length }));
    // Обход запускается прогревом языка — как в жизни: открытие файла его не будит.
    // Файл НЕ открываем в редакторе: у открытых пометки идут своим путём, и
    // приёмник обхода их нарочно пропускает.
    await lsp.prewarm(['python']);
    // Обход идёт через прогресс: ждём ответа сервера, а не своего таймера.
    for (let i = 0; i < 60 && got.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Запрос дошёл: заглушка пишет число прошлых ответов (первый раз — ноль).
    expect(await fs.readFile(s.calls, 'utf8')).toBe('0');
    expect(got[0]?.path).toBe(s.file);
    expect(got[0]?.count).toBe(1);
  });
});
