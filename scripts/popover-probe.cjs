/**
 * Проверка позиции попапа Python-окружения: попап не должен вылезать за окно.
 *
 *   ./node_modules/.bin/electron scripts/popover-probe.cjs
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([window.webContents.executeJavaScript(expression), wait(timeoutMs).then(() => 'нет ответа')]);

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-popover-probe-'));
  const project = path.join(dir, 'demo');
  // Python-проект с окружением: именно тогда виджет окружения и появляется.
  await fs.mkdir(path.join(project, '.venv', 'bin'), { recursive: true });
  await fs.writeFile(path.join(project, 'pyproject.toml'), '[project]\nname = "demo"\n', 'utf8');
  await fs.writeFile(path.join(project, '.venv', 'bin', 'python'), '#!/bin/sh\n', 'utf8');

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(() => workspace.rootPath(), (topic, payload) => pushToRenderers(topic, payload));
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  registerIpc({ settings, workspace, ai, terminals, git, host: new HostClient() });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  // Намеренно низкое окно: именно так попап и уезжал за нижний край.
  ide.setSize(760, 420);
  await wait(800);

  const report = await ask(
    ide,
    `(async () => {
      const measure = () => {
        const box = document.querySelector('.popover-python-env');
        if (!box) return null;
        const rect = box.getBoundingClientRect();
        return {
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          height: Math.round(rect.height),
          fits: rect.top >= 0 && rect.bottom <= window.innerHeight,
        };
      };
      const button = document.querySelector('.status-env');
      if (!button) return { error: 'кнопки окружения нет' };
      button.click();
      // Сразу после открытия — когда содержимое ещё не подгрузилось,
      // и позже — когда список окружений уже приехал.
      const early = measure();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const late = measure();
      return {
        window: window.innerHeight,
        early,
        late,
        rows: document.querySelectorAll('.python-env-option').length,
      };
    })()`,
  );

  console.log(`[попап] ${JSON.stringify(report)}`);
  const shot = path.join(process.env.TMPDIR ?? '/tmp', 'chui-popover-probe.png');
  await fs.writeFile(shot, (await ide.capturePage()).toPNG());
  console.log(`[попап] снимок: ${shot}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
