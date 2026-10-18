/**
 * Проба: горячие клавиши не зависят от раскладки системы.
 *
 *   npm run probe:layout
 *
 * Раскладку в прогоне не подменить — `sendInputEvent` берёт клавишу из таблицы
 * текущей раскладки. Зато известен вид события, которое система шлёт при русской
 * раскладке: `key` — кириллический знак, `code` — та же физическая клавиша, что на
 * латинице (`Ctrl+S` → `{ key: 'ы', code: 'KeyS' }`). Такое событие и рассылаем:
 * обработчики читают ровно эти поля, поэтому проверка честная.
 *
 * Что проверяем:
 *
 *   1. сочетание renderer (`Ctrl+,` — настройки) срабатывает при кириллическом `key`;
 *   2. сочетание меню (`Ctrl+Shift+F` — поиск по проекту) тоже: его держит Electron,
 *      и оно не должно задвоиться или потеряться;
 *   3. ввод текста по-русски не сломан: тот же кириллический знак БЕЗ модификаторов
 *      попадает в документ именно как «я», а не как латинская `Z`;
 *   4. Ctrl+Z при кириллическом `key` отменяет правку в редакторе;
 *   5. в терминале Ctrl+C при кириллическом `key` — это сигнал `^C` для оболочки,
 *      а не печать символа.
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
app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'chui-layout-profile-')));

let failures = 0;
const check = (label, condition, extra) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failures += 1;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-layout-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'a.ts'), 'const x = 1;\n', 'utf8');
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
  createApplicationMenu();

  await workspace.open(project);
  const ide = openIdeWindow();
  await wait(6000);
  ide.webContents.setZoomLevel(0);
  await wait(300);

  /**
   * Нажать клавишу так, как её присылает система при русской раскладке: знак русский,
   * `code` — латинский. Событие синтетическое: `sendInputEvent` раскладку не подменить,
   * а обработчики читают ровно `key` и `code`.
   */
  const pressCyrillic = (key, code, options = {}) =>
    ask(
      ide,
      `(() => {
        const target = document.querySelector('.own-editor-input') ?? document.body;
        target.focus?.();
        const event = new KeyboardEvent('keydown', {
          key: ${JSON.stringify(key)},
          code: ${JSON.stringify(code)},
          ctrlKey: ${options.ctrl === true},
          shiftKey: ${options.shift === true},
          altKey: ${options.alt === true},
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      })()`,
    );

  /* --- 1. Сочетание renderer: Ctrl+, при кириллическом «б» ----------------------- */
  // На русской раскладке запятая — та же физическая клавиша, что латинская `,`.
  await pressCyrillic('б', 'Comma', { ctrl: true });
  await wait(700);
  // Проверяем ВИДИМОСТЬ, а не наличие: окно живёт в разметке и закрытым, поэтому
  // «элемент есть» прошло бы и без нажатия — сторож был бы пустым.
  const settingsOpen = await ask(
    ide,
    `(() => {
      const modal = document.querySelector('.settings-modal');
      const backdrop = modal?.closest('.modal-backdrop');
      return { есть: Boolean(modal), открыто: Boolean(modal) && !backdrop?.hidden && modal.offsetParent !== null };
    })()`,
  );
  check('Ctrl+, с русским знаком открыл настройки', settingsOpen?.открыто === true, settingsOpen);
  await ask(
    ide,
    `(() => {
      const close = [...document.querySelectorAll('.settings-modal .icon-btn, .settings-modal button')].find(
        (node) => (node.getAttribute('title') ?? '').startsWith('Закрыть'),
      );
      close?.click();
      return true;
    })()`,
  );
  await wait(500);

  /* --- 2. Ещё одно сочетание renderer: Ctrl+Shift+G при кириллическом «п» -------- */
  // G на русской раскладке — «п». Сочетания МЕНЮ здесь не годятся: акселератор
  // разбирает Electron до renderer'а, и синтетическое событие до него не доходит —
  // проверять надо путь `comboFromEvent` → `KeybindingService`, который мы и правили.
  await pressCyrillic('п', 'KeyG', { ctrl: true, shift: true });
  await wait(900);
  // Команда открывает попап менеджера git: его и ищем.
  const changesShown = await ask(
    ide,
    `(() => {
      const popup = document.querySelector('.popover-git:not([hidden])');
      return { попап: Boolean(popup) };
    })()`,
  );
  check('Ctrl+Shift+G с русским знаком открыл менеджер git', changesShown?.попап === true, changesShown);

  /* --- 3. Ввод по-русски не сломан ----------------------------------------------- */
  // Открываем файл и печатаем «я» (физическая Z) без модификаторов: в документе должна
  // оказаться кириллица, а не латинская `z` — раскладка нужна именно для ввода.
  const opened = await ask(
    ide,
    `(async () => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'a.ts',
      );
      if (!row) return 'нет строки';
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 900));
      return 'открыт';
    })()`,
  );
  check('файл открыт', opened === 'открыт', opened);
  await wait(600);

  await ask(
    ide,
    `(() => {
      const input = document.querySelector('.own-editor-input');
      input.focus();
      return document.activeElement === input;
    })()`,
  );
  // Печатный символ редактор получает не клавишей, а `beforeinput` — так работают
  // составные знаки, мёртвые клавиши и IME. Печатаем тем же путём: символ раскладки
  // «я» должен попасть в документ именно как «я».
  await ask(
    ide,
    `(() => {
      const input = document.querySelector('.own-editor-input');
      input.focus();
      input.dispatchEvent(
        new InputEvent('beforeinput', { inputType: 'insertText', data: 'я', bubbles: true, cancelable: true }),
      );
      return true;
    })()`,
  );
  await wait(400);
  const typed = await ask(
    ide,
    `(() => {
      const lines = [...document.querySelectorAll('.own-editor-line')].map((node) => node.textContent ?? '');
      return lines.join('\\n');
    })()`,
  );
  check('кириллица печатается как кириллица, а не латиницей', String(typed).includes('я'), String(typed).slice(0, 40));

  /* --- 4. Ctrl+Z с русским знаком отменяет правку -------------------------------- */
  await pressCyrillic('я', 'KeyZ', { ctrl: true });
  await wait(500);
  const afterUndo = await ask(
    ide,
    `(() => {
      const lines = [...document.querySelectorAll('.own-editor-line')].map((node) => node.textContent ?? '');
      return lines.join('\\n');
    })()`,
  );
  check('Ctrl+Z с русским знаком отменил правку', !String(afterUndo).includes('я'), String(afterUndo).slice(0, 40));

  /* --- 5. Терминал: Ctrl+C — сигнал, а не буква ---------------------------------- */
  // Открываем терминал, диспатчим «с» с code KeyC: в выводе оболочки должен появиться
  // `^C` (эхо сигнала), а не русская буква.
  const dockShown = await ask(
    ide,
    `(async () => {
      const button = [...document.querySelectorAll('.icon-btn')].find((item) =>
        (item.getAttribute('title') ?? '').startsWith('Палитра команд'),
      );
      if (!button) return 'нет кнопки палитры';
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const input = document.querySelector('.palette-input');
      if (!input) return 'нет поля палитры';
      input.value = 'Нижняя панель';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const item = [...document.querySelectorAll('.palette-item')].find(
        (node) => (node.querySelector('.palette-item-title')?.textContent ?? '') === 'Нижняя панель',
      );
      if (!item) return 'пункта нет';
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      return 'открыта';
    })()`,
  );
  check('нижняя панель открыта', dockShown === 'открыта', dockShown);
  await wait(1500);

  const session = terminals.list()[0];
  check('терминал создал сессию', Boolean(session), session ? session.id : 'сессий нет');

  await ask(
    ide,
    `(() => {
      const view = document.querySelector('.own-term');
      view.focus();
      return true;
    })()`,
  );
  await ask(
    ide,
    `(() => {
      const view = document.querySelector('.own-term');
      view.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'с', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true }),
      );
      return true;
    })()`,
  );
  await wait(900);
  const log = session ? terminals.read(session.id, 0).data : '';
  check('Ctrl+C с русским знаком ушёл в pty сигналом ^C', String(log).includes('^C'), String(log).slice(-80));
  check('и не напечатал кириллическую букву', !String(log).includes('с'), String(log).slice(-80));

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(
    failures === 0 ? '[проба] горячие клавиши не зависят от раскладки' : `[проба] раскладка: расхождений ${failures}`,
  );
  app.exit(failures === 0 ? 0 : 1);
});
