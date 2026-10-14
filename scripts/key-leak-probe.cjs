/**
 * Решает один вопрос: доходит ли нажатие, которое Electron взял через акселератор
 * системного меню (Ctrl+Shift+P), ещё и до renderer'а как `keydown`.
 *
 * Если доходит — команда срабатывает ДВАЖДЫ: один раз из меню (push `menu:command`),
 * второй раз из `KeybindingService` в renderer. Если нет — путь один, и двойных
 * уведомлений из-за клавиш не бывает.
 *
 *   npm run build:main && ./node_modules/.bin/electron scripts/key-leak-probe.cjs
 */
const { app } = require('electron');
const { promises: fs, mkdtempSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { createApplicationMenu } = require('../dist/main/menu.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();
app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'chui-keyleak-profile-')));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-keyleak-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'a.ts'), 'const x = 1;\n', 'utf8');

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((t, p) => pushToRenderers(t, p));
  const git = new GitService(
    () => workspace.rootPath(),
    (t, p) => pushToRenderers(t, p),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((t, p) => pushToRenderers(t, p));
  registerIpc({ settings, workspace, ai, terminals, git, host: new HostClient() });
  createApplicationMenu();

  await workspace.open(project);
  const ide = openIdeWindow();
  await wait(5000);
  ide.webContents.setZoomLevel(0);
  await wait(300);

  // Ставим ловушку клавиш в renderer: важно, доходит ли туда нажатие вообще.
  await ask(
    ide,
    `(() => {
      window.__leak = [];
      window.addEventListener('keydown', (e) => {
        window.__leak.push([e.key, !!e.ctrlKey, !!e.shiftKey, !!e.altKey, !!e.defaultPrevented].join('|'));
      }, true);
      return true;
    })()`,
  );

  const send = async (keyCode, modifiers) => {
    ide.focus();
    ide.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    ide.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
    ide.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await wait(600);
  };

  await ask(ide, `window.__leak = []; 1`);
  await send('P', ['control', 'shift']);
  const afterMenuKey = await ask(ide, 'JSON.stringify(window.__leak)');

  await ask(ide, `window.__leak = []; 1`);
  await send('G', ['control', 'shift']); // это клавиша renderer (view.showChanges), не меню
  const afterRendererKey = await ask(ide, 'JSON.stringify(window.__leak)');

  console.log(`[ключи] Ctrl+Shift+P (акселератор меню) — keydown в renderer: ${afterMenuKey}`);
  console.log(`[ключи] Ctrl+Shift+G (клавиша renderer)    — keydown в renderer: ${afterRendererKey}`);

  terminals.dispose();
  workspace.dispose();
  app.exit(0);
});
