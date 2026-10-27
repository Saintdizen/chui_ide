/**
 * Проба отката Python-LSP: названный сервер (venv pylsp) может не подняться, и
 * язык должен получить следующий по приоритету (поставка Pyright). Печатает
 * состояние, а не ok/FAIL.
 *
 *   ./node_modules/.bin/electron scripts/py-lsp-fallback-probe.cjs /путь/к/проекту /путь/к/файлу
 */
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { LspService } = require('../dist/main/lsp/lsp.js');
const { detectLspSources } = require('../dist/main/lsp/detect.js');

const ROOT = process.argv[2] || process.cwd();
const FILE = process.argv[3];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const sources = await detectLspSources(ROOT, process.platform);
  const all = sources.flat().filter((server) => server.language === 'python');
  console.log(`[цепочка] ${all.map((server) => server.label || server.command).join(' → ') || '—'}`);
  const preferred = all[0];
  if (!preferred) {
    console.log('python-серверов не найдено');
    app.exit(0);
    return;
  }

  const venvPython = path.join(ROOT, '.venv', 'bin', 'python');
  const lsp = new LspService(
    () => ROOT,
    () => ({ enabled: true, servers: [preferred] }),
    () => {},
    () => (fs.existsSync(venvPython) ? venvPython : null),
    async () => ({}),
    async (language) => (language === 'python' ? all : []),
  );

  const lines = fs.readFileSync(FILE, 'utf8').split('\n');
  const target = lines.findIndex((line) => /^\s*\w+\s*=\s*\w+Page\(/.test(line));
  const receiver = target >= 0 ? /^\s*(\w+)\s*=/.exec(lines[target]) : null;
  if (!receiver) {
    console.log('места для «объект.» в файле не нашлось');
    lsp.dispose();
    app.exit(0);
    return;
  }
  const indent = /^\s*/.exec(lines[target])[0];
  const lineIdx = target + 1;
  lines.splice(lineIdx, 0, `${indent}${receiver[1]}.`);
  const character = indent.length + receiver[1].length + 1;

  await lsp.open(FILE, 'python', lines.join('\n'));
  // Первый сервер (сломанный) отвечает не сразу: ждём его таймаут и подъём Pyright.
  await wait(25000);
  const raw = await lsp.request(FILE, 'textDocument/completion', {
    textDocument: { uri: `file://${FILE}` },
    position: { line: lineIdx, character },
  });
  const items = Array.isArray(raw) ? raw : raw?.items || [];
  console.log(`[итог] запущено: ${JSON.stringify(lsp.status().running)}`);
  console.log(
    `[итог] подсказок: ${items.length}; первые: ${
      items
        .slice(0, 10)
        .map((i) => i.label)
        .join(', ') || '—'
    }`,
  );
  lsp.dispose();
  app.exit(0);
});
