/**
 * Проба ввода терминала: вставка из буфера и подпись вкладки.
 *
 *   npm run probe:terminal
 *
 * Терминал — не поле ввода, поэтому браузер не присылает ему ни `paste`, ни текст для
 * `Ctrl+V`: комбинацию ловит сама панель. Проверяем это в живом окне и по-настоящему:
 * кладём текст в буфер обмена, жмём `Ctrl+V` (`sendInputEvent`, а не синтетическое
 * событие) и смотрим, что pty получил вставку — оболочка выполнила команду.
 *
 * Вторая половина — подпись вкладки: оболочка называет окно приглашением целиком
 * (`user@host: ~/путь/до/проекта`), и такая строка растягивала полосу дока. Теперь
 * в подписи — последний сегмент пути, полное имя — в подсказке вкладки.
 *
 * Нужен собранный main и renderer (npm run build). Отчёт — вывод в консоль,
 * снимок — `.chui_ide/probe-shots/terminal-input-*.png`.
 */
const { app, clipboard } = require('electron');
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

const SHOTS = path.join(__dirname, '..', '.chui_ide', 'probe-shots');
async function shot(window, name) {
  await window.webContents
    .executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))')
    .catch(() => undefined);
  const image = await window.capturePage();
  const file = path.join(SHOTS, `terminal-input-${name}.png`);
  await fs.writeFile(file, image.toPNG());
  return file;
}

/** Нажать клавишу в окне по-настоящему: событие проходит так же, как от человека. */
function press(window, keyCode, modifiers = []) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

app.whenReady().then(async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-term-input-probe-')));
  // Путь глубокий нарочно: приглашение оболочки в таком каталоге не влезает в полосу.
  const project = path.join(dir, 'demo', 'PROJECTS', 'GITHUB', 'chui_ide');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), '# demo\n', 'utf8');
  await fs.mkdir(SHOTS, { recursive: true });

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
  await wait(6000);

  /* ── открыть панель терминала ─────────────────────────────────────────── */

  // Нижняя панель по умолчанию скрыта. Открываем её тем же путём, что человек:
  // через палитру команд («Нижняя панель» — Alt+F12).
  const opened = await ask(
    ide,
    `(async () => {
      const button = [...document.querySelectorAll('.icon-btn')].find((item) =>
        (item.getAttribute('title') ?? '').startsWith('Палитра команд'),
      );
      if (!button) return 'нет кнопки палитры';
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
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
      await new Promise((resolve) => setTimeout(resolve, 600));
      return 'открыта';
    })()`,
  );
  check('нижняя панель открыта через палитру', opened === 'открыта', opened);
  await wait(2000);

  const session = terminals.list()[0];
  check('терминал создал сессию', Boolean(session), session ?? 'сессий нет');

  /* ── вставка из буфера ────────────────────────────────────────────────── */

  // Маркер собирается из двух кусков: набранный текст содержит их по отдельности,
  // поэтому «PASTE-OK» в выводе значит именно «команда выполнилась».
  const PASTED = 'printf "PASTE-%s" OK';
  clipboard.writeText(PASTED);

  const focused = await ask(
    ide,
    `(() => {
      const view = document.querySelector('.own-term');
      if (!view) return 'нет полотна терминала';
      view.focus();
      return document.activeElement === view ? 'в фокусе' : String(document.activeElement?.className ?? 'другой');
    })()`,
  );
  check('полотно терминала в фокусе', focused === 'в фокусе', focused);

  press(ide, 'v', ['control']);
  await wait(500);
  // Enter — отдельным нажатием: вставляем текст, а не перевод строки.
  press(ide, 'Return');
  await wait(1500);

  const log = session ? terminals.read(session.id, 0).data : '';
  check('Ctrl+V довёл текст до оболочки и она его выполнила', log.includes('PASTE-OK'), {
    хвост: log.slice(-160),
  });
  // До починки комбинация уходила в pty управляющим кодом quoted-insert (`\x16`),
  // и оболочка ждала следующий знак вместо вставки.
  check('в pty не ушёл управляющий символ вставки', !log.includes('\u0016'));

  /* ── подпись вкладки ──────────────────────────────────────────────────── */

  // Имя окна задаёт программа: печатаем такое же приглашение, как bash в длинном
  // каталоге. Терминал разберёт OSC 0 и применит имя к вкладке.
  const fullTitle = 'dethmond@LOQ: ~/PROJECTS/GITHUB/chui_ide';
  if (session) terminals.write(session.id, `printf '\\033]0;${fullTitle}\\007'\r`);
  await wait(1500);

  const tab = await ask(
    ide,
    `(() => {
      const node = document.querySelector('.term-tab');
      if (!node) return null;
      const style = getComputedStyle(node);
      const strip = node.closest('.term-tabs');
      return {
        подпись: node.textContent ?? '',
        подсказка: node.getAttribute('title') ?? '',
        maxWidth: style.maxWidth,
        обрезка: style.textOverflow,
        ширина: Math.round(node.getBoundingClientRect().width),
        прокруткаПолосы: strip ? strip.scrollWidth > strip.clientWidth : null,
      };
    })()`,
  );
  check(
    'подпись вкладки укорочена до одного каталога',
    typeof tab?.подпись === 'string' && tab.подпись.endsWith('chui_ide') && !tab.подпись.includes('/'),
    tab?.подпись,
  );
  // Полное имя окна не теряется: оно уходит в подсказку вкладки. Имя задаёт оболочка
  // в приглашении — к этому месту его перебивает уже сам bash (абсолютным путём).
  check(
    'полное имя окна осталось в подсказке вкладки',
    typeof tab?.подсказка === 'string' && tab.подсказка.endsWith(project),
    tab?.подсказка,
  );
  check(
    'вкладка ограничена по ширине и обрезается многоточием',
    tab?.maxWidth === '200px' && tab?.обрезка === 'ellipsis',
    { maxWidth: tab?.maxWidth, обрезка: tab?.обрезка },
  );
  check('полоса вкладок не уехала в прокрутку', tab?.прокруткаПолосы === false, tab?.прокруткаПолосы);

  /* ── шаг полосы дока ──────────────────────────────────────────────────── */

  // Шапка дока и тулбар терминала живут в одной полосе: у обоих шаг 3 px и отступ 3 px,
  // а высоту даёт содержимое, а не число. Иначе тулбар выпирал из шапки, а вкладки
  // терминала сидели на пиксель иначе, чем вкладки дока.
  const strip = await ask(
    ide,
    `(() => {
      const header = document.querySelector('.dock-header');
      const toolbar = document.querySelector('.term-toolbar');
      if (!header || !toolbar) return null;
      const h = getComputedStyle(header);
      const t = getComputedStyle(toolbar);
      return {
        шапкаВысота: Math.round(header.getBoundingClientRect().height),
        тулбарВысота: Math.round(toolbar.getBoundingClientRect().height),
        шапкаHeight: h.height,
        шапкаОтступ: h.padding,
        тулбарОтступ: t.padding,
        шапкаШаг: h.gap,
        тулбарШаг: t.gap,
      };
    })()`,
  );
  check(
    'шапка дока и тулбар терминала — один шаг 3 px',
    strip !== null &&
      strip.шапкаШаг === '3px' &&
      strip.тулбарШаг === '3px' &&
      strip.шапкаОтступ === '3px' &&
      strip.тулбарОтступ === '3px',
    strip && {
      шапкаШаг: strip.шапкаШаг,
      тулбарШаг: strip.тулбарШаг,
      шапкаОтступ: strip.шапкаОтступ,
      тулбарОтступ: strip.тулбарОтступ,
    },
  );
  // Высота не задана числом: computed `height` у элемента в раскладке всё равно
  // вернётся в пикселях, поэтому проверяем факт — шапка и тулбар одной высоты
  // (кроме пикселя рамки под шапкой).
  check(
    'высота шапки — по содержимому, как у тулбара',
    strip !== null && Math.abs(strip.шапкаВысота - strip.тулбарВысота - 1) <= 1,
    strip && { шапка: strip.шапкаВысота, тулбар: strip.тулбарВысота },
  );

  console.log(`  снимок: ${await shot(ide, 'tab')}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(
    failed
      ? '[проба] ввод терминала: есть расхождения'
      : '[проба] вставка из буфера работает, подпись вкладки укорочена',
  );
  app.exit(failed ? 1 : 0);
});
