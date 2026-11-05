/**
 * Проба горячих клавиш (п.1): «Каждое действие показывает своё сочетание,
 * сочетание кликабельно и ведёт в настройки клавиш».
 *
 *   npm run probe:shortcuts
 *
 * Проверяем в живом окне:
 *
 *  1. меню приложения показывает клавишу своего пункта;
 *  2. палитра показывает сочетание у команды, у которой оно есть;
 *  3. у команды БЕЗ сочетания палитра зовёт назначить, а не молчит;
 *  4. клик по сочетанию уводит в настройки, на раздел «Сочетания клавиш»;
 *  5. клик по сочетанию закрывает палитру — настройки не встают под неё.
 */
const { app, Menu } = require('electron');
const { mkdtempSync, promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { createApplicationMenu } = require('../dist/main/menu.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'chui-shortcuts-profile-')));
registerAppScheme();
app.on('window-all-closed', () => {});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (text) => console.log(`[проба] ${text}`);

let failed = 0;
const check = (label, condition, extra) => {
  if (!condition) failed += 1;
  const tail = extra !== undefined ? `: ${JSON.stringify(extra)}` : '';
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${tail}`);
};

const ask = (win, expression, timeoutMs = 20000) =>
  Promise.race([
    win.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

/**
 * Открыть палитру так, как это делает человек: двойным Shift. Кнопки у неё нет —
 * команда `palette.open` живёт в реестре, а не на панели.
 */
/**
 * Открыть палитру команд той же командой реестра, что и пользователь. Кнопки у
 * неё нет, а двойной Shift проверяется отдельно от этого — здесь нужен список.
 */
const OPEN_PALETTE = `(async () => {
  await window.__chui.commands.execute('palette.open');
  await new Promise((resolve) => setTimeout(resolve, 400));
  return document.querySelector('.palette-input') ? 'ок' : 'палитра не открылась';
})()`;

const READ_ROWS = `[...document.querySelectorAll('.palette-item')].map((node) => ({
  title: node.querySelector('.palette-item-title')?.textContent ?? '',
  key: node.querySelector('.palette-item-key')?.textContent ?? '',
  unbound: Boolean(node.querySelector('.palette-item-key.is-unbound')),
}))`;

/** Клик по сочетанию первой строки, у которой клавиша есть. */
const CLICK_KEY = `(async () => {
  const row = [...document.querySelectorAll('.palette-item')].find((node) => {
    const key = node.querySelector('.palette-item-key');
    return key && !key.classList.contains('is-unbound');
  });
  if (!row) return { error: 'нет строки с клавишей' };
  const title = row.querySelector('.palette-item-title')?.textContent ?? '';
  row.querySelector('.palette-item-key').click();
  await new Promise((resolve) => setTimeout(resolve, 800));
  const field = document.querySelector('.modal input');
  return {
    title,
    paletteOpen: !document.querySelector('.palette').closest('[hidden]'),
    modalOpen: document.querySelector('.modal') !== null,
    filter: field ? field.value : null,
    section: document.querySelector('.modal-nav-item.is-active')?.textContent ?? null,
  };
})()`;

app.whenReady().then(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chui-shortcuts-'));
  const project = path.join(dir, 'проект');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'a.txt'), 'привет\n', 'utf8');

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  registerIpc({
    settings,
    workspace,
    git,
    ai: new AiService(settings, workspace),
    terminals: new TerminalService((topic, payload) => pushToRenderers(topic, payload)),
    host: new HostClient(),
  });
  await workspace.open(project);
  createApplicationMenu();

  const ide = openIdeWindow();
  // Ошибки окна ловим сразу: без этого «мост undefined» не отличить от «окно
  // упало на монтировании».
  ide.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) step(`окно, ошибка: ${message.slice(0, 300)}`);
  });
  await wait(6000);
  // Мост `__chui` включается АДРЕСОМ: `localStorage` не переживает перезагрузку
  // на `app://` ( хранилище живёт по origin, а reload стартует заново), и флаг
  // в нём тихо терялся — проба спрашивала `undefined` и винила приложение.
  const url = ide.webContents.getURL();
  step(`окно: ${url}`);
  await ide.loadURL(url.includes('?') ? `${url}&probe=1` : `${url}?probe=1`);
  await wait(6000);
  step(`мост проб: ${await ask(ide, "typeof window.__chui")} / search: ${await ask(ide, 'location.search')}`);

  /* --- 1. Меню -------------------------------------------------------------- */
  const viewMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === 'Вид');
  const sidebar = viewMenu?.submenu?.items.find((item) => item.label === 'Боковая панель');
  check('меню: у «Боковая панель» есть клавиша', sidebar?.accelerator === 'Ctrl+B', sidebar?.accelerator);

  /* --- 2. Палитра: сочетания ----------------------------------------------- */
  step(`открываю палитру: ${await ask(ide, OPEN_PALETTE)}`);
  const rows = await ask(ide, READ_ROWS);
  const list = Array.isArray(rows) ? rows : [];
  const withKey = list.filter((row) => row.key && !row.unbound);
  const unbound = list.filter((row) => row.unbound);
  check('палитра: сочетания видны у команд', withKey.length > 0, withKey.length);
  check('палитра: у команды без клавиши — зовём назначить', unbound.length > 0, unbound[0]?.title);
  check(
    'палитра: подпись у команды без клавиши',
    unbound.every((row) => row.key.includes('назначить')),
    unbound[0]?.key,
  );

  /* --- 3. Клик по сочетанию ------------------------------------------------ */
  const clicked = await ask(ide, CLICK_KEY);
  check('клик по сочетанию закрыл палитру', clicked?.paletteOpen === false, clicked);
  check('клик по сочетанию открыл настройки', clicked?.modalOpen === true, clicked?.modalOpen);
  check('раздел — «Сочетания клавиш»', String(clicked?.section ?? '').includes('Сочетания'), clicked?.section);

  const shot = path.join(dir, 'shortcuts.png');
  try {
    await fs.writeFile(shot, (await ide.webContents.capturePage()).toPNG());
    step(`снимок: ${shot}`);
  } catch (error) {
    step(`снимок не сделался: ${error.message}`);
  }

  if (failed === 0) step('всё сошлось');
  app.exit(failed === 0 ? 0 : 1);
});
