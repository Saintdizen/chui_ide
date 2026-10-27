/**
 * Проба: что сервер отвечает на подсказку после точки в заданном файле. Ищет в
 * файле строку, оканчивающуюся точкой, и просит дополнение сразу после неё.
 * Печатает состояние (запущено серверов, подсказок), а не ok/FAIL.
 *
 *   ./node_modules/.bin/electron scripts/lsp-member-probe.cjs /проект /проект/файл.py
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
  const python = sources.flat().filter((server) => server.language === 'python');
  console.log(`[серверы python] ${python.map((s) => s.label || s.command).join(' → ') || '—'}`);

  const venvPython = path.join(ROOT, '.venv', 'bin', 'python');
  const lsp = new LspService(
    () => ROOT,
    () => ({ enabled: true, servers: python }),
    () => {},
    () => (fs.existsSync(venvPython) ? venvPython : null),
    async () => ({}),
    async (language) => (language === 'python' ? python : []),
  );

  const lines = fs.readFileSync(FILE, 'utf8').split('\n');
  // Именно строка кода, а не комментарий: комментарий тоже может кончаться точкой.
  const idx = lines.findIndex((line) => !line.trimStart().startsWith('#') && line.trimEnd().endsWith('.'));
  if (idx < 0) {
    console.log('строки, оканчивающейся точкой, в файле нет');
    lsp.dispose();
    app.exit(0);
    return;
  }
  const character = lines[idx].length;

  await lsp.open(FILE, 'python', lines.join('\n'));
  await wait(9000);
  const raw = await lsp.request(FILE, 'textDocument/completion', {
    textDocument: { uri: `file://${FILE}` },
    position: { line: idx, character },
  });
  const items = Array.isArray(raw) ? raw : raw?.items || [];
  console.log(`[строка ${idx + 1}] запущено: ${JSON.stringify(lsp.status().running)}`);
  console.log(`[подсказок: ${items.length}] ${items.map((i) => i.label).join(', ')}`);
  lsp.dispose();
  app.exit(0);
});
