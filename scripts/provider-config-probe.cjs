/**
 * Проба окна подключения провайдера.
 *
 *   npx electron scripts/provider-config-probe.cjs
 *
 * Проходит путь человека в живом окне: Настройки → AI → селект «Добавить
 * провайдера» → DeepSeek → окно подключения (адрес, ключ, модель) → «Сохранить».
 * Сеть не нужна: сохранение подключение не проверяет, «Проверить подключение»
 * здесь не нажимается.
 *
 * Нужен собранный main и renderer (npm run build).
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { McpService } = require('../dist/main/mcp/mcp.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();

let failed = false;
const check = (label, condition, extra) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

/** Открыть настройки тем же путём, что и человек: Файл → Настройки…. */
const OPEN_SETTINGS = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const items = () => [...document.querySelectorAll('.context-menu [role^="menuitem"]')];
  document.querySelector('.topbar-left .icon-btn')?.click();
  await wait(300);
  const file = items().find((node) => (node.textContent || '').trim().startsWith('Файл'));
  if (!file) return 'меню не открылось';
  file.click();
  await wait(300);
  const settings = items().find((node) => (node.textContent || '').trim().startsWith('Настройки'));
  if (!settings) return 'пункта настроек нет';
  settings.click();
  await wait(800);
  return document.querySelector('.modal-pane') ? 'открыт' : 'окно не открылось';
})()`;

/** Раздел «AI»: подключение к провайдеру живёт в нём. */
const OPEN_AI = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nav = [...document.querySelectorAll('.modal-nav-item')].find((node) =>
    /^\\s*AI\\b/.test(node.textContent || ''),
  );
  if (!nav) return 'раздела AI нет';
  nav.click();
  await wait(500);
  return document.querySelector('.modal-pane')?.textContent || '';
})()`;

/** Строка «Добавить провайдера»: в ней селект, а не кнопка с меню. */
const READ_ROW = `(() => {
  const pane = document.querySelector('.modal-pane');
  const field = [...(pane?.querySelectorAll('.field') ?? [])].find(
    (node) => (node.querySelector(':scope > span')?.textContent || '').trim() === 'Добавить провайдера',
  );
  if (!field) return { есть: false };
  const select = field.querySelector('button.select');
  return {
    есть: true,
    селект: select !== null,
    роль: select?.getAttribute('role') ?? null,
    подсказка: (select?.querySelector('.select-value')?.textContent || '').trim(),
  };
})()`;

/** Открыть список селекта и прочитать пункты. */
const OPEN_LIST = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pane = document.querySelector('.modal-pane');
  const field = [...pane.querySelectorAll('.field')].find(
    (node) => (node.querySelector(':scope > span')?.textContent || '').trim() === 'Добавить провайдера',
  );
  field?.querySelector('button.select')?.click();
  await wait(400);
  const popup = document.querySelector('.select-popup');
  if (!popup) return { откр: false };
  return {
    откр: true,
    роль: popup.getAttribute('role'),
    пункты: [...popup.querySelectorAll('.select-item')].map((node) => ({
      подпись: (node.querySelector('.select-item-label')?.textContent || '').trim(),
      подсказка: (node.querySelector('.select-item-hint')?.textContent || '').trim(),
    })),
  };
})()`;

/** Выбрать первый пункт — должно открыться окно подключения. */
const PICK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  document.querySelector('.select-popup .select-item')?.click();
  await wait(600);
  const view = document.querySelector('.provider-config-modal');
  if (!view) return { окно: false };
  const inputOf = (label) => {
    const field = [...view.querySelectorAll('.field')].find(
      (node) => (node.querySelector(':scope > span')?.textContent || '').trim() === label,
    );
    return field?.querySelector('input')?.value ?? null;
  };
  return {
    окно: true,
    заголовок: (view.querySelector('.modal-title')?.textContent || '').trim(),
    подписи: [...view.querySelectorAll('.field > span')].map((node) => (node.textContent || '').trim()),
    адрес: inputOf('Адрес API'),
    естьПароль: view.querySelector('input[type="password"]') !== null,
    модели: [...view.querySelectorAll('.field')]
      .filter((node) => (node.querySelector(':scope > span')?.textContent || '').trim() === 'Модель')
      .flatMap((node) =>
        [...node.querySelectorAll('.select-value')].map((item) => (item.textContent || '').trim()),
      ),
    кнопки: [...view.querySelectorAll('.modal-footer button')].map((node) => (node.textContent || '').trim()),
  };
})()`;

/** «Сохранить»: окно закрывается, панель показывает подключение. */
const SAVE = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const view = document.querySelector('.provider-config-modal');
  const save = [...view.querySelectorAll('.modal-footer button')].find(
    (node) => (node.textContent || '').trim() === 'Сохранить',
  );
  save?.click();
  await wait(900);
  return {
    окно: document.querySelectorAll('.provider-config-modal').length,
    панель: (document.querySelector('.modal-pane')?.textContent || '').includes('Подключение: DeepSeek'),
    // Поля подключения уехали в окно: в панели их не должно быть вовсе.
    поляПодключения: [
      'Адрес API',
      'API-ключ',
      'Модель',
      'Температура',
      'Максимум токенов ответа',
      'Усилие размышления',
    ].filter((label) =>
      [...(document.querySelector('.modal-pane')?.querySelectorAll('.field > span') ?? [])].some(
        (node) => (node.textContent || '').trim() === label,
      ),
    ),
  };
})()`;

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-provider-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'src', 'index.js'), 'console.log(1);\n', 'utf8');

  serveRenderer();

  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  const mcp = new McpService(
    () => settings.get().ai.mcpServers,
    () => workspace.rootPath(),
  );
  registerIpc({ settings, workspace, ai, terminals, git, mcp, host: new HostClient() });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  const opened = await ask(ide, OPEN_SETTINGS);
  check('настройки открылись', opened === 'открыт', opened);

  const pane = await ask(ide, OPEN_AI);
  check('раздел AI доступен', typeof pane === 'string' && pane.includes('Провайдер'), String(pane).slice(0, 60));

  /* ── строка: селект, а не кнопка с меню ─────────────────────────────────── */

  const row = await ask(ide, READ_ROW);
  check('строка «Добавить провайдера» на месте', row?.есть === true, row);
  check('в строке селект', row?.селект === true, row);
  check('селект — это combobox', row?.роль === 'combobox', row?.роль);
  check('пока ничего не выбрано — видна подсказка', row?.подсказка === 'Выберите провайдера…', row?.подсказка);

  const shots = path.join(__dirname, '..', '.chui_ide', 'probe-shots');
  await fs.mkdir(shots, { recursive: true });
  await fs.writeFile(path.join(shots, 'provider-add-row.png'), (await ide.capturePage()).toPNG());
  console.log('  снимок: .chui_ide/probe-shots/provider-add-row.png');

  /* ── список селекта ─────────────────────────────────────────────────────── */

  const list = await ask(ide, OPEN_LIST);
  check('список открылся по клику', list?.откр === true, list);
  check('список — listbox', list?.роль === 'listbox', list?.роль);
  const names = (list?.пункты ?? []).map((item) => item.подпись);
  check('в списке DeepSeek', names.length === 1 && names[0] === 'DeepSeek', names);

  await fs.writeFile(path.join(shots, 'provider-add-list.png'), (await ide.capturePage()).toPNG());
  console.log('  снимок: .chui_ide/probe-shots/provider-add-list.png');

  /* ── окно подключения ───────────────────────────────────────────────────── */

  const view = await ask(ide, PICK);
  check('выбор открыл окно подключения', view?.окно === true, view);
  check('заголовок называет провайдера', view?.заголовок === 'Подключение: DeepSeek', view?.заголовок);
  check(
    'в окне поля этого провайдера',
    JSON.stringify(view?.подписи) ===
      JSON.stringify([
        'Название',
        'Адрес API',
        'API-ключ',
        'Модель',
        'Или id модели вручную',
        'Метка пользователя',
        'Строгая схема аргументов',
        'Усилие размышления',
        'Температура',
        'Максимум токенов ответа',
      ]),
    view?.подписи,
  );
  check('адрес подставлен из пресета', view?.адрес === 'https://api.deepseek.com/v1', view?.адрес);
  check('ключ спрашивают затемнённым полем', view?.естьПароль === true, view?.естьПароль);
  // Имена deepseek-chat и deepseek-reasoner отключены провайдером 24.07.2026:
  // пресет обязан предлагать те, что API принимает сегодня.
  check('модель выбрана из пресета', (view?.модели ?? []).includes('deepseek-flash'), view?.модели);
  check(
    'кнопки: проверить, отмена, сохранить',
    JSON.stringify(view?.кнопки) === JSON.stringify(['Проверить подключение', 'Отмена', 'Сохранить']),
    view?.кнопки,
  );

  await fs.writeFile(path.join(shots, 'provider-config-modal.png'), (await ide.capturePage()).toPNG());
  console.log('  снимок: .chui_ide/probe-shots/provider-config-modal.png');

  /* ── сохранение ─────────────────────────────────────────────────────────── */

  const saved = await ask(ide, SAVE);
  check('после сохранения окно закрылось', saved?.окно === 0, saved?.окно);
  check('панель показывает это подключение', saved?.панель === true, saved?.панель);
  check(
    'в панели не осталось полей подключения — они в окне',
    saved?.поляПодключения.length === 0,
    saved?.поляПодключения,
  );

  const stored = settings.get().ai;
  check(
    'у подключения адрес DeepSeek',
    stored.providers[0]?.baseUrl === 'https://api.deepseek.com/v1',
    stored.providers[0]?.baseUrl,
  );
  check('модель записана', stored.providers[0]?.defaultModel === 'deepseek-flash', stored.providers[0]?.defaultModel);
  check('подключение стало активным', stored.activeProviderId === 'deepseek', stored.activeProviderId);
  check('провайдер не задвоился', stored.providers.length === 1, stored.providers.length);
  // Параметры генерации — часть подключения: сохранены там же, а не в общих.
  // Температура приходит умолчанием из раздела AI; лимит ответа по умолчанию 0 —
  // «предел модели», и такой ноль в подключение не пишем.
  check(
    'температура легла в подключение',
    typeof stored.providers[0]?.temperature === 'number',
    stored.providers[0]?.temperature,
  );
  check(
    'лимит ответа по умолчанию — по модели, а не ноль',
    stored.providers[0]?.maxTokens === undefined,
    stored.providers[0]?.maxTokens,
  );
  check(
    'усилие размышления сохранилось',
    stored.providers[0]?.reasoningEffort !== undefined,
    stored.providers[0]?.reasoningEffort,
  );

  await fs.writeFile(path.join(shots, 'provider-settings.png'), (await ide.capturePage()).toPNG());
  console.log('  снимок: .chui_ide/probe-shots/provider-settings.png');

  console.log(failed === 0 ? '\nокно подключения: селект, поля и сохранение на месте' : `\nпровалов: ${failed}`);
  app.exit(failed ? 1 : 0);
});
