/**
 * Сырой разговор с Pyright по LSP: видно, что сервер пишет в лог и что отвечает.
 * Нужна, когда наша обёртка молчит, а понять надо, на чьей стороне дело.
 *
 *   ./node_modules/.bin/electron scripts/py-lsp-raw.cjs /путь/к/проекту /путь/к/файлу
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { detectBundledServers } = require('../dist/main/lsp/bundled.js');
const { app } = require('electron');

const ROOT = process.argv[2] || process.cwd();
const FILE = process.argv[3];
const LINE_WITH_DOT = 4; // 1-based строка `form.` в проверочном файле

async function main() {
  const bundled = await detectBundledServers();
  const pyright = bundled.find((server) => server.language === 'python');
  const pylspPath = path.join(ROOT, '.venv', 'bin', 'pylsp');
  // Какой сервер проверяем: по умолчанию Pyright, `pylsp` — по третьему аргументу.
  const wantPylsp = process.argv[4] === 'pylsp';
  const command = wantPylsp ? pylspPath : pyright?.command;
  const args = wantPylsp ? [] : [pyright.args[0], '--stdio'];
  if (!command || !fs.existsSync(command)) {
    console.log(`сервер не найден: ${command}`);
    return;
  }
  console.log(`сервер: ${command}`);
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...(wantPylsp ? {} : (pyright.env ?? {})) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const send = (message) => {
    child.stdin.write(
      `Content-Length: ${Buffer.byteLength(JSON.stringify(message))}\r\n\r\n${JSON.stringify(message)}`,
    );
  };
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const head = buffer.match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!head) break;
      const length = Number(head[1]);
      if (buffer.length < head[0].length + length) break;
      const message = JSON.parse(buffer.slice(head[0].length, head[0].length + length));
      buffer = buffer.slice(head[0].length + length);
      handle(message);
    }
  });
  child.stderr.on('data', (chunk) => console.log('[stderr]', String(chunk).trim().slice(0, 1200)));

  const uri = `file://${FILE}`;
  const text = fs.readFileSync(FILE, 'utf8');

  function handle(message) {
    if (message.method === 'window/logMessage')
      console.log('[log]', String(message.params?.message ?? '').slice(0, 400));
    if (message.method === 'window/showMessage')
      console.log('[show]', String(message.params?.message ?? '').slice(0, 400));
    if (message.id === 1) {
      console.log(
        'initialize ok; completionProvider:',
        JSON.stringify(message.result?.capabilities?.completionProvider),
      );
      notify('initialized', {});
      notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'python', version: 1, text },
      });
      setTimeout(ask, 8000);
    }
    if (message.id === 2) {
      const items = Array.isArray(message.result) ? message.result : message.result?.items || [];
      console.log(`подсказок: ${items.length}`);
      console.log(
        `первые: ${
          items
            .slice(0, 12)
            .map((item) => item.label)
            .join(', ') || '—'
        }`,
      );
      child.kill();
      app.exit(0);
    }
  }

  function ask() {
    const lines = fs.readFileSync(FILE, 'utf8').split('\n');
    const line = lines[LINE_WITH_DOT - 1] ?? '';
    console.log(`строка ${LINE_WITH_DOT}: "${line}"`);
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'textDocument/completion',
      params: { textDocument: { uri }, position: { line: LINE_WITH_DOT - 1, character: line.length } },
    });
  }

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      processId: process.pid,
      rootUri: `file://${ROOT}`,
      capabilities: { textDocument: { completion: {} } },
      initializationOptions: { pythonPath: path.join(ROOT, '.venv', 'bin', 'python') },
    },
  });
  setTimeout(() => {
    console.log('таймаут');
    child.kill();
    app.exit(1);
  }, 60000);
}

app.whenReady().then(main);
