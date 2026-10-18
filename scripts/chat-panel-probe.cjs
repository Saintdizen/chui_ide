/**
 * Проба панели ассистента: вкладки бесед и композер.
 *
 *   npm run probe:chat
 *
 * Панель ассистента разобрана на модули: полоса вкладок с поиском живёт в
 * `ui/chat-tabs.ts`, панель ввода — в `ui/chat-composer.ts`, а `chat.ts` их только
 * собирает. Юнит-тесты этого не видят вовсе (они идут в окружении node, без DOM),
 * поэтому проверяем в живом окне: панель открывается, вкладки создаются, закрываются,
 * переключаются с сохранением черновика, у вкладки есть контекстное меню, поиск
 * открывается, а композер показывает режим, права, модель и усилие.
 *
 * Беседу НЕ отправляем: для ответа нужен провайдер, а проба о сети и не про ответ.
 * Проверяем устройство и поведение, а не разговор с моделью.
 *
 * Нужен собранный main и renderer (npm run build). Отчёт — вывод в консоль,
 * снимки — `.chui_ide/probe-shots/chat-panel-*.png`.
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { ChatStore } = require('../dist/main/ai/chat-store.js');
const { HostClient } = require('../dist/main/ipc/host.js');
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
  const file = path.join(SHOTS, `chat-panel-${name}.png`);
  await fs.writeFile(file, image.toPNG());
  return file;
}

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-chat-probe-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), '# demo\n', 'utf8');
  await fs.mkdir(SHOTS, { recursive: true });

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  // Беседы пишем в свой каталог: проверка не трогает настоящий userData.
  const chatStore = new ChatStore(path.join(dir, 'chats'));
  registerIpc({ settings, workspace, ai, terminals, git, chatStore, host: new HostClient() });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  // Панель ассистента открыта по умолчанию (layout.rightVisible). Если она всё же
  // скрыта — открываем командой из палитры, тем же путём, что и человек.
  const visible = await ask(
    ide,
    `(() => {
      const el = document.querySelector('.chat');
      if (!el) return 'нет панели в разметке';
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    })()`,
  );
  check('панель ассистента есть в окне', visible === true, visible);

  /* ── пустое состояние ─────────────────────────────────────────────────── */

  // Подсказка пустой беседы стоит по центру области: строкой в левом верхнем углу
  // она читалась как обрезанное сообщение, а в панели на 400 px липла к краю.
  const intro = await ask(
    ide,
    `(() => {
      const body = document.querySelector('.chat-body');
      const node = document.querySelector('.chat-intro');
      if (!body || !node) return null;
      const area = body.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const inner = body.clientWidth - parseFloat(getComputedStyle(body).paddingLeft) - parseFloat(getComputedStyle(body).paddingRight);
      return {
        вЛево: Math.round(box.left - area.left),
        вПраво: Math.round(area.right - box.right),
        центрX: Math.round(box.left + box.width / 2 - (area.left + area.width / 2)),
        центрY: Math.round(box.top + box.height / 2 - (area.top + area.height / 2)),
        ширина: Math.round(box.width),
        ширинаОбласти: Math.round(inner),
        выравнивание: style.textAlign,
      };
    })()`,
  );
  check('подсказка пустой беседы есть в панели', intro !== null, intro === null ? 'нет .chat-intro' : undefined);
  check('подсказка стоит по центру области по горизонтали', Math.abs(intro?.центрX ?? 999) <= 4, {
    центрX: intro?.центрX,
    вЛево: intro?.вЛево,
    вПраво: intro?.вПраво,
  });
  check('подсказка стоит по центру области по вертикали', Math.abs(intro?.центрY ?? 999) <= 8, {
    центрY: intro?.центрY,
  });
  check('текст подсказки выровнен по центру', intro?.выравнивание === 'center', intro?.выравнивание);
  check('строка подсказки не растянута во всю ширину панели', (intro?.ширина ?? 0) < (intro?.ширинаОбласти ?? 0) - 20, {
    ширина: intro?.ширина,
    ширинаОбласти: intro?.ширинаОбласти,
  });
  console.log(`  снимок пустой беседы: ${await shot(ide, 'intro')}`);

  /* ── вкладки бесед ─────────────────────────────────────────────────────── */

  const tabsState = () =>
    ask(
      ide,
      `(() => {
        const tabs = [...document.querySelectorAll('.chat-tab-list .chat-tab')];
        return {
          всего: tabs.length,
          подписи: tabs.map((tab) => tab.querySelector('.tab-label')?.textContent ?? ''),
          активная: document.querySelector('.chat-tab.is-active .tab-label')?.textContent ?? null,
        };
      })()`,
    );

  const initial = await tabsState();
  check('при старте одна беседа', initial.всего === 1, initial);
  check('подпись первой беседы — «Беседа 1»', initial.подписи[0] === 'Беседа 1', initial.подписи);

  const created = await ask(
    ide,
    `(async () => {
      const button = [...document.querySelectorAll('.icon-btn')].find(
        (node) => node.getAttribute('title') === 'Новая беседа',
      );
      if (!button) return 'нет кнопки «Новая беседа»';
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const tabs = [...document.querySelectorAll('.chat-tab-list .chat-tab')];
      return {
        всего: tabs.length,
        подписи: tabs.map((tab) => tab.querySelector('.tab-label')?.textContent ?? ''),
        активная: document.querySelector('.chat-tab.is-active .tab-label')?.textContent ?? null,
      };
    })()`,
  );
  check('кнопка «Новая беседа» добавила вкладку', created.всего === 2, created);
  check('новая беседа стала активной', created.активная === 'Беседа 2', created.активная);

  // Черновик живёт у беседы: переключение вкладок его сохраняет и возвращает.
  const draft = await ask(
    ide,
    `(async () => {
      const input = document.querySelector('.chat-input');
      input.value = 'черновик второй беседы';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const tabs = [...document.querySelectorAll('.chat-tab-list .chat-tab')];
      tabs[0].click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const наПервой = input.value;
      tabs[1].click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { наПервой, наВторой: input.value };
    })()`,
  );
  check('черновик не протёк в чужую беседу', draft.наПервой === '', draft);
  check('черновик вернулся на свою вкладку', draft.наВторой === 'черновик второй беседы', draft);

  // Контекстное меню вкладки: правый клик по ней.
  const menu = await ask(
    ide,
    `(async () => {
      const tab = document.querySelector('.chat-tab-list .chat-tab');
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 90 }));
      await new Promise((resolve) => setTimeout(resolve, 150));
      const items = [...document.querySelectorAll('.context-menu .context-label')].map((n) => n.textContent);
      return { открыто: Boolean(document.querySelector('.context-menu')), пункты: items };
    })()`,
  );
  check('правый клик по вкладке открыл меню', menu.открыто === true, menu);
  check(
    'в меню есть закрытие беседы',
    Array.isArray(menu.пункты) && menu.пункты.includes('Закрыть беседу'),
    menu.пункты,
  );
  check(
    'в меню есть перенос в редактор',
    Array.isArray(menu.пункты) && menu.пункты.some((text) => text.includes('редактора') || text.includes('панель')),
    menu.пункты,
  );

  await shot(ide, 'tabs');

  // Закрываем меню (Esc) и закрываем вкладку крестиком.
  const closed = await ask(
    ide,
    `(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 120));
      const close = document.querySelector('.chat-tab-list .chat-tab .tab-close');
      if (!close) return 'нет крестика';
      close.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const tabs = [...document.querySelectorAll('.chat-tab-list .chat-tab')];
      return { всего: tabs.length, подписи: tabs.map((tab) => tab.querySelector('.tab-label')?.textContent ?? '') };
    })()`,
  );
  check('крестик закрыл вкладку', closed.всего === 1, closed);

  /* ── поиск по беседам ──────────────────────────────────────────────────── */

  const search = await ask(
    ide,
    `(async () => {
      const button = [...document.querySelectorAll('.icon-btn')].find(
        (node) => node.getAttribute('title') === 'Поиск по беседам',
      );
      if (!button) return 'нет кнопки поиска';
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const bar = document.querySelector('.chat-search');
      const открыт = bar ? !bar.hidden : false;
      const field = document.querySelector('.chat-search-input');
      field.value = 'нетакогослова';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 150));
      const пусто = document.querySelector('.chat-search-empty')?.textContent ?? null;
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { открыт, пусто, закрыт: document.querySelector('.chat-search').hidden };
    })()`,
  );
  check('кнопка поиска открыла полосу', search.открыт === true, search);
  check('пустая история даёт «Ничего не найдено»', search.пусто === 'Ничего не найдено', search.пусто);
  check('Escape закрыл поиск', search.закрыт === true, search);

  /* ── композер ──────────────────────────────────────────────────────────── */

  const composer = await ask(
    ide,
    `(() => {
      const box = document.querySelector('.composer-box');
      const selects = [...document.querySelectorAll('.composer-select')];
      const mode = selects.find((node) => {
        const text = node.querySelector('.select-value')?.textContent ?? '';
        return ['Вопрос', 'Агент', 'План'].includes(text);
      });
      const effort = selects.find((node) => node !== mode);
      return {
        есть_поле: Boolean(document.querySelector('.chat-input')),
        есть_скрепка: Boolean([...document.querySelectorAll('.icon-btn')].find(
          (node) => (node.getAttribute('title') ?? '').startsWith('Приложить контекст'),
        )),
        режим: mode ? mode.querySelector('.select-value')?.textContent : null,
        режим_заголовок: mode ? mode.getAttribute('title')?.slice(0, 24) : null,
        права_выключены: document.querySelector('.composer-perm')?.disabled ?? null,
        модель: document.querySelector('.composer-model')?.textContent ?? null,
        усилие: effort ? effort.querySelector('.select-value')?.textContent : null,
        кнопка: document.querySelector('.composer-action')?.getAttribute('title') ?? null,
        _пусто: box ? box.childElementCount : 0,
      };
    })()`,
  );
  check('композер собран', composer.есть_поле === true && composer._пусто > 0, composer);
  check('скрепка «Приложить контекст» на месте', composer.есть_скрепка === true);
  check('режим по умолчанию — «Вопрос»', composer.режим === 'Вопрос', composer.режим);
  check('в «Вопросе» права недоступны', composer.права_выключены === true, composer.права_выключены);
  check('усилие по умолчанию — без размышлений', composer.усилие === 'Без размышлений', composer.усилие);
  check('кнопка отправки подписана', composer.кнопка === 'Отправить (Enter)', composer.кнопка);

  // Переключаем режим на «Агент» через настоящий список выбора: права должны стать
  // доступными. Это и проверяет связку «режим → права», вынесенную в chat-composer.ts.
  const modeSwitched = await ask(
    ide,
    `(async () => {
      const mode = [...document.querySelectorAll('.composer-select')].find((node) => {
        const text = node.querySelector('.select-value')?.textContent ?? '';
        return ['Вопрос', 'Агент', 'План'].includes(text);
      });
      if (!mode) return 'нет селекта режима';
      mode.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const item = [...document.querySelectorAll('.select-popup .select-item')].find(
        (node) => (node.querySelector('.select-item-label')?.textContent ?? '') === 'Агент',
      );
      if (!item) return 'нет пункта «Агент»';
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        режим: mode.querySelector('.select-value')?.textContent ?? null,
        знак_режима: document.querySelector('.composer-status-item')?.getAttribute('title') ?? null,
        права_выключены: document.querySelector('.composer-perm')?.disabled ?? null,
        права_подсказка: document.querySelector('.composer-perm')?.getAttribute('title') ?? null,
      };
    })()`,
  );
  check('режим переключился на «Агент»', modeSwitched.режим === 'Агент', modeSwitched);
  check(
    'значок статуса сказал про инструменты',
    modeSwitched.знак_режима === 'Инструменты разрешены',
    modeSwitched.знак_режима,
  );
  check('в «Агенте» права доступны', modeSwitched.права_выключены === false, modeSwitched.права_выключены);
  check(
    'подсказка прав объясняет действие',
    typeof modeSwitched.права_подсказка === 'string' && modeSwitched.права_подсказка.includes('разрешение'),
    modeSwitched.права_подсказка,
  );

  // Тумблер прав: клик меняет вид на «полный доступ».
  const toggled = await ask(
    ide,
    `(async () => {
      const perm = document.querySelector('.composer-perm');
      perm.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { активна: perm.classList.contains('is-active'), подсказка: perm.getAttribute('title') };
    })()`,
  );
  check('тумблер прав включил полный доступ', toggled.активна === true, toggled);
  check(
    'подсказка прав сказала про полный доступ',
    typeof toggled.подсказка === 'string' && toggled.подсказка.includes('без подтверждений'),
    toggled.подсказка,
  );

  /* ── вёрстка тулбара композера ──────────────────────────────────────────── */

  // Панель ассистента узкая: все контролы в один ряд не встают. Регрессия:
  // тулбар-флекс ставил группу действий («приложить», «отправить») ОТДЕЛЬНОЙ
  // строкой ПОД настройками, и кнопка отправки висела одна на почти пустом
  // ряду. Теперь тулбар — сетка из двух колонок, и группа действий прижата к
  // НИЖНЕМУ краю: её низ совпадает с низом настроек, а правая кромка — с правой
  // кромкой тулбара. Проверяем геометрию: рядами это по разметке не видно.
  const toolbar = await ask(
    ide,
    `(() => {
      const tb = document.querySelector('.composer-toolbar');
      const group = document.querySelector('.composer-toolbar .composer-group');
      const end = document.querySelector('.composer-group-end');
      if (!tb || !group || !end) return null;
      const t = tb.getBoundingClientRect();
      const g = group.getBoundingClientRect();
      const e = end.getBoundingClientRect();
      return {
        display: getComputedStyle(tb).display,
        overflow: tb.scrollWidth > tb.clientWidth,
        endBottom: Math.round(e.bottom),
        groupBottom: Math.round(g.bottom),
        endRight: Math.round(e.right),
        barRight: Math.round(t.right),
      };
    })()`,
  );
  check('тулбар композера — сетка в две колонки', toolbar?.display === 'grid', toolbar?.display);
  check('тулбар не переполняется по ширине', toolbar?.overflow === false, toolbar?.overflow);
  check(
    'кнопки «приложить» и «отправить» прижаты к низу тулбара, а не отдельной строкой',
    toolbar !== null && Math.abs(toolbar.endBottom - toolbar.groupBottom) <= 1,
    toolbar && { endBottom: toolbar.endBottom, groupBottom: toolbar.groupBottom },
  );
  check(
    'группа действий выровнена по правой кромке тулбара',
    toolbar !== null && toolbar.endRight === toolbar.barRight,
    toolbar && { endRight: toolbar.endRight, barRight: toolbar.barRight },
  );

  /* ── «Информация о сессии» поверх области редактора ─────────────────────── */

  // Окно «Информация о сессии» живёт в полосе статуса и раскрывается ВВЕРХ —
  // то есть над полотном редактора. Когда чат перенесён в редактор, вкладка чата
  // лежит там же и своим слоем (`--layer_view`) закрывала окно: кнопка «кольцо»
  // нажималась, а окна не было видно. Проверяем не «открылось ли», а что окно
  // оказалось сверху — точкой в его центре.
  const popupState = () =>
    ask(
      ide,
      `(() => {
        const popup = document.querySelector('.session-info');
        if (!popup || popup.hidden) return { открыто: false };
        const box = popup.getBoundingClientRect();
        const top = document.elementFromPoint(Math.round(box.left + box.width / 2), Math.round(box.top + 8));
        return {
          открыто: true,
          сверху: popup.contains(top),
          чейСлой: top ? (top.closest('.chat-editor') ? 'чат в редакторе' : top.className || top.tagName) : null,
        };
      })()`,
    );

  const clickRing = () =>
    ask(
      ide,
      `(async () => {
        const ring = document.querySelector('.context-ring');
        if (!ring) return 'нет кольца';
        ring.click();
        await new Promise((resolve) => setTimeout(resolve, 200));
        return 'нажато';
      })()`,
    );

  const runCommand = (title) =>
    ask(
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
        input.value = ${JSON.stringify(title)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        const item = [...document.querySelectorAll('.palette-item')].find((node) =>
          (node.textContent ?? '').includes(${JSON.stringify(title)}),
        );
        if (!item) return 'пункта нет';
        item.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
        return 'выполнено';
      })()`,
    );

  await clickRing();
  const popupInPanel = await popupState();
  check(
    'окно «Информация о сессии» видно над панелью ассистента',
    popupInPanel.открыто === true && popupInPanel.сверху === true,
    popupInPanel,
  );
  await clickRing();

  const moved = await runCommand('Перенести чат в окно редактора');
  check('чат перенесён в область редактора', moved === 'выполнено', moved);
  const inEditor = await ask(
    ide,
    `(() => {
      const panel = document.querySelector('.chat-editor .chat');
      const box = panel?.getBoundingClientRect();
      return Boolean(box && box.width > 0 && box.height > 0);
    })()`,
  );
  check('чат в редакторе занимает область', inEditor === true, inEditor);

  await clickRing();
  const popupInEditor = await popupState();
  check(
    'окно «Информация о сессии» видно и поверх чата в редакторе',
    popupInEditor.открыто === true && popupInEditor.сверху === true,
    popupInEditor,
  );
  console.log(`  снимок окна поверх чата в редакторе: ${await shot(ide, 'session-info')}`);
  await clickRing();

  const back = await runCommand('Вернуть чат в боковую панель');
  check('чат вернулся в боковую панель', back === 'выполнено', back);

  /* ── сохранение и восстановление ───────────────────────────────────────── */

  // Вторая беседа: к этому месту в пробе одна закрыта, так что проверяем на двух.
  await ask(
    ide,
    `(async () => {
      const button = [...document.querySelectorAll('.icon-btn')].find(
        (node) => node.getAttribute('title') === 'Новая беседа',
      );
      button.click();
      return true;
    })()`,
  );
  // Даём сработать отложенной записи (400 мс) и смотрим, что ушло в файл.
  await wait(800);
  const before = await ask(
    ide,
    `(() => {
      const tabs = [...document.querySelectorAll('.chat-tab-list .chat-tab')];
      return {
        подписи: tabs.map((tab) => tab.querySelector('.tab-label')?.textContent ?? ''),
        активная: document.querySelector('.chat-tab.is-active .tab-label')?.textContent ?? null,
      };
    })()`,
  );
  check('перед записью в панели две беседы', before.подписи?.length === 2, before);

  const chatDir = path.join(dir, 'chats');
  const chatFile = (await fs.readdir(chatDir).catch(() => [])).find((name) => name.endsWith('.json'));
  check('беседы записаны в файл проекта', Boolean(chatFile), chatFile);

  const saved = chatFile ? JSON.parse(await fs.readFile(path.join(chatDir, chatFile), 'utf8')) : { conversations: [] };
  const uids = saved.conversations.map((item) => item.uid);
  check('в файле обе беседы', saved.conversations.length === 2, saved.conversations.length);
  check('uid бесед разные', uids.length === 2 && uids[0] !== uids[1], uids);
  check('активной записана вторая беседа', saved.activeUid === uids[1], { activeUid: saved.activeUid, uids });

  // Переоткрытие: окно IDE одно на приложение, поэтому закрываем его и поднимаем
  // заново — новый renderer читает беседы уже из файла. Приложение при закрытии
  // последнего окна завершилось бы, поэтому выход на время переоткрытия глушим.
  const realQuit = app.quit.bind(app);
  app.quit = () => undefined;
  const shotFile = await shot(ide, 'composer');
  ide.destroy();
  await wait(2000);
  const second = openIdeWindow();
  app.quit = realQuit;
  await wait(6000);

  const restored = await ask(
    second,
    `(() => {
      const tabs = [...document.querySelectorAll('.chat-tab-list .chat-tab')];
      return {
        подписи: tabs.map((tab) => tab.querySelector('.tab-label')?.textContent ?? ''),
        активная: document.querySelector('.chat-tab.is-active .tab-label')?.textContent ?? null,
      };
    })()`,
  );
  check('окно подняло обе беседы из файла', restored.подписи?.length === 2, restored);
  check(
    'заголовки бесед совпали с сохранёнными',
    Array.isArray(restored.подписи) && restored.подписи.join('|') === (before.подписи ?? []).join('|'),
    { было: before.подписи, стало: restored.подписи },
  );
  check('активной поднялась та же беседа', restored.активная === before.активная, {
    было: before.активная,
    стало: restored.активная,
  });

  console.log(`\n[проба] снимок: ${shotFile}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(
    failed
      ? '[проба] панель ассистента: есть расхождения'
      : '[проба] вкладки и композер работают, беседы пережили переоткрытие',
  );
  app.exit(failed ? 1 : 0);
});
