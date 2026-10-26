/**
 * Сырая проба Pyright: без нашего LspService.
 *
 * Вопрос, на который она отвечает: сломан ли Pyright сам или шов между ним и
 * `LspService`. Шов подозревается потому, что Python — единственный сервер в
 * поставке, у которого нет семантических токенов и который стартует дольше
 * остальных: Pyright строит индекс и молчит, пока его не попросят.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TARGET = process.argv[2] ?? 'python';
const ENTRY =
  TARGET === 'python'
    ? path.join(process.cwd(), 'node_modules/pyright/langserver.index.js')
    : path.join(process.cwd(), 'node_modules/typescript-language-server/lib/cli.mjs');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pyright-raw-'));
const FILE = path.join(DIR, TARGET === 'python' ? 'sample.py' : TARGET === 'javascript' ? 'sample.js' : 'sample.ts');
fs.writeFileSync(
  FILE,
  TARGET === 'python'
    ? 'value = 1\n\ndef config() -> int:\n    return value\n\ntotal = config()\n'
    : TARGET === 'javascript'
      ? 'const value = 1;\n\nexport function config() {\n  return value;\n}\n\nexport const total = config();\n'
      : 'const value: number = 1;\n\nexport function config(): number {\n  return value;\n}\n\nexport const total = config();\n',
);
const URI = `file://${FILE}`;

const child = spawn(process.execPath, [ENTRY, '--stdio'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = Buffer.alloc(0);
const waiters = new Map();
child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const sep = buffer.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const header = buffer.slice(0, sep).toString();
    const len = Number(/Content-Length: (\d+)/i.exec(header)?.[1] ?? 0);
    if (buffer.length < sep + 4 + len) return;
    const body = buffer.slice(sep + 4, sep + 4 + len).toString();
    buffer = buffer.slice(sep + 4 + len);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    const waiter = msg.id !== undefined && waiters.get(msg.id);
    if (waiter) {
      waiters.delete(msg.id);
      waiter(msg);
    }
  }
});
child.stderr.on('data', (data) => console.log('  stderr:', data.toString().trim().slice(0, 200)));

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  return new Promise((resolve) => {
    waiters.set(id, resolve);
    setTimeout(() => resolve({ timeout: true }), 15000);
  });
}
function notify(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', method, params });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

(async () => {
  // Путь к tsserver — тот же, что передаёт IDE (src/main/lsp/bundled.ts:132):
  // без него `typescript-language-server` падает на initialize в любом проекте,
  // где нет своей установки typescript.
  const tsserverPath =
    TARGET === 'python' ? null : path.join(process.cwd(), 'node_modules/typescript-bundled/lib/tsserver.js');
  const init = await request('initialize', {
    processId: process.pid,
    rootUri: `file://${DIR}`,
    capabilities: { textDocument: { semanticTokens: {} } },
    ...(tsserverPath ? { initializationOptions: { tsserver: { path: tsserverPath } } } : {}),
  });
  console.log('initialize целиком:', JSON.stringify(init).slice(0, 400));
  const caps = init.result?.capabilities ?? {};
  console.log('initialize: workspaceSymbolProvider =', caps.workspaceSymbolProvider ?? 'НЕТ ПОЛЯ');
  console.log('  documentSymbolProvider =', caps.documentSymbolProvider ?? 'НЕТ ПОЛЯ');
  const stp = caps.semanticTokensProvider;
  console.log(
    '  semanticTokensProvider =',
    stp === undefined
      ? 'НЕТ ПОЛЯ'
      : JSON.stringify({ full: stp?.full ?? null, types: stp?.legend?.tokenTypes?.length ?? 0 }),
  );
  console.log('  объявленных методов:', Object.keys(caps).length);
  console.log('serverInfo:', init.result?.serverInfo?.name, init.result?.serverInfo?.version);
  notify('initialized', {});
  notify('textDocument/didOpen', {
    textDocument: {
      uri: URI,
      languageId: TARGET === 'python' ? 'python' : TARGET === 'javascript' ? 'javascript' : 'typescript',
      version: 1,
      text: fs.readFileSync(FILE, 'utf8'),
    },
  });

  for (const delay of [0, 1000, 3000]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const sym = await request('textDocument/documentSymbol', { textDocument: { uri: URI } });
    const count = sym.timeout ? 'ТАЙМАУТ' : (sym.result?.length ?? `нет поля (keys: ${Object.keys(sym).join(',')})`);
    console.log(`documentSymbol через ${delay} мс:`, count);
  }
  const ws = await request('workspace/symbol', { query: 'config' });
  console.log(
    'workspace/symbol «config»:',
    ws.timeout ? 'ТАЙМАУТ' : ws.error ? JSON.stringify(ws.error).slice(0, 150) : (ws.result?.length ?? 0),
  );
  const tokens = await request('textDocument/semanticTokens/full', { textDocument: { uri: URI } });
  console.log(
    'semanticTokens:',
    tokens.timeout
      ? 'ТАЙМАУТ'
      : tokens.error
        ? JSON.stringify(tokens.error).slice(0, 200)
        : (tokens.result?.data?.length ?? 0) / 5,
  );
  child.kill();
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(0);
})();
