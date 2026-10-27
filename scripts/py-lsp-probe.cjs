/**
 * Проба LSP для Python на настоящем проекте: отвечает ли сервер на дополнение после
 * точки. Печатает состояние (сколько серверов поднялось, сколько подсказок), а не
 * ok/FAIL — как остальные «пробники».
 *
 *   ./node_modules/.bin/electron scripts/py-lsp-probe.cjs /путь/к/проекту /путь/к/файлу
 */
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { LspService } = require('../dist/main/lsp/lsp.js');
const { detectBundledServers } = require('../dist/main/lsp/bundled.js');

const ROOT = process.argv[2] || process.cwd();
const FILE = process.argv[3];

async function tryServer(label, servers, pythonPath) {
  const lsp = new LspService(
    () => ROOT,
    () => ({ enabled: true, servers }),
    () => {},
    () => pythonPath,
    async () => ({}),
  );
  const original = fs.readFileSync(FILE, 'utf8');
  const lines = original.split('\n');
  // Состояние из скриншота: строку `form.` человек набрал, но не сохранил. Значит,
  // в файле её нет — подставляем сами, иначе проверять нечего.
  const after = lines.findIndex((line) => /^\s*\w+\s*=\s*\w+Page\(/.test(line));
  const receiverMatch = after >= 0 ? /^\s*(\w+)\s*=/.exec(lines[after]) : null;
  const lineIdx = after >= 0 ? after + 1 : -1;
  if (lineIdx >= 0 && receiverMatch) {
    const indent = /^\s*/.exec(lines[after])[0];
    lines.splice(lineIdx, 0, `${indent}${receiverMatch[1]}.`);
  }
  const text = lines.join('\n');
  const match = lineIdx >= 0 ? /\w+\./.exec(lines[lineIdx]) : null;
  if (!match) {
    console.log(`[${label}] места для «объект.» в файле не нашлось`);
    lsp.dispose();
    return;
  }
  const character = lines[lineIdx].indexOf(match[0]) + match[0].length;

  await lsp.open(FILE, 'python', text);
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const raw = await lsp.request(FILE, 'textDocument/completion', {
    textDocument: { uri: `file://${FILE}` },
    position: { line: lineIdx, character },
  });
  const items = Array.isArray(raw) ? raw : raw?.items || [];
  console.log(`[${label}] строка ${lineIdx + 1}; запущено: ${JSON.stringify(lsp.status().running)}`);
  console.log(
    `[${label}] подсказок: ${items.length}; первые: ${
      items
        .slice(0, 10)
        .map((item) => item.label)
        .join(', ') || '—'
    }`,
  );
  lsp.dispose();
  await new Promise((resolve) => setTimeout(resolve, 500));
}

app.whenReady().then(async () => {
  const venvPython = path.join(ROOT, '.venv', 'bin', 'python');
  const bundled = await detectBundledServers();
  await tryServer(
    'pyright (поставка)',
    bundled.filter((server) => server.language === 'python'),
    fs.existsSync(venvPython) ? venvPython : null,
  );
  const pylsp = path.join(ROOT, '.venv', 'bin', 'pylsp');
  if (fs.existsSync(pylsp)) {
    await tryServer(
      'pylsp (venv)',
      [{ language: 'python', command: pylsp, args: [], enabled: true }],
      fs.existsSync(venvPython) ? venvPython : null,
    );
  }
  app.exit(0);
});
