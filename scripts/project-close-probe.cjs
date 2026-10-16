/**
 * Проба «Закрыть проект»: из окна IDE обратно к списку проектов.
 *
 *   npm run probe:close-project
 *
 * Пункт меню Файл → «Закрыть проект» закрывает окно IDE и поднимает стартовое окно
 * со списком проектов. Порядок здесь не украшение: стартовое окно создаёт main и
 * ДО того, как закроется окно IDE, — иначе окна кончились бы совсем, и
 * `window-all-closed` успел бы выйти из приложения на Windows и Linux. Само окно
 * IDE закрывает renderer, получив ответ: закрытие в обработчике уничтожило бы
 * отправителя раньше, чем до него дошёл бы результат вызова.
 *
 * Проверяем то же, что делает человек: команду пункта шлём тем же путём, что и
 * системное меню (`menu:command`), а состояние смотрим снаружи — по окнам.
 *
 * Нужен собранный код: `npm run build`. Снимок — `.chui_ide/probe-shots/project-close.png`.
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PushTopic } = require('../dist/shared/api.js');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { getIdeWindow, getWelcomeWindow, openWelcomeWindow } = require('../dist/main/window.js');

registerAppScheme();

// Речь renderer’а видна снаружи: без этого провал команды («команда не найдена»)
// и ошибки моста остались бы без объяснения.
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (event, _level, message) => {
    const text = typeof message === 'string' ? message : (event?.message ?? '');
    if (String(text).trim()) console.log(`[проба][консоль] ${text}`);
  });
});

let failed = 0;
const check = (label, condition, extra) => {
  if (!condition) failed += 1;
  const tail = extra !== undefined ? `: ${JSON.stringify(extra)}` : '';
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${tail}`);
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Запрос в страницу: renderer занят первой отрисовкой и отвечает не сразу.
 * Окно могло закрыться — проверяем ДО обращения к `webContents`: у уничтоженного
 * окна это геттер, который бросает, и проба падала бы вместо отчёта.
 */
const ask = (window, expression, timeoutMs = 20000) => {
  if (!window || window.isDestroyed()) return Promise.resolve('окно закрыто');
  return Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);
};

/** Дождаться, пока выражение в странице станет истинным. */
async function waitFor(window, expression, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (window.isDestroyed()) return false;
    // eslint-disable-next-line no-await-in-loop
    if ((await ask(window, expression, 2000)) === true) return true;
    // eslint-disable-next-line no-await-in-loop
    await wait(250);
  }
  return false;
}

const loaded = (window, timeoutMs = 60000) =>
  Promise.race([
    new Promise((resolve) => window.webContents.once('did-finish-load', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-close-probe-'));
  const project = path.join(dir, 'demo-project');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), '# demo\n', 'utf8');

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

  // Ключевой случай: если бы окно IDE закрывалось РАНЬШЕ, чем появится стартовое,
  // окна кончились бы совсем — и приложение вышло бы. Флагами и сторожим.
  let allClosedSeen = false;
  let welcomeAtIdeClose = null;
  app.on('window-all-closed', () => {
    allClosedSeen = true;
  });

  /* ── начало: стартовое окно, проект открыт из него ─────────────────────── */

  const welcome = openWelcomeWindow();
  await loaded(welcome);
  check('стартовое окно открылось', await waitFor(welcome, `Boolean(document.querySelector('.launcher'))`));

  // Открываем проект так же, как кнопка в стартовом окне: через мост и реальный роутер.
  await ask(
    welcome,
    `window.chui.call({ id: 'probe-open', method: 'app.openProject', params: { path: ${JSON.stringify(project)} } })`,
  );
  // Стартовое окно закрывает сам лаунчер — повторяем то же, что делает интерфейс.
  await ask(welcome, `void window.chui.call({ id: 'probe-close-welcome', method: 'window.close' })`);
  await wait(800);

  const ide = getIdeWindow();
  check('окно IDE открылось', ide !== null && !ide.isDestroyed());
  check('пока проект открыт, стартового окна нет', getWelcomeWindow() === null);
  if (!ide || ide.isDestroyed()) {
    app.exit(1);
    return;
  }

  const ready = await waitFor(ide, `Boolean(document.querySelector('.app'))`);
  check('окно IDE отрисовалось', ready);
  // Окно рисуется раньше, чем интерфейс подпишется на push-события, а команда
  // пункта приходит именно ими: без этой паузы посыл пропадает в пустоту.
  await wait(2500);
  ide.on('closed', () => {
    welcomeAtIdeClose = getWelcomeWindow();
  });

  /* ── команда пункта меню ───────────────────────────────────────────────── */

  console.log('[проба] отправляю команду «Закрыть проект»');
  pushToRenderers(PushTopic.MenuCommand, { command: 'project.close' });
  await wait(2500);
  const until = Date.now() + 8000;
  while (Date.now() < until && getIdeWindow() !== null) await wait(200);
  await wait(500);

  check('окно IDE закрылось', getIdeWindow() === null, getIdeWindow() === null ? undefined : 'окно на месте');

  const reopened = getWelcomeWindow();
  check('стартовое окно вернулось', reopened !== null && !reopened.isDestroyed());
  check(
    'стартовое окно уже существовало в момент закрытия окна IDE',
    welcomeAtIdeClose !== null && welcomeAtIdeClose !== undefined,
    welcomeAtIdeClose === null ? 'стартовое окно появилось позже' : undefined,
  );
  check('приложение не оставалось без окон', !allClosedSeen);

  if (reopened && !reopened.isDestroyed()) {
    await waitFor(reopened, `Boolean(document.querySelector('.launcher'))`);
    const launcher = await ask(
      reopened,
      `({
        форма: Boolean(document.querySelector('.launcher')),
        кнопки: [...document.querySelectorAll('.launcher-action')].map((node) => node.textContent.trim()),
        недавние: [...document.querySelectorAll('.launcher-item-name')].map((node) => node.textContent),
      })`,
    );
    check('стартовое окно рисует список проектов', launcher?.форма === true, launcher);
    check(
      'открытый проект есть в списке недавних',
      Array.isArray(launcher?.недавние) && launcher.недавние.includes('demo-project'),
      launcher?.недавние,
    );

    const shots = path.join(__dirname, '..', '.chui_ide', 'probe-shots');
    await fs.mkdir(shots, { recursive: true });
    await fs.writeFile(path.join(shots, 'project-close.png'), (await reopened.capturePage()).toPNG());
    console.log(`  снимок: ${path.join(shots, 'project-close.png')}`);
  }

  console.log(failed === 0 ? '\nзакрытие проекта возвращает к списку проектов' : `\nпровалов: ${failed}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(failed === 0 ? 0 : 1);
});
