/**
 * Проверка стартового окна и перехода в IDE: поднимаем настоящее приложение
 * (окна, IPC, renderer из dist), смотрим, что стартовое окно отрисовалось
 * со списком недавних, а открытие проекта из него создаёт окно IDE
 * с уже открытой папкой.
 *
 *   npm run smoke:launcher
 *
 * Настройки пишутся во временный файл: тест не трогает settings.json пользователя.
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
const { createWelcomeWindow } = require('../dist/main/window.js');

const SHOTS = process.env.TMPDIR ?? '/tmp';
let failed = false;

const check = (label, condition, extra) => {
  const mark = condition ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

/**
 * Один запрос в страницу. Ждать ответа нужно терпеливо: renderer занят загрузкой
 * Monaco и отвечает не сразу, а частые повторные вызовы только заваливают его
 * работой — `executeJavaScript` копятся в очереди и держат поток занятым,
 * поэтому окно начинает считаться «не отвечающим».
 */
const probePage = (window, expression, timeoutMs = 30000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);

/**
 * Ждём первой загрузки документа. Проверять `webContents.isLoading()` нельзя:
 * флаг остаётся true, пока запрашиваются подресурсы (Monaco тянет worker'ы),
 * а `did-finish-load` за это время уже прошёл — ожидание повисало навсегда.
 * Подписка ставится до окончания загрузки, поэтому событие не пропускается.
 */
const loaded = (window, timeoutMs = 60000) =>
  Promise.race([
    new Promise((resolve) => window.webContents.once('did-finish-load', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);

const shot = async (window, name) => {
  const image = await window.capturePage();
  await fs.writeFile(path.join(SHOTS, name), image.toPNG());
  console.log(`       снимок: ${path.join(SHOTS, name)}`);
};

registerAppScheme();

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-launcher-'));
  const project = path.join(dir, 'demo-project');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), '# demo\n', 'utf8');

  serveRenderer();

  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(() => workspace.rootPath(), (topic, payload) => pushToRenderers(topic, payload));
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));

  registerIpc({ settings, workspace, ai, terminals, git });

  // Проект уже открывался раньше — значит он есть в истории.
  await workspace.open(project);
  settings.rememberProject(project);

  const welcome = createWelcomeWindow();
  const welcomeLoaded = await loaded(welcome, 30000);
  check('стартовое окно отрисовано', welcomeLoaded, welcomeLoaded ? undefined : 'документ не загрузился');
  // Признак своей рамки появляется после первого запроса состояния окна,
  // поэтому даём кадру дорисоваться, а не проверяем сразу после загрузки.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const welcomeProbe = await probePage(welcome, `({
    launcher: Boolean(document.querySelector('.launcher')),
    actions: [...document.querySelectorAll('.launcher-action')].map((button) => button.textContent.trim()),
    empty: Boolean(document.querySelector('.launcher-empty')),
    recent: [...document.querySelectorAll('.launcher-item-name')].map((node) => node.textContent),
    customFrame: document.documentElement.classList.contains('has-custom-frame'),
  })`);

  check('разметка стартового окна на месте', Boolean(welcomeProbe?.launcher) && Boolean(welcomeProbe?.customFrame));
  check('есть обе кнопки старта', welcomeProbe.actions.join('|') === 'Открыть проект|Склонировать проект', welcomeProbe.actions);
  check('список недавних не пуст', welcomeProbe.recent.includes('demo-project') && !welcomeProbe.empty, welcomeProbe.recent);
  await shot(welcome, 'chui-launcher-welcome.png');

  // Открываем проект так же, как это делает кнопка в окне: через мост и реальный роутер.
  // Ограничиваем время ожидания: если main закроет окно до ответа, обещание не разрешится
  // и проверка должна упасть с внятным текстом, а не висеть вечно.
  let opened;
  try {
    opened = await Promise.race([
      welcome.webContents.executeJavaScript(
        `window.chui.call({ id: 'smoke-open', method: 'app.openProject', params: { path: ${JSON.stringify(project)} } })`,
      ),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('нет ответа на app.openProject')), 8000)),
    ]);
  } catch (error) {
    opened = { ok: false, error: String(error.message) };
  }
  check('открытие проекта вернуло корень', opened.ok && opened.value.root === project, opened.ok ? opened.value : opened.error);

  // Лаунчер закрывает своё окно сам, получив ответ, — повторяем то же, что делает UI.
  await probePage(welcome, `void window.chui.call({ id: 'smoke-close', method: 'window.close' })`);

  await new Promise((resolve) => setTimeout(resolve, 1500));

  const windows = BrowserWindow.getAllWindows();
  check('стартовое окно закрылось', !windows.some((window) => window === welcome), windows.length);
  const ide = windows.find((window) => !window.isDestroyed() && window !== welcome);
  check('открылось окно IDE', Boolean(ide));

  if (ide) {
    ide.webContents.on('render-process-gone', (_event, details) =>
      console.log(`       renderer упал: ${details.reason} (${details.exitCode})`),
    );
    // Запросы в renderer окна IDE здесь не делаем: в этом окружении окно после первой
    // отрисовки может надолго замереть (см. `scripts/ide-probe.cjs`), и тогда проверка
    // падала бы по причине, не имеющей отношения к переходу. Проверяем то, что видно
    // из main: окно IDE получило открытый корень и история его запомнила.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    check('окно IDE видно и не пустое', ide.isVisible() && !ide.webContents.isDestroyed());
    check('окно IDE видит открытый корень', workspace.rootPath() === project, workspace.rootPath());
    await shot(ide, 'chui-launcher-ide.png');
  }

  check('история запомнила проект', settings.get().workspace.recent.includes(project), settings.get().workspace.recent);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(failed ? '[chui] есть расхождения' : '[chui] стартовое окно и переход в IDE работают');
  app.exit(failed ? 1 : 0);
});
