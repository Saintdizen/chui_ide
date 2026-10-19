/**
 * Проба встроенного браузера: страница открывается вкладкой рядом с кодом.
 *
 *   npm run probe:browser-view
 *
 * Поднимаем настоящий http-сервер с маленьким сайтом (три страницы и ссылка между
 * ними) и открываем его в окне IDE так, как это делает человек: палитра команд →
 * «Открыть страницу…» → адрес в диалоге → Enter. Смотрим не «как выглядит», а факты:
 *
 *  1. команда открывает вкладку: страница встаёт в полосу вкладок, а полотно
 *     редактора уступает ей (`.is-browser` на острове);
 *  2. вложение действительно загрузило адрес: заголовок и текст читаем ИЗ САМОГО
 *     вложения (`panel.contents(id)`), а не из нашего интерфейса;
 *  3. гостю не отдано ничего лишнего: в странице нет ни `require`, ни `process` —
 *     за это отвечает раздел сессии и флаги вложения в `main/browser/panel.ts`;
 *  4. переход по ссылке внутри страницы тянет за собой и подпись вкладки, и
 *     адресную строку (`did-navigate` → модель вкладок → полоса);
 *  5. вторая страница — вторая вкладка, и у каждой СВОЁ вложение: первая к тому
 *     моменту на другом адресе, то есть история и состояние не общие;
 *  6. `file:` открывать отказывается: сказано почему, а вкладки не появляется;
 *  7. закрытие вкладки убирает вложение из дерева окна — гость не остаётся жить.
 *
 * Дополнительно проверяем проводку меню: пункт «Вид → Открыть страницу…» есть в
 * системном меню и держит `Ctrl+Shift+B` (сама клавиша живёт в меню Electron, а не
 * в renderer, поэтому нажатие подделать нельзя — проверяем сам пункт).
 *
 * Отдельно — два места, где вложение мешает обычной работе окна, потому что лежит
 * слоем ПОВЕРХ DOM: клик по вкладке файла убирает страницу с экрана (даже если файл
 * и так был активным документом — модель вкладок о том молчит), а открытое меню-панель
 * (`.context-menu`) на время прячет вложение, иначе меню уходило бы под страницу.
 *
 * Ещё два сторожа — про возврат и про агента:
 *
 *  • после ухода на другую вкладку и возврата страница обязана СНОВА РИСОВАТЬСЯ и
 *    стоять ровно в текущем размере области. Раньше вложение на возврате отцепляли
 *    и прицепляли заново — и слой переставал рисоваться: вкладка открывалась пустой.
 *    Поэтому скрытие — это `View.setVisible(false)`, а видимость спрашиваем у panel;
 *  • агент действует на странице — человек должен это видеть: метка в шапке страницы
 *    и точка на вкладке, обе гаснут сами.
 *
 * Снимок окна — `.chui_ide/probe-shots/browser-view.png`. Саму страницу на нём
 * не видно (вложение — отдельный слой окна), поэтому содержимое пробник читает
 * у вложения, а снимок нужен для шапки и полосы вкладок.
 * Нужен собранный код: `npm run build` (скрипт делает это сам).
 */
const { app, Menu } = require('electron');
const http = require('node:http');
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
const { getIdeWindow, openIdeWindow } = require('../dist/main/window.js');
const { BrowserPanel } = require('../dist/main/browser/panel.js');
const { AgentBrowser } = require('../dist/main/browser/agent-browser.js');

const PROJECT = path.join(__dirname, '..');
const SHOTS = path.join(PROJECT, '.chui_ide', 'probe-shots');

// Профиль свой: проба не должна ни делить замок с запущенной IDE
// (`requestSingleInstanceLock`), ни трогать настройки разработчика.
app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'chui-browser-view-profile-')));

registerAppScheme();
// Проба сама решает, когда выходить: окно закроется раньше, а Electron без окон завершает работу.
app.on('window-all-closed', () => {});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (text) => console.log(`[проба] ${text}`);

let failed = 0;
const check = (label, condition, extra) => {
  if (!condition) failed += 1;
  const tail = extra !== undefined ? `: ${JSON.stringify(extra)}` : '';
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${tail}`);
};

/** Ждать, пока условие станет истинным. `null` — не дождались. */
const waitFor = async (probe, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await wait(150);
  }
};

const ask = (win, expression, timeoutMs = 20000) =>
  Promise.race([
    win.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

/* --- Сайт для проверки: три страницы, ссылка между ними, счётчик на кнопке -------- */

const HOME = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Домашняя страница</title></head>
<body>
  <h1>Маленький сайт</h1>
  <p>Эта страница открыта во встроенном браузере IDE.</p>
  <p><button id="count" onclick="document.getElementById('out').textContent = 'нажатий: 1'">Нажать</button></p>
  <p id="out"></p>
  <p><a id="next" href="/about">О странице</a></p>
</body></html>`;

const ABOUT = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>О странице</title></head>
<body><h1>Вторая страница</h1><p><a href="/">На главную</a></p></body></html>`;

const THIRD = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Третья страница</title></head>
<body><h1>Третья страница</h1><p>Пришла своим адресом.</p></body></html>`;

const POPUP = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Всплывающая</title></head>
<body><h1>Всплывающая</h1><p>Открылась новой вкладкой.</p>
<script>console.log('привет из страницы'); console.warn('предупреждение из страницы');</script>
</body></html>`;

/* --- Снимок интерфейса: то, что видит человек ------------------------------------ */

const UI_STATE = `(() => {
  const view = document.querySelector('.browser-view');
  const tabs = [...document.querySelectorAll('.tab-page')];
  const back = [...document.querySelectorAll('.browser-toolbar button')].find(
    (item) => item.getAttribute('title') === 'Назад',
  );
  return {
    панель: view ? !view.hidden : false,
    полотно: document.querySelector('.editor-island')?.classList.contains('is-browser') ?? false,
    вкладки: tabs.map((tab) => tab.querySelector('.tab-label')?.textContent ?? ''),
    активная: tabs.find((tab) => tab.classList.contains('is-active'))?.querySelector('.tab-label')?.textContent ?? null,
    адрес: document.querySelector('.browser-address')?.value ?? null,
    назадВключена: back ? !back.disabled : null,
    уведомление: document.querySelector('.toast-text')?.textContent ?? null,
  };
})()`;

app.whenReady().then(async () => {
  step('старт');
  await fs.mkdir(SHOTS, { recursive: true });

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-browser-view-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'note.txt'), 'файл рядом со страницей\n', 'utf8');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const page = req.url === '/about' ? ABOUT : req.url === '/third' ? THIRD : req.url === '/popup' ? POPUP : HOME;
    res.end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  step(`сайт поднят: ${base}`);

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  // Панель встроенного браузера держит вложения (`WebContentsView`). Пробе она нужна
  // как своим глазам: страницу рисует не renderer, и снимок окна её не покажет —
  // содержимое читаем прямо из вложения.
  const panel = new BrowserPanel({
    window: () => getIdeWindow(),
    notify: (topic, payload) => pushToRenderers(topic, payload),
    openExternal: () => undefined,
  });
  registerIpc({ settings, workspace, ai, terminals, git, host: new HostClient(), browserPanel: panel });
  await workspace.open(project);

  // Меню собираем так же, как приложение: пункт «Открыть страницу…» — это его клавиша.
  createApplicationMenu();

  const ide = openIdeWindow();
  await wait(6000);

  /* --- 1. Меню: пункт и клавиша -------------------------------------------------- */
  const viewMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === 'Вид');
  const pageItem = viewMenu?.submenu?.items.find((item) => item.label === 'Открыть страницу…');
  check('меню: «Вид → Открыть страницу…» есть', pageItem !== undefined, pageItem?.label);
  check('меню: клавиша пункта — Ctrl+Shift+B', pageItem?.accelerator === 'Ctrl+Shift+B', pageItem?.accelerator);

  /** Открыть адрес как человек: палитра → «Открыть страницу…» → адрес → Enter. */
  const openUrl = async (url) => {
    const result = await ask(
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
        input.value = 'страница';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        const item = [...document.querySelectorAll('.palette-item')].find((node) =>
          (node.querySelector('.palette-item-title')?.textContent ?? '').startsWith('Открыть страницу'),
        );
        if (!item) {
          return 'пункта нет: ' + [...document.querySelectorAll('.palette-item-title')].map((n) => n.textContent).join(' | ');
        }
        item.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const field = document.querySelector('.prompt-modal .field-input');
        if (!field) return 'нет диалога адреса';
        field.value = ${JSON.stringify(url)};
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 'адрес принят';
      })()`,
    );
    step(`открываю ${url}: ${result}`);
    return result;
  };

  const guests = () =>
    panel
      .ids()
      .map((id) => panel.contents(id))
      .filter((item) => item !== null);
  const guestAt = (url) => guests().find((item) => item.getURL().startsWith(url));
  /** Нажать кнопку шапки, как это делает человек: по подписи в подсказке. */
  const pressToolbar = (title) =>
    ask(
      ide,
      `(() => {
        const button = [...document.querySelectorAll('.browser-toolbar button')].find(
          (item) => item.getAttribute('title') === ${JSON.stringify(title)},
        );
        if (!button) return 'нет кнопки';
        if (button.disabled) return 'выключена';
        button.click();
        return 'нажата';
      })()`,
    );
  /** Прочитать страницу ИЗ вложения: так проверка не верит интерфейсу на слово. */
  const readGuest = async (guest) => ({
    заголовок: guest.getTitle(),
    адрес: guest.getURL(),
    текст: String(await guest.executeJavaScript('document.body.innerText'))
      .replace(/\s+/g, ' ')
      .trim(),
    require: await guest.executeJavaScript('typeof require'),
    process: await guest.executeJavaScript('typeof process'),
  });
  /** Открыть файл проекта кликом по строке дерева — как это делает человек. */
  const openFile = (name) =>
    ask(
      ide,
      `(async () => {
        const row = [...document.querySelectorAll('.tree-row')].find(
          (item) => item.querySelector('.tree-name')?.textContent === ${JSON.stringify(name)},
        );
        if (!row) return 'нет строки';
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 900));
        return 'открыт';
      })()`,
    );
  /** Нажать вкладку страницы — так показываем её поверх активного файла. */
  const clickPageTab = () =>
    ask(
      ide,
      `(() => {
        const tab = document.querySelector('.tab-page');
        if (!tab) return 'нет вкладки';
        tab.click();
        return 'нажата';
      })()`,
    );
  /** Нажать вкладку файла по подписи. */
  const clickFileTab = (name) =>
    ask(
      ide,
      `(() => {
        const tab = [...document.querySelectorAll('.tab[data-kind=file]')].find(
          (t) => (t.querySelector('.tab-label')?.textContent ?? '') === ${JSON.stringify(name)},
        );
        if (!tab) return 'нет вкладки';
        tab.click();
        return 'нажата';
      })()`,
    );
  /** Ключ вкладки, которой принадлежит вложение. */
  const idOf = (contents) => panel.ids().find((id) => panel.contents(id) === contents) ?? null;
  /** Какие вложения рисуются СЕЙЧАС: скрытое живёт в дереве окна, но не видно. */
  const drawn = () => panel.ids().filter((id) => panel.isShown(id));

  /* --- 2. Первая страница -------------------------------------------------------- */
  check('у палитры есть пункт «Открыть страницу…»', (await openUrl(base)) === 'адрес принят');
  const first = await waitFor(() => guestAt(base));
  check('вложение создано и загрузило адрес', first !== null, first?.getURL());
  const loaded = first ? await waitFor(() => first.getTitle() === 'Домашняя страница' && first) : null;
  check('заголовок пришёл со страницы', loaded !== null, first?.getTitle());

  const home = first ? await readGuest(first) : { текст: '' };
  check('текст страницы прочитан из вложения', home.текст.includes('Маленький сайт'), home.текст.slice(0, 60));
  check('гость без Node: нет require', home.require === 'undefined', home.require);
  check('гость без Node: нет process', home.process === 'undefined', home.process);

  const uiAfterOpen = await ask(ide, UI_STATE);
  check('полотно редактора уступило странице', uiAfterOpen.полотно === true, uiAfterOpen.полотно);
  check('вложение в дереве одно', panel.ids().length === 1, panel.ids());
  check('в полосе вкладка страницы', uiAfterOpen.вкладки.length === 1, uiAfterOpen.вкладки);
  check('подпись вкладки — заголовок страницы', uiAfterOpen.вкладки[0] === 'Домашняя страница', uiAfterOpen.вкладки[0]);
  check('адресная строка показывает адрес', uiAfterOpen.адрес === `${base}/`, uiAfterOpen.адрес);

  /* --- 2.1. Кнопка в шапке ------------------------------------------------------- */
  // Кнопка открытия страницы стоит в шапке после переключателей раскладки и своего
  // разделителя. Проверяем и место, и что она подсвечена, пока страница показана.
  const topbar = await ask(
    ide,
    `(() => {
      const left = [...document.querySelectorAll('.topbar-left > *')];
      const button = left.find((node) => node.tagName === 'BUTTON' && (node.title ?? '').startsWith('Открыть страницу'));
      const index = left.indexOf(button);
      return {
        есть: Boolean(button),
        подсказка: button?.title ?? null,
        подсвечена: button?.classList.contains('is-active') ?? false,
        послеРазделителя: index > 0 && left[index - 1]?.classList.contains('topbar-sep') === true,
        порядок: left.map((node) => (node.tagName === 'SPAN' ? '|' : (node.title ?? '').slice(0, 12))),
      };
    })()`,
  );
  check('в шапке есть кнопка «Открыть страницу»', topbar.есть === true, topbar.подсказка);
  check('она отделена своим разделителем', topbar.послеРазделителя === true, topbar.порядок);
  check('пока страница показана — кнопка подсвечена', topbar.подсвечена === true, topbar.подсвечена);

  /* --- 3. Чужая схема: file: ------------------------------------------------------ */
  await openUrl('file:///etc/passwd');
  await wait(700);
  const uiAfterFile = await ask(ide, UI_STATE);
  check('file: вкладки не открыл', uiAfterFile.вкладки.length === 1, uiAfterFile.вкладки);
  check('file: вложений не прибавил', panel.ids().length === 1, panel.ids());
  check('file: сказано почему', /http/i.test(uiAfterFile.уведомление ?? ''), uiAfterFile.уведомление);

  /* --- 4. Переход по ссылке внутри страницы -------------------------------------- */
  const clicked = first
    ? await first.executeJavaScript("document.getElementById('next').click(); 'клик'")
    : 'нет вложения';
  check('ссылка нажата в самой странице', clicked === 'клик', clicked);
  const onAbout = first ? await waitFor(() => first.getURL().endsWith('/about') && first) : null;
  check('страница ушла на второй адрес', onAbout !== null, first?.getURL());
  const uiAfterLink = await waitFor(async () => {
    const state = await ask(ide, UI_STATE);
    return state.вкладки[0] === 'О странице' ? state : null;
  });
  check('подпись вкладки пошла за страницей', uiAfterLink !== null, uiAfterLink?.вкладки);
  check('адресная строка пошла за страницей', uiAfterLink?.адрес === `${base}/about`, uiAfterLink?.адрес);
  // Кнопки обновляются по своему событию загрузки — ждём его, а не первый же снимок.
  const backEnabled = await waitFor(async () => (await ask(ide, UI_STATE)).назадВключена === true);
  check('кнопка «Назад» ожила после перехода', backEnabled === true, backEnabled);
  // Живая кнопка ещё ничего не значит: у Electron 44 `canGoBack()/goBack()` врут,
  // поэтому шаг идёт по индексу истории — проверяем, что возврат СОСТОЯЛСЯ.
  check('нажатие «Назад»', (await pressToolbar('Назад')) === 'нажата');
  const backHome = first ? await waitFor(() => first.getURL() === `${base}/` && first) : null;
  check('«Назад» вернула на прежний адрес', backHome !== null, first?.getURL());
  check('нажатие «Вперёд»', (await pressToolbar('Вперёд')) === 'нажата');
  const forwardAgain = first ? await waitFor(() => first.getURL().endsWith('/about') && first) : null;
  check('«Вперёд» вернула на второй адрес', forwardAgain !== null, first?.getURL());

  /* --- 5. Вторая страница — вторая вкладка --------------------------------------- */
  check('второй адрес принят', (await openUrl(`${base}/third`)) === 'адрес принят');
  const third = await waitFor(() => guestAt(`${base}/third`));
  check('второе вложение создано', third !== null, third?.getURL());
  const thirdLoaded = third ? await waitFor(() => third.getTitle() === 'Третья страница' && third) : null;
  check('второй заголовок пришёл со страницы', thirdLoaded !== null, third?.getTitle());
  const uiTwo = await ask(ide, UI_STATE);
  check('в полосе две вкладки', uiTwo.вкладки.length === 2, uiTwo.вкладки);
  check('активна вторая', uiTwo.активная === 'Третья страница', uiTwo.активная);
  check('вложений тоже два (по одному на вкладку)', panel.ids().length === 2, panel.ids());
  // Первая вкладка к этому моменту на другом адресе — состояние у вложений разное.
  check('первая вкладка осталась на своём адресе', first?.getURL().endsWith('/about') === true, first?.getURL());

  /* --- 6. Адресная строка: набор адреса вручную ---------------------------------- */
  await ask(
    ide,
    `(() => {
      const field = document.querySelector('.browser-address');
      field.value = ${JSON.stringify(`${base}/about`)};
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'набрано';
    })()`,
  );
  const uiTyped = await waitFor(async () => {
    const state = await ask(ide, UI_STATE);
    return state.активная === 'О странице' ? state : null;
  });
  check('набранный адрес открылся в активной вкладке', uiTyped !== null, uiTyped?.активная);
  check('вторая вкладка ушла на набранный адрес', third?.getURL().endsWith('/about') === true, third?.getURL());

  /* --- 7. Закрытие вкладки убирает вложение -------------------------------------- */
  await ask(
    ide,
    `(() => {
      document.querySelector('.tab-page.is-active .tab-close')?.click();
      return 'закрыто';
    })()`,
  );
  const oneGuest = await waitFor(() => guests().length === 1 && true);
  check('закрытие вкладки убрало вложение из дерева', oneGuest === true, guests().length);
  const uiClosed = await ask(ide, UI_STATE);
  check('осталась одна вкладка', uiClosed.вкладки.length === 1, uiClosed.вкладки);
  check('полотно показывает оставшуюся страницу', uiClosed.полотно === true && panel.ids().length === 1, uiClosed);

  /* --- 8. Агент в том же браузере ------------------------------------------------ */
  // Заглушка вместо отдельного Chromium: если агент позвал бы её — это была бы ошибка
  // (проверяем, что он работает во ВСТРОЕННОМ браузере, а не в своём процессе).
  const forbidden = () => {
    throw new Error('агент ушёл в отдельный браузер вместо встроенного');
  };
  // Заглушка отдельного Chromium: если агент позвал бы её — проверка бы упала.
  const externalStub = {
    open: forbidden,
    snapshot: forbidden,
    click: forbidden,
    type: forbidden,
    evaluate: forbidden,
    close: async () => {},
  };
  const agent = new AgentBrowser(panel, externalStub, () => true);

  const agentSnapshot = await agent.open(`${base}/`).catch((error) => ({ error: String(error) }));
  check(
    'агент открыл страницу во встроенном браузере',
    agentSnapshot.title === 'Домашняя страница',
    agentSnapshot.title,
  );
  check(
    'страницу агента видно вложением',
    (await waitFor(() => panel.ids().includes('agent-1'))) === true,
    panel.ids(),
  );
  const agentTab = await waitFor(async () => {
    const state = await ask(ide, UI_STATE);
    return state.вкладки.length === 2 ? state : null;
  });
  check('в полосе появилась вкладка агента', agentTab !== null, agentTab?.вкладки);
  // Вкладка агента отличается от человеческой: значок ассистента вместо глобуса.
  // Иначе непонятно, откуда взялась страница с пустым профилем.
  const agentMark = await ask(
    ide,
    `(() => {
      const tab = document.querySelector('.tab-page.is-agent-page');
      if (!tab) return null;
      return {
        подпись: tab.querySelector('.tab-label')?.textContent ?? null,
        подсказка: tab.getAttribute('title') ?? '',
      };
    })()`,
  );
  check(
    'вкладка агента помечена',
    agentMark !== null && agentMark.подсказка.includes('открыта ассистентом'),
    agentMark,
  );
  // Читаем ту же страницу, что и человек: тот же адрес, то же содержимое.
  const agentTitle = await agent.evaluate('document.title');
  check('агент видит ту же страницу', agentTitle === 'Домашняя страница', agentTitle);
  const agentText = await agent.evaluate('document.body.innerText');
  check('и то же содержимое', String(agentText).includes('Маленький сайт'), String(agentText).slice(0, 40));

  await agent.close();
  const agentGone = await waitFor(async () => (await ask(ide, UI_STATE)).вкладки.length === 1);
  check('закрытие агента убрало его вкладку', agentGone === true, panel.ids());

  /* --- 9. Общий доступ: агент работает в странице человека ------------------------ */
  const human = panel.ids().find((id) => id.startsWith('page-')) ?? null;
  check('осталась одна вкладка человека', human !== null && panel.ids().length === 1, panel.ids());
  check('до кнопки общего доступа нет', panel.sharedPageId === null, panel.sharedPageId);

  check('кнопка «поделиться» нажата', (await pressToolbar('Поделиться страницей с ассистентом')) === 'нажата');
  const sharedId = await waitFor(() => panel.sharedPageId);
  check('общий доступ выставлен на вкладку', sharedId === human, sharedId);

  // Кнопка сменила подсказку — человеку видно, что доступ открыт, и как его снять.
  const sharedLabel = await waitFor(() =>
    ask(
      ide,
      "[...document.querySelectorAll('.browser-toolbar button')].map((b) => b.title).find((t) => t && t.startsWith('Отозвать')) ?? null",
    ),
  );
  check('кнопка показывает «отозвать»', typeof sharedLabel === 'string', sharedLabel);

  // Агент теперь работает в поделённой странице и НЕ заводит свою.
  const sharedAgent = new AgentBrowser(panel, externalStub, () => true);
  const beforeCount = panel.ids().length;
  const viaShared = await sharedAgent.open(`${base}/third`).catch((error) => ({ error: String(error) }));
  check(
    'агент получил страницу через общий доступ',
    viaShared.title === 'Третья страница',
    viaShared.title ?? viaShared.error,
  );
  check('агент не завёл свою вкладку', panel.ids().length === beforeCount, panel.ids());
  check(
    'поделённая страница ушла на адрес агента',
    panel.contents(human)?.getURL().endsWith('/third') === true,
    panel.contents(human)?.getURL(),
  );
  await sharedAgent.close();

  check('кнопка «отозвать» нажата', (await pressToolbar('Отозвать доступ ассистента к странице')) === 'нажата');
  const cleared = await waitFor(async () => (panel.sharedPageId === null ? 'снят' : null));
  check('общий доступ снят', cleared === 'снят', panel.sharedPageId);

  // Без общего доступа агент снова заводит СВОЮ вкладку во временной сессии.
  const ownAgent = new AgentBrowser(panel, externalStub, () => true);
  await ownAgent.open(base + '/').catch(() => undefined);
  const ownTab = await waitFor(() => panel.ids().some((id) => id.startsWith('agent-')));
  check('без общего доступа агент завёл свою вкладку', ownTab === true, panel.ids());
  await ownAgent.close();
  await waitFor(() => !panel.ids().some((id) => id.startsWith('agent-')));

  /* --- 10. Ссылка со страницы: новая вкладка в той же полосе ---------------------- */
  const opener = panel
    .ids()
    .map((id) => panel.contents(id))
    .find((item) => item && item.getURL().endsWith('/third'));
  check('страница-источник найдена', opener !== undefined, panel.ids());
  if (opener) await opener.executeJavaScript('window.open(' + JSON.stringify(base + '/popup') + "); 'ок'");
  const popupTab = await waitFor(async () => {
    const state = await ask(ide, UI_STATE);
    return state.вкладки.length === 2 ? state : null;
  });
  check('window.open завёл вторую вкладку', popupTab !== null, popupTab?.вкладки);
  const popupGuest = await waitFor(() => guestAt(base + '/popup'));
  check('вложение новой вкладки загрузило адрес', popupGuest !== null, popupGuest?.getURL());

  /* --- 11. Снимок и консоль страницы — в чат ------------------------------------- */
  // Активна всплывающая вкладка — она писала в консоль (см. POPUP).
  const chatChips = () =>
    ask(
      ide,
      "[...document.querySelectorAll('.composer-chips .chip')].map((c) => c.querySelector('.chip-name')?.textContent ?? '')",
    );
  const pressChatMenu = (label) =>
    ask(
      ide,
      '(async () => {' +
        "const button = [...document.querySelectorAll('.browser-toolbar button')].find((b) => b.getAttribute('title') === 'Добавить в чат');" +
        "if (!button) return 'нет кнопки';" +
        "if (button.disabled) return 'выключена';" +
        'button.click();' +
        'await new Promise((r) => setTimeout(r, 250));' +
        "const item = [...document.querySelectorAll('.context-item')].find((node) => (node.querySelector('.context-label')?.textContent ?? '') === " +
        JSON.stringify(label) +
        ');' +
        "if (!item) return 'нет пункта';" +
        'item.click();' +
        "return 'нажато';" +
        '})()',
    );

  check('пункт «Снимок страницы в чат» нажат', (await pressChatMenu('Снимок страницы в чат')) === 'нажато');
  const imageChip = await waitFor(async () => {
    const chips = await chatChips();
    return Array.isArray(chips) && chips.some((name) => String(name).startsWith('Страница ')) ? chips : null;
  });
  check('снимок страницы пришёл в чат картинкой', imageChip !== null, imageChip);
  const thumb = await ask(ide, "document.querySelectorAll('.composer-chips .chip-image .chip-thumb').length");
  check('чип картинки показывает миниатюру', thumb >= 1, thumb);

  check('пункт «Журнал консоли в чат» нажат', (await pressChatMenu('Журнал консоли в чат')) === 'нажато');
  const consoleChip = await waitFor(async () => {
    const chips = await chatChips();
    return Array.isArray(chips) && chips.some((name) => String(name).startsWith('Журнал консоли')) ? chips : null;
  });
  check('журнал консоли пришёл в чат контекстом', consoleChip !== null, consoleChip);

  /* --- 12. Переключение с браузера на вкладку файла ------------------------------- */
  // Регрессия: файл открыт и активен, поверх него показана страница, а клик по вкладке
  // ТОГО ЖЕ файла не убирал страницу — файл был активен и раньше, поэтому `openEditors`
  // о смене не сообщал, а страница живёт в своей модели и сама не отступала.
  step('переключение с браузера на вкладку файла');
  check('файл открыт', (await openFile('note.txt')) === 'открыт');
  const fileShown = await waitFor(async () => {
    const state = await ask(ide, UI_STATE);
    return state.полотно === false ? state : null;
  });
  check('файл вытеснил страницу', fileShown !== null, fileShown?.полотно);

  // Показываем страницу снова кликом по её вкладке: активным документом остаётся файл.
  check('страница показана кликом по вкладке', (await clickPageTab()) === 'нажата');
  const pageBack = await waitFor(async () => {
    const state = await ask(ide, UI_STATE);
    return state.полотно === true ? state : null;
  });
  check('страница снова поверх файла', pageBack !== null, pageBack?.полотно);
  const pageKey = first ? idOf(first) : null;
  check('видно ровно одно вложение — страницы', drawn().length === 1 && drawn()[0] === pageKey, {
    наЭкране: drawn(),
    ключ: pageKey,
  });

  // Клик по вкладке УЖЕ активного файла — тот случай, когда события смены нет.
  check('вкладка файла нажата', (await clickFileTab('note.txt')) === 'нажата');
  const switchedToFile = await waitFor(async () => {
    const state = await ask(ide, UI_STATE);
    return state.полотно === false ? state : null;
  });
  check('клик по вкладке файла убрал страницу с экрана', switchedToFile !== null, switchedToFile?.полотно);
  const hiddenView = await waitFor(() => (panel.isShown(pageKey) ? null : true));
  check('вложение погашено, но осталось в окне', hiddenView === true, {
    наЭкране: drawn(),
    вложений: panel.ids().length,
  });

  // А вот и главное: возврат на вкладку страницы. Раньше вложение на возврате
  // отцеплялось и прицеплялось заново, и слой переставал рисоваться — вкладка
  // открывалась пустой. Теперь скрытие — `setVisible`, а не `removeChildView`.
  check('вкладка страницы нажата снова', (await clickPageTab()) === 'нажата');
  const shownAgain = await waitFor(() => (panel.isShown(pageKey) ? true : null));
  check('вернулись на вкладку — вложение снова рисуется', shownAgain === true, { наЭкране: drawn() });

  // И встаёт ровно по текущему размеру области вкладки (а не по тому, который был
  // при первом показе): размер мог измениться, пока страница была в фоне.
  const stageRect = await ask(
    ide,
    `(() => {
      const box = document.querySelector('.browser-stage').getBoundingClientRect();
      return {
        x: Math.round(box.x), y: Math.round(box.y),
        width: Math.max(0, Math.round(box.width)), height: Math.max(0, Math.round(box.height)),
      };
    })()`,
  );
  const fitted = await waitFor(() => {
    const bounds = panel.boundsOf(pageKey);
    if (!bounds) return null;
    const same = bounds.width === stageRect.width && bounds.height === stageRect.height;
    return same ? bounds : null;
  });
  check(
    'вложение вписано в текущий размер области',
    fitted !== null,
    fitted ?? { вложение: panel.boundsOf(pageKey), область: stageRect },
  );

  /* --- 12в. Масштаб страницы ------------------------------------------------------ */
  // Страница умеет масштаб так же, как вьюер картинок: кнопки в шапке, «1:1»,
  // «вписать по ширине» и Ctrl+колесо. Масштаб — состояние вкладки, а не страницы,
  // поэтому проверяем и его самого, и подпись в шапке (человек видит её, а не числа).
  step('масштаб страницы');
  const shownId = () => panel.ids().find((key) => panel.isShown(key)) ?? null;
  const zoomId = shownId();
  const zoomGuest = zoomId ? panel.contents(zoomId) : null;
  check('страница показана — можно менять масштаб', zoomGuest !== null, zoomId);
  check('по умолчанию масштаб 100 %', panel.zoomOf(zoomId) === 1, panel.zoomOf(zoomId));

  const zoomLabel = () => ask(ide, "document.querySelector('.browser-zoom-label')?.textContent ?? null");
  const pressZoom = async (title) => {
    const result = await pressToolbar(title);
    // Подпись живёт событием из main — даём ей доехать до DOM.
    await wait(250);
    return result;
  };

  check('кнопка «Крупнее» нажата', (await pressZoom('Крупнее (Ctrl+колесо)')) === 'нажата');
  const zoomedIn = await waitFor(() => (panel.zoomOf(zoomId) > 1 ? panel.zoomOf(zoomId) : null));
  check('масштаб вырос', zoomedIn === 1.25, { масштаб: panel.zoomOf(zoomId) });
  const labelIn = await waitFor(async () => {
    const text = await zoomLabel();
    return text === '125%' ? text : null;
  });
  check('подпись в шапке показывает 125 %', labelIn === '125%', labelIn ?? (await zoomLabel()));

  // Ctrl+колесо живёт не в DOM: колесо над страницей уходит в слой окна. Шлём
  // настоящий жест — и смотрим, что масштаб поменялся так же, как от кнопки.
  if (zoomGuest) {
    zoomGuest.sendInputEvent({
      type: 'mouseWheel',
      x: 80,
      y: 80,
      deltaX: 0,
      deltaY: -120,
      wheelTicksX: 0,
      wheelTicksY: 1,
      modifiers: ['control'],
    });
  }
  const wheeled = await waitFor(() => (panel.zoomOf(zoomId) > 1.25 ? panel.zoomOf(zoomId) : null), 4000);
  check('Ctrl+колесо увеличило масштаб', wheeled !== null, { масштаб: panel.zoomOf(zoomId) });

  // «Вписать по ширине» проверяем на заведомо широкой странице: на узкой вписывать
  // нечего, и результат был бы неотличим от 100 %.
  if (zoomGuest) await zoomGuest.executeJavaScript("document.body.style.minWidth = '1600px'; 'ок'");
  check('кнопка «Вписать по ширине» нажата', (await pressZoom('Вписать по ширине')) === 'нажата');
  const fittedZoom = await waitFor(() => {
    const value = panel.zoomOf(zoomId);
    return value !== null && value < 1 ? value : null;
  });
  check('вписывание уменьшило масштаб', fittedZoom !== null, { масштаб: panel.zoomOf(zoomId) });
  // Влезание считаем в точках окна: `scrollWidth` и `clientWidth` живут в CSS-пикселях
  // и от масштаба не меняются, поэтому сравнивать их между собой бессмысленно.
  const contentWidth = zoomGuest ? await zoomGuest.executeJavaScript('document.documentElement.scrollWidth') : 0;
  const windowWidth = zoomId ? (panel.boundsOf(zoomId)?.width ?? 0) : 0;
  const renderedWidth = Math.round(contentWidth * (panel.zoomOf(zoomId) ?? 1));
  check('после вписывания страница не прокручивается вбок', renderedWidth <= windowWidth + 2, {
    контент: renderedWidth,
    окно: windowWidth,
  });
  if (zoomGuest) await zoomGuest.executeJavaScript("document.body.style.minWidth = ''; 'ок'");

  check('кнопка «1:1» нажата', (await pressZoom('Реальный масштаб (1:1)')) === 'нажата');
  const backToOne = await waitFor(() => (panel.zoomOf(zoomId) === 1 ? true : null));
  check('масштаб вернулся к 100 %', backToOne === true, panel.zoomOf(zoomId));

  /* --- 12г. Выбор элемента страницы — в чат ------------------------------------------ */
  // Обычный путь для «а вот тут криво»: человек нажимает кнопку, кликает по элементу,
  // и в композер чата ложится его описание и снимок. Страница при этом не должна
  // нажать кнопку или уйти по ссылке — выбор перехватывает клик.
  step('выбор элемента страницы для чата');
  const targetBox = zoomGuest
    ? await zoomGuest.executeJavaScript(
        "(() => { const el = document.querySelector('h1') || document.querySelector('p'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: el.tagName.toLowerCase() }; })()",
      )
    : null;
  check('на странице есть элемент — есть что выбирать', targetBox !== null, targetBox);
  const urlBeforePick = zoomGuest ? zoomGuest.getURL() : null;

  check('кнопка «Выбрать элемент для чата» нажата', (await pressToolbar('Выбрать элемент для чата')) === 'нажата');
  await wait(600);
  if (zoomGuest && targetBox) {
    for (const type of ['mouseDown', 'mouseUp']) {
      zoomGuest.sendInputEvent({ type, x: targetBox.x, y: targetBox.y, button: 'left', clickCount: 1 });
    }
  }
  const pickedChip = await waitFor(async () => {
    const chips = await chatChips();
    return Array.isArray(chips) && chips.some((name) => String(name).startsWith('Элемент:')) ? chips : null;
  }, 10000);
  check('контекст элемента пришёл в чат', pickedChip !== null, pickedChip);
  check('страница не ушла на другой адрес', zoomGuest?.getURL() === urlBeforePick, {
    было: urlBeforePick,
    стало: zoomGuest?.getURL(),
  });
  // Снимок области элемента приходит картинкой: без него «вот этот блок» опять словами.
  const shotChip = Array.isArray(pickedChip) ? pickedChip.find((name) => /^Элемент .+\.png$/.test(String(name))) : null;
  check('снимок элемента приложен картинкой', shotChip !== null && shotChip !== undefined, pickedChip);

  /* --- 12б. Вкладка чата и вкладка страницы в одной полосе ----------------------- */
  // Регрессия: чат, перенесённый в редактор, и страница браузера занимают ОДНУ область,
  // но живут в разных моделях (`chatTabActive` в app.ts и `BrowserTabs`). Клик по вкладке
  // страницы при показанном чате подсвечивал обе вкладки и оставлял на экране чат, а
  // клик по вкладке чата при показанной странице — наоборот. Активной в полосе должна
  // быть ровно одна вкладка, и на экране — ровно её содержимое.
  step('вкладка чата и вкладка страницы');

  /** Выполнить команду из палитры — тем же путём, что и человек. */
  const runCommand = (title) =>
    ask(
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
        input.value = ${JSON.stringify(title)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        const item = [...document.querySelectorAll('.palette-item')].find(
          (node) => (node.querySelector('.palette-item-title')?.textContent ?? '') === ${JSON.stringify(title)},
        );
        if (!item) return 'пункта нет';
        item.click();
        await new Promise((resolve) => setTimeout(resolve, 700));
        return 'выполнено';
      })()`,
    );

  /** Состояние полосы и области редактора: кто активен и что показано. */
  const AREA_STATE = `(() => {
    const island = document.querySelector('.editor-island');
    // Только полоса редактора: у панели чата своя полоса бесед, и её вкладки помечены
    // тем же классом (tab) — считать их за вкладки редактора нельзя.
    const tabs = [...document.querySelectorAll('.tabs-host .tab')];
    const active = tabs.filter((tab) => tab.classList.contains('is-active'));
    return {
      активныхВкладок: active.length,
      активная: active[0]?.querySelector('.tab-label')?.textContent ?? null,
      видов: tabs.map((tab) => tab.dataset.kind ?? 'file'),
      страница: island?.classList.contains('is-browser') ?? false,
      чат: island?.classList.contains('is-chat') ?? false,
      чатВРедакторе: Boolean(document.querySelector('.chat-editor:not([hidden]) .chat')),
    };
  })()`;

  const clickAuxTab = () =>
    ask(
      ide,
      `(() => {
        const tab = document.querySelector('.tab-auxiliary');
        if (!tab) return 'нет вкладки';
        tab.click();
        return 'нажата';
      })()`,
    );

  check('чат перенесён в редактор', (await runCommand('Перенести чат в окно редактора')) === 'выполнено');
  const chatShown = await waitFor(async () => {
    const state = await ask(ide, AREA_STATE);
    return state.чат === true ? state : null;
  });
  check('в полосе появилась вкладка чата', chatShown !== null && chatShown.видов.includes('aux'), {
    виды: chatShown?.видов,
  });
  check('на экране чат, страница уступила', chatShown !== null && chatShown.страница === false, chatShown);
  check('активная вкладка одна — чат', chatShown?.активныхВкладок === 1, chatShown?.активныхВкладок);

  // Клик по вкладке страницы: она забирает область у чата, и подсвечена только она.
  check('страница показана кликом по её вкладке', (await clickPageTab()) === 'нажата');
  const pageOverChat = await waitFor(async () => {
    const state = await ask(ide, AREA_STATE);
    return state.страница === true ? state : null;
  });
  check(
    'клик по вкладке страницы убрал чат с экрана',
    pageOverChat !== null && pageOverChat.чат === false,
    pageOverChat,
  );
  check('активная вкладка одна — страница', pageOverChat?.активныхВкладок === 1, pageOverChat?.активныхВкладок);

  // И обратно: вкладка чата возвращает чат, страница уступает.
  check('вкладка чата нажата', (await clickAuxTab()) === 'нажата');
  const chatOverPage = await waitFor(async () => {
    const state = await ask(ide, AREA_STATE);
    return state.чат === true ? state : null;
  });
  check(
    'клик по вкладке чата убрал страницу с экрана',
    chatOverPage !== null && chatOverPage.страница === false,
    chatOverPage,
  );
  check('активная вкладка одна — чат', chatOverPage?.активныхВкладок === 1, chatOverPage?.активныхВкладок);

  // Клавиатура: стрелка с вкладки страницы доходит до вкладки чата и наоборот. Раньше
  // ход по полосе знал только файлы — страница и чат были недостижимы с клавиатуры.
  const keyboard = await ask(
    ide,
    `(async () => {
      // Полоса редактора: у панели чата своя полоса бесед с тем же классом (tab).
      const tabs = () => [...document.querySelectorAll('.tabs-host .tab')];
      const walk = (node, key) => {
        if (!node) return false;
        node.focus();
        node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        return true;
      };
      const auxNode = () => tabs().find((node) => node.dataset.kind === 'aux') ?? null;
      // Соседняя слева от чата вкладка — та, с которой стрелка вправо обязана дойти.
      const передЧатом = () => {
        const all = tabs();
        const index = all.indexOf(auxNode());
        return index > 0 ? all[index - 1] : null;
      };
      const послеВправо = walk(передЧатом(), 'ArrowRight');
      await new Promise((resolve) => setTimeout(resolve, 400));
      const вправо = {
        шаг: послеВправо,
        активная: document.querySelector('.tab.is-active .tab-label')?.textContent ?? null,
        вРедакторе: Boolean(document.querySelector('.chat-editor:not([hidden]) .chat')),
        страница: document.querySelector('.editor-island')?.classList.contains('is-browser') ?? false,
        фокус: document.activeElement?.dataset?.kind ?? null,
      };
      walk(auxNode(), 'ArrowLeft');
      await new Promise((resolve) => setTimeout(resolve, 400));
      const влево = {
        активная: document.querySelector('.tab.is-active .tab-label')?.textContent ?? null,
        страница: document.querySelector('.editor-island')?.classList.contains('is-browser') ?? false,
        чат: document.querySelector('.editor-island')?.classList.contains('is-chat') ?? false,
      };
      return { вправо, влево };
    })()`,
  );
  check('стрелка вправо с вкладки страницы открыла чат', keyboard?.вправо?.вРедакторе === true, keyboard?.вправо);
  check('страница при этом уступила', keyboard?.вправо?.страница === false, keyboard?.вправо);
  check('фокус уехал на вкладку чата', keyboard?.вправо?.фокус === 'aux', keyboard?.вправо);
  check(
    'стрелка влево вернула страницу',
    keyboard?.влево?.страница === true && keyboard?.влево?.чат === false,
    keyboard?.влево,
  );

  // Ctrl+W закрывает ту вкладку, что показана: с показанным чатом он отправляет чат
  // обратно в панель, а не закрывает файл за ним.
  check('вкладка чата нажата перед Ctrl+W', (await clickAuxTab()) === 'нажата');
  await waitFor(async () => ((await ask(ide, AREA_STATE)).чат === true ? true : null));
  ide.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['control'] });
  ide.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['control'] });
  const closedChat = await waitFor(async () => {
    const state = await ask(ide, AREA_STATE);
    return state.видов.includes('aux') === false ? state : null;
  });
  check('Ctrl+W убрал вкладку чата в панель', closedChat !== null, closedChat?.видов);
  check('страница от этого не закрылась', closedChat !== null && closedChat.видов.includes('page'), closedChat?.видов);

  /* --- 13. Меню не уходит под страницу -------------------------------------------- */
  // Вложение — слой окна поверх DOM. Меню (`.context-menu`), которое НАКРЫВАЕТ сцену,
  // без утайки вложения оказалось бы ПОД страницей: его не видно и не нажать. Меню в
  // стороне (дерево файлов, полоса вкладок, панель чата) до сцены не достаёт, и там
  // страницу не трогаем: иначе она мигала бы на каждый правый клик по дереву. Место
  // меню задаём сами: так проверка не зависит от ширины окна пробы.
  step('меню-панель и слой страницы');
  check('страница показана перед меню', (await clickPageTab()) === 'нажата');
  const shownForMenu = await waitFor(async () => {
    const state = await ask(ide, UI_STATE);
    return state.полотно === true ? state : null;
  });
  check('страница видна', shownForMenu !== null, shownForMenu?.полотно);
  const menuPage = drawn()[0] ?? null;
  check('видно ровно вложение этой страницы', menuPage !== null, { наЭкране: drawn() });

  // Меню в стороне от сцены: маленькая панель под деревом файлов.
  const farMenu = await ask(
    ide,
    `(() => {
      const node = document.createElement('div');
      node.className = 'context-menu';
      node.style.cssText = 'position: fixed; left: 8px; top: 8px; width: 60px; height: 60px';
      document.body.appendChild(node);
      const box = document.querySelector('.browser-stage')?.getBoundingClientRect();
      return box && node.getBoundingClientRect().right <= box.left ? 'вне сцены' : 'задевает сцену';
    })()`,
  );
  check('меню стоит в стороне от сцены', farMenu === 'вне сцены', farMenu);
  await wait(500);
  check('меню в стороне страницу не прячет', panel.isShown(menuPage) === true, { наЭкране: drawn() });
  await ask(ide, "(() => { document.querySelector('.context-menu')?.remove(); return 'убрано'; })()");

  // Меню поверх сцены: настоящий правый клик по вкладке файла, только поставленный
  // над страницей — clientX/clientY меню служат местом появления.
  const menuSpot = await ask(
    ide,
    `(() => {
      const box = document.querySelector('.browser-stage')?.getBoundingClientRect();
      return box ? { x: Math.round(box.x + 40), y: Math.round(box.y + 40) } : null;
    })()`,
  );
  check('сцена найдена', menuSpot !== null, menuSpot);
  await ask(
    ide,
    `(() => {
      const files = [...document.querySelectorAll('.tab')].filter((t) => !t.classList.contains('tab-page'));
      const tab = files.find((t) => (t.querySelector('.tab-label')?.textContent ?? '') === 'note.txt') ?? files[0];
      if (!tab) return 'нет вкладки';
      tab.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: ${menuSpot?.x ?? 300}, clientY: ${menuSpot?.y ?? 300} }),
      );
      return 'меню открыто';
    })()`,
  );
  const menuHidesView = await waitFor(async () => {
    const menus = await ask(ide, "document.querySelectorAll('.context-menu').length");
    return menus > 0 && panel.isShown(menuPage) === false ? { menus, наЭкране: drawn() } : null;
  });
  check(
    'пока меню над сценой, страница спрятана',
    menuHidesView !== null,
    menuHidesView ?? {
      меню: await ask(ide, "document.querySelectorAll('.context-menu').length"),
      наЭкране: drawn(),
    },
  );

  // Спрятанная страница оставляет на своём месте замороженный кадр: без него на месте
  // страницы была бы пустая полоса — «при открытии меню окно браузера пропадает».
  const frozen = await waitFor(async () => {
    const src = await ask(
      ide,
      "(() => { const shot = document.querySelector('.browser-snapshot'); return shot && !shot.hidden ? String(shot.src ?? '').slice(0, 22) : null; })()",
    );
    return src === 'data:image/png;base64,' ? src : null;
  });
  check('на месте страницы остался её кадр', frozen === 'data:image/png;base64,', frozen);

  // Esc закрывает меню — страница обязана вернуться на место, а кадр исчезнуть.
  await ask(
    ide,
    `(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return 'esc';
    })()`,
  );
  const viewBack = await waitFor(async () => {
    if (!panel.isShown(menuPage)) return null;
    const hidden = await ask(
      ide,
      "(() => { const shot = document.querySelector('.browser-snapshot'); return !shot || shot.hidden; })()",
    );
    return hidden === true ? true : null;
  });
  check('после закрытия меню страница вернулась, кадр убран', viewBack === true, { наЭкране: drawn() });

  /* --- 15. Попапы тоже прячут страницу -------------------------------------------- */
  // Попапы (`.popover`: выпадающие списки, статус серверов) и «Информация о сессии»
  // всплывают вверх от своих кнопок и накрывают область редактора. Страница — слой
  // окна поверх DOM, поэтому без утайки они оказались бы ПОД ней.
  step('попап и слой страницы');
  check('страница показана', (await waitFor(async () => ((await ask(ide, UI_STATE)).полотно ? true : null))) === true);
  const popoverPage = drawn()[0] ?? null;
  check('видно ровно вложение этой страницы', popoverPage !== null, { наЭкране: drawn() });

  // Открываем попап напрямую: в стенде пробы ассистент может быть выключен, а
  // проверяем мы правило «что-то всплыло НАД СЦЕНОЙ — страницу спрятать», а не то,
  // как открывается конкретное окно. Место ставим над страницей сами: попап в стороне
  // (у своей кнопки в другой панели) страницу не закрывает, и прятать её незачем.
  const popoverSpot = await ask(
    ide,
    `(() => {
      const box = document.querySelector('.browser-stage')?.getBoundingClientRect();
      if (!box) return null;
      const node = document.createElement('div');
      node.className = 'popover';
      node.style.cssText =
        'position: fixed; width: 180px; height: 120px; left: ' +
        Math.round(box.x + 60) +
        'px; top: ' +
        Math.round(box.y + 60) +
        'px';
      document.body.appendChild(node);
      return 'попап открыт';
    })()`,
  );
  check('попап открыт над сценой', popoverSpot === 'попап открыт', popoverSpot);
  const popoverHidesView = await waitFor(() =>
    popoverPage !== null && panel.isShown(popoverPage) === false ? true : null,
  );
  check('пока попап открыт, страница спрятана', popoverHidesView === true, { наЭкране: drawn() });

  // Свой попап убираем последним: в приложении `.popover` есть и свои (скрытые), а
  // снять чужой — значит оставить над сценой накрывшую её панель.
  await ask(ide, "(() => { [...document.querySelectorAll('.popover')].at(-1)?.remove(); return 'закрыт'; })()");
  const popoverBack = await waitFor(() => (popoverPage !== null && panel.isShown(popoverPage) ? true : null));
  check('после закрытия попапа страница вернулась', popoverBack === true, { наЭкране: drawn() });

  /* --- 14. Агент на странице: видно, что это он ----------------------------------- */
  // Страница меняется не от мыши человека — нажатия и переходы приходят от ассистента.
  // Без метки это неотличимо от собственной ошибки. Проверяем оба места (шапка вкладки
  // и полоса) и то, что метка гаснет: вечная метка — это ложь.
  step('метка «ассистент работает со страницей»');
  check('страница показана', (await waitFor(async () => ((await ask(ide, UI_STATE)).полотно ? true : null))) === true);
  panel.noteAgentAction(menuPage, 'click');
  const badge = await waitFor(async () => {
    const text = await ask(ide, "document.querySelector('.browser-agent:not([hidden])')?.textContent ?? null");
    return typeof text === 'string' && text.includes('Ассистент') ? text : null;
  });
  check('в шапке страницы сказано, что действует ассистент', badge !== null, badge);
  const tabMark = await ask(ide, "document.querySelectorAll('.tab-page.is-agent').length");
  check('на вкладке страницы появилась метка', tabMark === 1, tabMark);
  const markGone = await waitFor(async () => {
    const count = await ask(ide, "document.querySelectorAll('.tab-page.is-agent').length");
    return count === 0 ? true : null;
  }, 8000);
  check('метка гаснет сама', markGone === true);
  const badgeGone = await ask(ide, "document.querySelectorAll('.browser-agent:not([hidden])').length");
  check('и в шапке её тоже больше нет', badgeGone === 0, badgeGone);

  /* --- 15. Подсказки не уходят под страницу --------------------------------------- */
  // Страница — слой окна ПОВЕРХ DOM, поэтому подсказка под кнопками её шапки
  // оказывалась под страницей: виден был только хвост за краем сцены.
  step('подсказки и слой страницы');
  // Подсказку спрашиваем в несколько заходов: слой показывается по задержке, а
  // прошлое наведение могло оставить его погашенным (та же грабля, что у probe:tooltip).
  const hint = await waitFor(async () => {
    const answer = await ask(
      ide,
      `(async () => {
        const stage = document.querySelector('.browser-stage');
        const button = [...document.querySelectorAll('.browser-toolbar button')].find((item) =>
          (item.getAttribute('title') ?? '').startsWith('Добавить в чат'),
        );
        if (!stage || !button) return null;
        button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 800));
        const tip = document.querySelector('.app-tooltip:not([hidden])');
        if (!tip) return null;
        const a = tip.getBoundingClientRect();
        const b = stage.getBoundingClientRect();
        const overlaps = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        return {
          текст: tip.textContent,
          пересекаетСцену: overlaps,
          подсказка: { top: Math.round(a.top), bottom: Math.round(a.bottom) },
          сцена: { top: Math.round(b.top), bottom: Math.round(b.bottom) },
        };
      })()`,
    );
    return answer && typeof answer === 'object' && answer.текст ? answer : null;
  }, 8000);

  check('подсказка у кнопки шапки появилась', typeof hint?.текст === 'string' && hint.текст.length > 0, hint);
  check('подсказка не заходит на страницу', hint?.пересекаетСцену === false, hint);

  /* --- 16. Неудачная загрузка: одно уведомление на одну неудачу ------------------- */
  // Состояние вкладки рассылается на каждый чих (начало и конец загрузки, масштаб,
  // переход внутри страницы), а ошибка загрузки хранилась до следующего удачного
  // перехода — то есть ехала в каждом таком событии. На три события — три одинаковых
  // уведомления на одну неудачу. Теперь ошибка одноразовая: проверим это счётом.
  step('неудачная загрузка: сколько уведомлений');
  const uiBeforeFail = await waitFor(async () => {
    const state = await ask(ide, UI_STATE);
    return state.полотно === true ? state : null;
  });
  check('страница показана перед неудачей', uiBeforeFail !== null, uiBeforeFail?.полотно);

  // Порт занимаем и тут же освобождаем: адрес гарантированно отвечает отказом,
  // а не провалом имени в DNS (сеть в прогоне не нужна).
  const deadServer = http.createServer(() => undefined);
  await new Promise((resolve) => deadServer.listen(0, '127.0.0.1', resolve));
  const deadPort = deadServer.address().port;
  await new Promise((resolve) => deadServer.close(resolve));
  await ask(
    ide,
    `(() => {
      const field = document.querySelector('.browser-address');
      field.value = 'http://127.0.0.1:${deadPort}/';
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'набрано';
    })()`,
  );
  const failureCountExpr = `[...document.querySelectorAll('.toast-text')].filter((t) =>
    t.textContent.includes('Страница не загрузилась')).length`;
  const failure = await waitFor(async () => {
    const count = await ask(ide, failureCountExpr);
    return typeof count === 'number' && count > 0 ? count : null;
  });
  check('про неудачу сказано', failure !== null, failure);
  // Ждём дольше, чем идёт вся загрузка: лишние уведомления успели бы появиться.
  await wait(2500);
  const failureTotal = await ask(ide, failureCountExpr);
  check('на одну неудачу одно уведомление', failureTotal === 1, failureTotal);

  // Возвращаем живой адрес: дальше пробе нужна открывающаяся страница.
  await ask(
    ide,
    `(() => {
      const field = document.querySelector('.browser-address');
      field.value = ${JSON.stringify(`${base}/`)};
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'набрано';
    })()`,
  );
  const homeBack = await waitFor(async () => {
    const state = await ask(ide, UI_STATE);
    return state.активная === 'Домашняя страница' ? state : null;
  });
  check('страница снова открывается', homeBack !== null, homeBack?.активная);
  await ask(
    ide,
    "(() => { for (const toast of document.querySelectorAll('.toast')) toast.click(); return 'закрыты'; })()",
  );

  /* --- 17. Углы страницы скруглены ----------------------------------------------- */
  // Вложение — прямоугольник отдельного слоя окна: CSS острова его не обрезает, поэтому
  // углы срезает маска самого слоя (`setBorderRadius` в main/browser/panel.ts).
  // Сверить это картинкой нельзя: `capturePage` окна содержимое вложений НЕ захватывает —
  // слой окна в неё не попадает (на снимке на месте страницы фон редактора). Поэтому
  // проверяем, что маска поставлена; глазами — в живом окне.
  step('углы страницы');
  check('маска углов поставлена', panel.cornerRadius(menuPage) === 8, panel.cornerRadius(menuPage));
  // Зазора у сцены нет: страница занимает её целиком, край в край с островом.
  const stageStyle = await ask(
    ide,
    `(() => {
      const stage = document.querySelector('.browser-stage');
      if (!stage) return null;
      const style = getComputedStyle(stage);
      return { справа: style.marginRight, снизу: style.marginBottom };
    })()`,
  );
  check('сцена без зазора — страница во всю область', stageStyle?.снизу === '0px', stageStyle);

  const shot = await ide.capturePage();
  await fs.writeFile(path.join(SHOTS, 'browser-view.png'), shot.toPNG());

  console.log(failed === 0 ? '\nвстроенный браузер работает' : `\nпровалов: ${failed}`);
  console.log(`Снимок: ${path.join(SHOTS, 'browser-view.png')}`);

  server.close();
  terminals.dispose();
  workspace.dispose();
  panel.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(failed === 0 ? 0 : 1);
});
