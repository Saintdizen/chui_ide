/**
 * Разовая проба композера чата: открывает окно IDE, доводит панель AI до видимого
 * вида и возвращает метрики новых элементов (пилюли, скрепка, круглая отправка).
 * Нужна, чтобы проверить раскладку по числам, а не на глаз.
 *
 *   npm run build && ./node_modules/.bin/electron scripts/chat-probe.cjs
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-chat-probe-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'main.py'), 'print("demo")\n', 'utf8');

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  registerIpc({ settings, workspace, ai, terminals, git, host: new HostClient() });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);
  // Правая панель (панель AI) может быть скрыта — включаем её кнопкой в шапке.
  await ask(
    ide,
    `(() => {
      const button = [...document.querySelectorAll('button')].find((node) => (node.title || '').startsWith('AI Assistant'));
      if (button && !document.querySelector('.composer-box')) button.click();
      return true;
    })()`,
  );
  await wait(1500);

  const report = await ask(
    ide,
    `(() => {
      const round = (value) => Math.round(value * 10) / 10;
      const info = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          w: round(rect.width),
          h: round(rect.height),
          x: round(rect.left),
          radius: style.borderRadius,
          border: style.borderTopColor,
          color: style.color,
          background: style.backgroundColor,
          text: (node.textContent || '').trim().slice(0, 30),
        };
      };
      const toolbar = document.querySelector('.composer-toolbar');
      const box = document.querySelector('.composer-box');
      const send = document.querySelector('.composer-action');
      const attach = document.querySelector('.composer-attach');
      const topOf = (node) => (node ? Math.round(node.getBoundingClientRect().top) : -1);
      const onSample = (() => {
        const pill = document.querySelectorAll('.composer-pill')[1];
        if (!pill) return null;
        pill.classList.add('is-on');
        const style = getComputedStyle(pill);
        const sample = { border: style.borderTopColor, color: style.color, background: style.backgroundColor };
        pill.classList.remove('is-on');
        return sample;
      })();
      return {
        hasBox: Boolean(box),
        box: info('.composer-box'),
        onSample,
        rows: {
          model: topOf(document.querySelector('.composer-model')),
          deepThink: topOf(document.querySelectorAll('.composer-pill')[0]),
          search: topOf(document.querySelectorAll('.composer-pill')[1]),
          attach: topOf(attach),
          send: topOf(send),
          toolbarHeight: toolbar ? Math.round(toolbar.getBoundingClientRect().height) : null,
        },
        toolbar: toolbar ? { clientWidth: toolbar.clientWidth, scrollWidth: toolbar.scrollWidth } : null,
        pills: [...document.querySelectorAll('.composer-pill')].map((node) => info('.composer-pill') && {
          text: node.textContent.trim(),
          on: node.classList.contains('is-on'),
          disabled: node.disabled,
          rect: (() => { const r = node.getBoundingClientRect(); return { w: round(r.width), h: round(r.height) }; })(),
        }),
        send: send ? { ...info('.composer-action'), radius: getComputedStyle(send).borderRadius } : null,
        attach: attach ? info('.composer-attach') : null,
        attachLeftOfSend: attach && send ? attach.getBoundingClientRect().left < send.getBoundingClientRect().left : null,
        panelWidth: document.querySelector('.right-panel, .panel')?.clientWidth ?? null,
      };
    })()`,
  );

  console.log('[проба] композер:', JSON.stringify(report, null, 2));

  const image = await ide.capturePage();
  const shot = path.join(process.env.TMPDIR ?? '/tmp', 'chui-chat-probe.png');
  await fs.writeFile(shot, image.toPNG());
  console.log(`[проба] снимок: ${shot}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
