/**
 * Замер: сколько стоит кадр прокрутки в редакторе на тяжёлом файле.
 *
 *   node scripts/editor-scroll-bench.cjs [строк] [шаг-px]
 *
 * Окно настоящее, шрифт настоящий, миникарта и полоса меток тоже. Открываем файл
 * на 50 000 строк, крутим его шагами и меряем промежутки между кадрами. Числа —
 * ответ на пункт 81 TASKS («оптимизация UI»); остальные пункты без них не
 * закрываются.
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();

const LINES = Number(process.argv[2] || 50000);
const STEP = Number(process.argv[3] || 48);
const FILE = 'huge.ts';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (window, expression, timeoutMs = 120000) =>
  Promise.race([window.webContents.executeJavaScript(expression), wait(timeoutMs).then(() => 'нет ответа')]);

const OPEN_AND_BENCH = `(async () => {
  const leaves = [...document.querySelectorAll('*')].filter(
    (el) => el.childElementCount === 0 && el.textContent.trim() === '${FILE}',
  );
  const target = leaves[leaves.length - 1];
  if (!target) return { error: 'файла нет в дереве' };
  const row = target.closest('[role="treeitem"], li, .tree-row, .tree-node') || target;
  row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 2500));
  const editors = [...document.querySelectorAll('.own-editor, .own-editor *')];
  const editor = editors.find((el) => el.scrollHeight > el.clientHeight + 100);
  if (!editor) {
    return {
      error: 'редактор не открылся или файл короткий',
      editors: editors.length,
      sizes: editors.map((el) => el.className + ':' + el.scrollHeight + '/' + el.clientHeight),
      rowClass: row.className,
      tabs: [...document.querySelectorAll('[class*=tab] [class*=title], [class*=tab]')].length,
    };
  }
  const frame = () => new Promise((r) => requestAnimationFrame(() => r(performance.now())));
  editor.scrollTop = 0;
  await frame();
  await frame();
  const deltas = [];
  let prev = await frame();
  for (let i = 0; i < 90; i += 1) {
    editor.scrollTop += ${STEP};
    const now = await frame();
    deltas.push(now - prev);
    prev = now;
  }
  const sorted = [...deltas].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    lines: Math.round(editor.scrollHeight / (editor.scrollHeight / (${LINES} + 1))),
    scrollHeight: editor.scrollHeight,
    frames: deltas.length,
    median: Number(pick(0.5).toFixed(1)),
    p90: Number(pick(0.9).toFixed(1)),
    max: Number(Math.max(...deltas).toFixed(1)),
    over16: deltas.filter((d) => d > 16.7).length,
    over33: deltas.filter((d) => d > 33).length,
  };
})()`;

app.whenReady().then(async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-scroll-bench-')));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  const body = [];
  if (process.argv[5] === 'wide') {
    body.push(`const data = [${'"строка",'.repeat(120000)}];`);
  }
  for (let i = 0; i < (process.argv[5] === 'wide' ? 0 : LINES); i += 1)
    body.push(`export const value${i} = ${i}; // строка ${i}`);
  await fs.writeFile(path.join(project, FILE), `${body.join('\n')}\n`, 'utf8');
  serveRenderer();
  const settingsPath = path.join(dir, 'settings.json');
  if (process.argv[4] === 'minimap') {
    await fs.writeFile(settingsPath, JSON.stringify({ editor: { minimap: true } }), 'utf8');
  }
  const settings = new SettingsStore(settingsPath);
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const gitService = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  registerIpc({ settings, workspace, ai, terminals, git: gitService, host: new HostClient() });
  await workspace.open(project);
  const ide = openIdeWindow();
  await wait(7000);

  const result = await ask(ide, OPEN_AND_BENCH);
  console.log('SCROLL_BENCH', JSON.stringify(result));
  app.quit();
});
