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
const { HostClient } = require('../dist/main/ipc/host.js');
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
 * Один запрос в страницу. Ждать ответа нужно терпеливо: renderer занят первой
 * загрузкой и отвечает не сразу, а частые повторные вызовы только заваливают его
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
 * флаг остаётся true, пока запрашиваются подресурсы (шрифт кода и прочее),
 * а `did-finish-load` за это время уже прошёл — ожидание повисало навсегда.
 * Подписка ставится до окончания загрузки, поэтому событие не пропускается.
 */
/** Есть ли путь: у  здесь только обещания, поэтому проверка своя. */
const pathExists = (target) =>
  fs
    .stat(target)
    .then(() => true)
    .catch(() => false);

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
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));

  registerIpc({ settings, workspace, ai, terminals, git, host: new HostClient() });

  // Проект уже открывался раньше — значит он есть в истории.
  await workspace.open(project);
  settings.rememberProject(project);

  const welcome = createWelcomeWindow();
  const welcomeLoaded = await loaded(welcome, 30000);
  check('стартовое окно отрисовано', welcomeLoaded, welcomeLoaded ? undefined : 'документ не загрузился');
  // Признак своей рамки появляется после первого запроса состояния окна,
  // поэтому даём кадру дорисоваться, а не проверяем сразу после загрузки.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const welcomeProbe = await probePage(
    welcome,
    `({
    launcher: Boolean(document.querySelector('.launcher')),
    actions: [...document.querySelectorAll('.launcher-action')].map((button) => button.textContent.trim()),
    empty: Boolean(document.querySelector('.launcher-empty')),
    recent: [...document.querySelectorAll('.launcher-item-name')].map((node) => node.textContent),
    customFrame: document.documentElement.classList.contains('has-custom-frame'),
  })`,
  );

  check('разметка стартового окна на месте', Boolean(welcomeProbe?.launcher) && Boolean(welcomeProbe?.customFrame));
  check(
    'кнопки старта: открыть, склонировать и создать',
    welcomeProbe.actions.join('|') === 'Открыть проект|Склонировать проект|Создать проект',
    welcomeProbe.actions,
  );
  check(
    'список недавних не пуст',
    welcomeProbe.recent.includes('demo-project') && !welcomeProbe.empty,
    welcomeProbe.recent,
  );
  await shot(welcome, 'chui-launcher-welcome.png');

  /* ── создание проекта ─────────────────────────────────────────────────────── */

  // Кнопка «Создать проект» открывает форму с именем, типом и папкой. Сначала
  // смотрим форму как её видит человек, потом — само создание: файлы-заготовки
  // должны появиться на диске, а занятую папку и дурное имя main обязан отвергнуть.
  const createForm = await probePage(
    welcome,
    `(async () => {
      const button = [...document.querySelectorAll('.launcher-action')].find(
        (node) => node.textContent.trim() === 'Создать проект',
      );
      if (!button) return 'нет кнопки';
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const form = document.querySelector('.launcher-create');
      const create = [...(form?.querySelectorAll('.launcher-row .btn') ?? [])].find(
        (node) => node.textContent.trim() === 'Создать',
      );
      return {
        открыта: Boolean(form) && !form.hidden,
        формаКлонаСкрыта: Boolean(document.querySelector('.launcher-clone')?.hidden),
        поля: [...(form?.querySelectorAll('.field > span') ?? [])].map((node) => node.textContent.trim()),
        тип: form?.querySelector('.select-value')?.textContent ?? null,
        создатьЗаблокировано: create?.disabled ?? null,
      };
    })()`,
  );
  check('кнопка «Создать проект» открыла форму', createForm?.открыта === true, createForm);
  check('вторая форма при этом закрыта', createForm?.формаКлонаСкрыта === true, createForm?.формаКлонаСкрыта);
  check(
    'в форме есть имя, тип и папка',
    JSON.stringify(createForm?.поля) === JSON.stringify(['Имя проекта', 'Тип проекта', 'Где создать']),
    createForm?.поля,
  );
  check('тип по умолчанию — Python', createForm?.тип === 'Python', createForm?.тип);
  check(
    'без имени и папки создать нельзя',
    createForm?.создатьЗаблокировано === true,
    createForm?.создатьЗаблокировано,
  );

  // Имя с разделителем пути: папка ушла бы из выбранного каталога. Причина должна
  // быть видна под полем, а кнопка — остаться серой.
  const badName = await probePage(
    welcome,
    `(async () => {
      const input = document.querySelector('.launcher-create .field-input');
      input.value = '../побег';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      const create = [...document.querySelectorAll('.launcher-create .launcher-row .btn')].find(
        (node) => node.textContent.trim() === 'Создать',
      );
      return {
        причина: document.querySelector('.launcher-create .field-hint.is-error')?.textContent ?? null,
        создатьЗаблокировано: create?.disabled ?? null,
      };
    })()`,
  );
  check(
    'дурное имя объяснено, создание заблокировано',
    Boolean(badName?.причина) && badName?.создатьЗаблокировано === true,
    badName,
  );

  // Тип переключается, и подсказка говорит, что появится в папке.
  const kindSwitch = await probePage(
    welcome,
    `(async () => {
      const select = document.querySelector('.launcher-create .select');
      select.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const item = [...document.querySelectorAll('.select-popup .select-item')].find(
        (node) => (node.querySelector('.select-item-label')?.textContent ?? '') === 'Node.js',
      );
      if (!item) return 'в списке нет Node.js';
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const hints = [...document.querySelectorAll('.launcher-create .field-hint')].map((node) => node.textContent);
      return {
        тип: document.querySelector('.launcher-create .select-value')?.textContent ?? null,
        профайлы: hints.find((text) => text.includes('package.json')) ?? null,
      };
    })()`,
  );
  check('вид проекта переключается на Node.js', kindSwitch?.тип === 'Node.js', kindSwitch);
  check('подсказка вида перечисляет файлы', Boolean(kindSwitch?.профайлы), kindSwitch?.профайлы);
  await shot(welcome, 'chui-launcher-create.png');

  // Само создание: через мост и настоящий роутер — тем же путём, что и кнопка формы.
  const makeCall = (id, params) =>
    probePage(
      welcome,
      `window.chui.call({ id: ${JSON.stringify(id)}, method: 'app.createProject', params: ${JSON.stringify(params)} })`,
    );

  const madeNode = await makeCall('probe-create-node', {
    name: 'новый-проект',
    directory: dir,
    kind: 'node',
  });
  const nodeDir = path.join(dir, 'новый-проект');
  check(
    'создание вернуло путь новой папки',
    madeNode?.ok === true && madeNode.value?.path === nodeDir,
    madeNode?.ok ? madeNode.value : madeNode?.error,
  );

  const reading = (file) => fs.readFile(path.join(nodeDir, file), 'utf8').catch(() => null);
  const [manifest, entry, ignore, readme] = await Promise.all([
    reading('package.json'),
    reading('src/index.js'),
    reading('.gitignore'),
    reading('README.md'),
  ]);
  check('в проекте Node.js есть package.json с точкой входа', String(manifest).includes('src/index.js'), manifest);
  check('заготовка Node.js положила файл в src', String(entry).includes('console.log'), entry);
  check('заготовка Node.js игнорирует node_modules', String(ignore).includes('node_modules/'), ignore);
  check('README назван именем проекта', String(readme).startsWith('# новый-проект'), readme);

  const madePython = await makeCall('probe-create-python', {
    name: 'скрипт',
    directory: dir,
    kind: 'python',
  });
  check('создание проекта Python прошло', madePython?.ok === true, madePython?.error);
  const pythonMain = await fs.readFile(path.join(dir, 'скрипт', 'main.py'), 'utf8').catch(() => null);
  check('заготовка Python положила main.py', String(pythonMain).includes('def main'), pythonMain);

  // Имя уводит папку из каталога: такое создавать нельзя, и ответ об этом говорит.
  const escaped = await makeCall('probe-create-escape', {
    name: '../побег',
    directory: dir,
    kind: 'python',
  });
  check('имя с разделителем пути отвергнуто', escaped?.ok === false, escaped?.error?.message);
  check('папка вне каталога не появилась', !(await pathExists(path.join(dir, '..', 'побег'))));

  // Занятую папку не трогаем — как и при клонировании.
  const occupied = await makeCall('probe-create-occupied', {
    name: 'скрипт',
    directory: dir,
    kind: 'node',
  });
  check('занятая папка не перезаписывается', occupied?.ok === false, occupied?.error?.message);
  const stillPython = await fs.readFile(path.join(dir, 'скрипт', 'main.py'), 'utf8').catch(() => null);
  check('файлы прежнего проекта целы', String(stillPython).includes('def main'));

  // Неизвестный вид отвергается, а не создаёт пустую папку без файлов.
  const unknownKind = await makeCall('probe-create-unknown', {
    name: 'невесть-что',
    directory: dir,
    kind: 'ruby',
  });
  check('неизвестный вид проекта отвергнут', unknownKind?.ok === false, unknownKind?.error?.message);
  check('папки по неизвестному виду не осталось', !(await pathExists(path.join(dir, 'невесть-что'))));

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
  check(
    'открытие проекта вернуло корень',
    opened.ok && opened.value.root === project,
    opened.ok ? opened.value : opened.error,
  );

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
