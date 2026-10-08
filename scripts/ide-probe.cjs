/**
 * Диагностика (не проверка): поднимаем окно IDE против собранного renderer'а
 * и смотрим, отвечает ли оно на запрос. Нужно, чтобы отделить причину зависания
 * renderer'а от сценария стартового окна.
 *
 *   ./node_modules/.bin/electron scripts/ide-probe.cjs [путь-к-проекту]
 *
 * Без аргумента проект не открывается вовсе.
 */
const { app, BrowserWindow } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();

app.on('web-contents-created', (_event, contents) => {
  const tag = `[проба][${contents.id}]`;
  contents.on('dom-ready', () => console.log(`${tag} dom-ready`));
  contents.on('did-finish-load', () => console.log(`${tag} did-finish-load`));
  contents.on('did-stop-loading', () => console.log(`${tag} did-stop-loading`));
  contents.on('did-fail-load', (_e, code, description, url) =>
    console.log(`${tag} did-fail-load ${code} ${description} ${url}`),
  );
  contents.on('unresponsive', () => console.log(`${tag} unresponsive`));
  contents.on('responsive', () => console.log(`${tag} снова отвечает`));
  contents.on('render-process-gone', (_e, details) => console.log(`${tag} renderer упал: ${details.reason}`));
  contents.on('preload-error', (_e, file, error) => console.log(`${tag} preload-error ${file}: ${error.message}`));
  contents.on('console-message', (event, level, message) => {
    const text = typeof message === 'string' ? message : (event?.message ?? '');
    console.log(`${tag} консоль: ${text}`);
  });
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ask = (window, expression, timeoutMs = 30000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-ide-probe-'));
  const project = process.argv[2] ?? path.join(dir, 'demo-project');
  if (!process.argv[2]) {
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# demo\n', 'utf8');
  }

  serveRenderer();

  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(() => workspace.rootPath(), (topic, payload) => pushToRenderers(topic, payload));
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  registerIpc({ settings, workspace, ai, terminals, git });

  if (process.env.CHUI_PROBE_PROJECT !== 'skip') await workspace.open(project);
  console.log(`[проба] проект: ${process.env.CHUI_PROBE_PROJECT === 'skip' ? 'не открываем' : project}`);

  const ide = openIdeWindow();
  for (const seconds of [5, 10, 20, 30]) {
    await wait(seconds === 5 ? 5000 : 5000);
    const answer = await ask(ide, `({
      app: Boolean(document.querySelector('.app')),
      workspace: document.querySelector('.workspace-name')?.textContent ?? null,
      entries: [...document.querySelectorAll('.tree-name')].map((node) => node.textContent),
      loading: document.querySelector('.tree-loading')?.textContent ?? null,
    })`, 20000);
    console.log(`[проба] ${seconds} с: ${JSON.stringify(answer)}`);
  }

  const image = await ide.capturePage();
  const shot = path.join(process.env.TMPDIR ?? '/tmp', 'chui-ide-probe.png');
  await fs.writeFile(shot, image.toPNG());
  console.log(`[проба] снимок: ${shot}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
