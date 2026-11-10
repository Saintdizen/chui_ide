/**
 * Замер: почему бегунок полосы прокрутки стоит в конце дорожки до прокрутки.
 *
 *   node scripts/scroll-probe.cjs
 *
 * Окно настоящее, дерево настоящее. Снимаем scrollTop каждого скроллера сразу
 * после старта: если он равен нулю, а бегунок нарисован в конце — виновата
 * не прокрутка, а разметка или перенос фокуса.
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([window.webContents.executeJavaScript(expression), wait(timeoutMs).then(() => 'нет ответа')]);

const PROBE = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (!/auto|scroll/.test(cs.overflowY)) continue;
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    out.push({
      cls: String(el.className || el.tagName).slice(0, 46),
      top: Math.round(el.scrollTop),
      max: el.scrollHeight - el.clientHeight,
      flex: cs.flexDirection,
      kids: el.children.length,
      active: el.contains(document.activeElement),
      anchor: cs.overflowAnchor,
    });
  }
  return out;
})()`;

app.whenReady().then(async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-scroll-probe-')));
  const project = path.join(dir, 'demo');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  for (let i = 0; i < 80; i += 1) {
    await fs.writeFile(path.join(project, `file-${String(i).padStart(2, '0')}.txt`), `x${i}\n`, 'utf8');
  }
  await fs.writeFile(path.join(project, 'src', 'a.ts'), 'const a = 1;\n', 'utf8');
  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
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

  console.log('SCROLLERS', JSON.stringify(await ask(ide, PROBE), null, 1));
  console.log(
    'ACTIVE',
    await ask(
      ide,
      `String((document.activeElement && (document.activeElement.className || document.activeElement.tagName)) || '')`,
    ),
  );
  console.log(
    'BODY',
    await ask(
      ide,
      `JSON.stringify({ sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight })`,
    ),
  );
  app.quit();
});
