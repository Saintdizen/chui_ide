/**
 * Панель терминала: вкладки, сессии и связь с pty.
 *
 * Отрисовку и разбор вывода делает свой движок (`terminal/core`, `terminal/view`), а не
 * xterm: шрифт, лигатуры и ширина клетки у него общие с редактором, поэтому консоль и код
 * выглядят одинаково. Здесь остаётся то, что окружает движок: вкладки, создание сессии
 * через RPC, пересылка набранного в pty и вывод обратно.
 *
 * Модель экрана (`Terminal`) и вид (`TermView`) связаны односторонне: вывод pty идёт в
 * модель, модель перерисовывается видом; клавиши с вида кодируются в байты (`input/keys`)
 * и уходят в pty. Про RPC знает только эта панель — движок от него не зависит.
 */

import { PushTopic, type TerminalDataPayload, type TerminalExitPayload, type TerminalSession } from '../../shared/api';
import type { RpcClient } from '../core/rpc';
import { Terminal } from '../terminal/core/screen';
import { searchBuffer, stepMatch } from '../terminal/core/search';
import { shortenShellTitle } from '../terminal/core/title';
import { encodeKey, encodeMouse, encodePaste, isPasteStroke } from '../terminal/input/keys';
import { TermView } from '../terminal/view/term-view';
import { shortcutKey } from '../../shared/physical-key';
import { h, svgIcon } from './dom';
import { showToast } from './toast';

export interface TerminalPanelView {
  element: HTMLElement;
  /**
   * Открыть панель. `cwd` — папка новой сессии; без неё берётся корень области.
   * Уже открытая панель вторую сессию не плодит: `cwd` относится к созданию.
   */
  open(cwd?: string): Promise<void>;
  /** Новая сессия, при желании — в названной папке. */
  newSession(cwd?: string): Promise<void>;
  /**
   * Выполнить готовую команду в новой сессии.
   * Команда набирается в терминале, а не запускается «в фоне»: человек должен
   * видеть процесс, уметь его прервать и посмотреть вывод.
   */
  run(command: string, title?: string): Promise<void>;
  clearActive(): void;
  killActive(): Promise<void>;
  /** Пересчитать размер: вызывать, когда панель стала видимой. */
  fit(): void;
  /** Сменить палитру консоли вместе с темой приложения. */
  /** Перечитать палитру консоли после смены темы. */
  refreshTheme(): void;
  /** Включить или выключить лигатуры — по общей настройке редактора. */
  setLigatures(on: boolean): void;
}

interface SessionView {
  session: TerminalSession;
  term: Terminal;
  view: TermView;
  container: HTMLElement;
  tab: HTMLButtonElement;
  exited: boolean;
  /** Подпись, заданная запуском (`run`). Есть — заголовок от программы её не перебивает. */
  renamed: string | null;
  /** Последнее применённое имя окна: чтобы не трогать DOM на каждом кадре вывода. */
  title: string;
}

/** Размер по умолчанию, пока контейнер не разложен (панель скрыта): обычные 80×24. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** Панель консоли: вкладки, тело и связь сессий с pty. */
export function createTerminalPanel(deps: {
  rpc: RpcClient;
  cwd: () => string | null;
  /** Включать ли лигатуры шрифта — то же значение, что у редактора кода. */
  ligatures: () => boolean;
  /** Ссылка из консоли: решает вызывающий — вкладкой в IDE или системным браузером. */
  openLink: (url: string) => void;
}): TerminalPanelView {
  const tabsHost = h('div', { class: 'term-tabs' });
  const body = h('div', { class: 'term-body' });

  const addButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Новый терминал', onClick: () => void createSession() },
    svgIcon('plus', 15),
  );
  const clearButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Очистить экран', onClick: () => clearActive() },
    svgIcon('refresh', 14),
  );
  const killButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Завершить процесс', onClick: () => void killActive() },
    svgIcon('trash', 14),
  );

  const element = h(
    'div',
    { class: 'terminal-panel' },
    h(
      'div',
      { class: 'term-toolbar' },
      tabsHost,
      h('div', { class: 'toolbar-spacer' }),
      addButton,
      clearButton,
      killButton,
    ),
    body,
  );

  // Панель поиска: висит поверх полотна справа сверху, место у вывода не отнимает.
  const findInput = h('input', {
    class: 'term-find-input',
    type: 'text',
    placeholder: 'Найти в терминале',
    spellcheck: 'false',
  });
  const findCount = h('span', { class: 'term-find-count' });
  const findPrev = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Предыдущее совпадение', onClick: () => findRun(false, -1) },
    svgIcon('chevronUp', 14),
  );
  const findNext = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Следующее совпадение', onClick: () => findRun(false, 1) },
    svgIcon('chevronDown', 14),
  );
  const findClose = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Закрыть поиск', onClick: () => closeFind() },
    svgIcon('close', 14),
  );
  const findBar = h('div', { class: 'term-find' }, findInput, findCount, findPrev, findNext, findClose);
  findBar.hidden = true;
  body.append(findBar);

  // Номер текущего совпадения: -1 — совпадение не выбрано (новый запрос или ничего не нашлось).
  let findCurrent = -1;

  findInput.addEventListener('input', () => {
    findCurrent = -1;
    findRun(true, 1);
  });
  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      findRun(false, event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeFind();
    }
  });

  const sessions = new Map<string, SessionView>();
  /** Вывод, пришедший раньше, чем мы успели зарегистрировать сессию. */
  const orphanData = new Map<string, string[]>();
  let activeId: string | null = null;
  /**
   * Незавершённое создание сессии. Промис, а не флаг: запуску нужно ДОЖДАТЬСЯ
   * той сессии, которую уже создаёт открытие панели, иначе команда уходит
   * в пустоту или появляется вторая вкладка.
   */
  let creating: Promise<string | null> | null = null;

  deps.rpc.onPush((message) => {
    if (message.topic === PushTopic.TerminalData) {
      const payload = message.payload as TerminalDataPayload;
      const entry = sessions.get(payload.id);
      if (entry) {
        entry.term.write(payload.data);
        entry.view.render();
        // Программа могла назвать окно (OSC 0/2) — показываем это во вкладке.
        applyTitle(entry);
      } else {
        const buffer = orphanData.get(payload.id) ?? [];
        buffer.push(payload.data);
        orphanData.set(payload.id, buffer);
      }
      return;
    }

    if (message.topic === PushTopic.TerminalExit) {
      const payload = message.payload as TerminalExitPayload;
      const entry = sessions.get(payload.id);
      if (!entry) return;
      entry.exited = true;
      entry.tab.classList.add('is-exited');
      // Строку о завершении пишем в модель: она переживёт закрытие процесса.
      entry.term.write(`\r\n\x1b[90m[процесс завершён, код ${payload.exitCode}]\x1b[0m\r\n`);
      entry.view.render();
      entry.view.stickToBottom();
    }
  });

  /** Создать сессию и вернуть её id — он нужен, чтобы сразу отправить команду. */
  function createSession(cwd?: string): Promise<string | null> {
    if (creating) return creating;
    const task = openSession(cwd).finally(() => {
      creating = null;
    });
    creating = task;
    return task;
  }

  async function openSession(cwd?: string): Promise<string | null> {
    const container = h('div', { class: 'term-instance' });
    body.appendChild(container);

    // Модель заводим на размере по умолчанию: настоящий размер узнаем после раскладки.
    const term = new Terminal(DEFAULT_COLS, DEFAULT_ROWS);
    // Идентификатор сессии появится после ответа main — до тех пор мышь молчит.
    let sessionId: string | null = null;
    const view = new TermView(container, term, {
      ligatures: deps.ligatures(),
      // Мышь: координаты отдаём в SGR-формате, если программа о нём просила.
      onMouse: (event) => {
        if (!sessionId) return;
        void deps.rpc
          .request('terminal.write', { id: sessionId, data: encodeMouse(event, term.mouseSgr) })
          .catch(() => undefined);
      },
      // Выделение появилось — копируем сразу, как в терминалах Linux с primary selection.
      onSelectionChange: (text) => {
        if (text) void navigator.clipboard.writeText(text).catch(() => undefined);
      },
      // Гиперссылка (OSC 8): решает вызывающий. Локальный адрес открывается вкладкой
      // в IDE (рядом с кодом), чужой — системным браузером; схемы проверяет main.
      onLink: (url) => deps.openLink(url),
    });

    // Подгоняем сетку под контейнер и только потом просим pty: оболочка должна родиться
    // с тем же размером, иначе первая же строка перенесётся не там, где надо.
    const size = view.fit();
    if (size) {
      term.resize(size.cols, size.rows);
      view.render();
    }

    try {
      const session = await deps.rpc.request('terminal.create', {
        cols: size?.cols ?? DEFAULT_COLS,
        rows: size?.rows ?? DEFAULT_ROWS,
        cwd: cwd ?? deps.cwd() ?? undefined,
      });
      sessionId = session.id;

      const tab = h(
        'button',
        { class: 'term-tab', type: 'button', title: `${session.shell} · ${session.cwd}` },
        session.title,
      );
      tab.addEventListener('click', () => activate(session.id));
      tab.addEventListener('auxclick', (event) => {
        if (event.button === 1) void closeSession(session.id);
      });

      const entry: SessionView = { session, term, view, container, tab, exited: false, renamed: null, title: '' };
      sessions.set(session.id, entry);
      tabsHost.appendChild(tab);

      bindInput(entry);

      for (const chunk of orphanData.get(session.id) ?? []) term.write(chunk);
      orphanData.delete(session.id);
      view.render();

      activate(session.id);
      view.focus();
      return session.id;
    } catch (error) {
      container.remove();
      view.dispose();
      showToast(error instanceof Error ? error.message : String(error), 'error');
      return null;
    }
  }

  /**
   * Показать имя окна, запрошенное программой (OSC 0/2). Подпись запуска (`run`) не
   * перебиваем: там имя задачи, и оно важнее для человека. Когда программа снимает имя
   * (пустая строка), возвращаемся к подписи сессии.
   *
   * В подписи вкладки — укороченное имя (`shortenShellTitle`), полное — в подсказке:
   * приглашение с путём целиком растягивало полосу дока.
   */
  function applyTitle(entry: SessionView): void {
    const wanted = entry.term.title;
    if (wanted === entry.title) return;
    entry.title = wanted;
    const full = entry.renamed ?? (wanted === '' ? entry.session.title : wanted);
    entry.tab.title = full;
    entry.tab.textContent = shortenShellTitle(full);
  }

  /** Клавиша для сочетания — по физическому положению: раскладка их не меняет. */
  const shortcutOf = (event: KeyboardEvent): string => shortcutKey(event);

  /** Записать текст в сессию как вставку: с маркерами, если программа о них просила. */
  function writePaste(entry: SessionView, text: string): void {
    const data = encodePaste(text, entry.term.bracketedPaste);
    void deps.rpc.request('terminal.write', { id: entry.session.id, data }).catch(() => undefined);
  }

  /**
   * Вставить буфер обмена. Читаем его сами: терминал — не поле ввода, поэтому браузер
   * не пришлёт ни `paste`, ни готовый текст для `Ctrl+V`.
   */
  function pasteFromClipboard(entry: SessionView): void {
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text) writePaste(entry, text);
      })
      .catch(() => undefined);
  }

  /** Клавиатура и вставка: событие с вида кодируется в байты и уходит в pty. */
  function bindInput(entry: SessionView): void {
    const root = entry.view.element;
    root.addEventListener('keydown', (event) => {
      const stroke = {
        key: event.key,
        // Физическая клавиша рядом с символом: сочетания терминала не должны зависеть
        // от раскладки, а сам ввод по-прежнему идёт символом раскладки.
        code: event.code,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      };
      // Вставка из буфера: `Ctrl+V` (и `Ctrl+Shift+V`) — привычная комбинация. Без
      // этой ветки она уходила в pty как `\x16` — оболочка ждала следующий знак.
      if (isPasteStroke(stroke)) {
        event.preventDefault();
        pasteFromClipboard(entry);
        return;
      }
      // Ctrl+F — поиск в консоли (как в редакторе).
      if (event.ctrlKey && !event.shiftKey && shortcutOf(event) === 'F') {
        event.preventDefault();
        openFind();
        return;
      }
      // Ctrl+Shift+C — копировать выделение (в терминале `Ctrl+C` — сигнал, а не копия).
      if (event.ctrlKey && event.shiftKey && shortcutOf(event) === 'C') {
        const text = entry.view.selectedText();
        if (text) {
          void navigator.clipboard.writeText(text).catch(() => undefined);
          entry.view.clearSelection();
          event.preventDefault();
        }
        return;
      }
      const data = encodeKey(stroke, { applicationCursorKeys: entry.term.applicationCursorKeys });
      if (data === null) return;
      // Не даём браузеру обработать клавишу: `Tab`, `Ctrl+C` и стрелки в терминале —
      // не навигация по интерфейсу, а ввод в консоль.
      event.preventDefault();
      void deps.rpc.request('terminal.write', { id: entry.session.id, data }).catch(() => undefined);
    });

    // Событие `paste` тоже слушаем: его пришлёт контекстное меню и вставка мышью
    // (если полотну когда-нибудь дадут редактируемость). Обычный `Ctrl+V` идёт выше.
    root.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text');
      if (!text) return;
      event.preventDefault();
      writePaste(entry, text);
    });
  }

  function activate(id: string): void {
    const entry = sessions.get(id);
    if (!entry) return;
    activeId = id;
    // Поиск привязан к сессии: у другой вкладки свой вывод.
    if (!findBar.hidden) closeFind();
    // Поиск привязан к сессии: у другой вкладки свой вывод.
    if (!findBar.hidden) closeFind();

    for (const [key, item] of sessions) {
      item.container.hidden = key !== id;
      item.tab.classList.toggle('is-active', key === id);
    }

    fitSession(entry);
    entry.view.focus();
    entry.view.scrollToBottom();
  }

  async function closeSession(id: string): Promise<void> {
    const entry = sessions.get(id);
    if (!entry) return;

    sessions.delete(id);
    entry.tab.remove();
    entry.view.dispose();
    entry.container.remove();
    orphanData.delete(id);

    if (activeId === id) {
      const next = [...sessions.keys()].at(-1);
      activeId = null;
      if (next) activate(next);
    }

    await deps.rpc.request('terminal.kill', { id }).catch(() => undefined);
  }

  /**
   * Подогнать сетку под контейнер. Если размер изменился — сообщаем об этом модели и pty:
   * полноэкранные программы узнают о новом размере только так.
   */
  function fitSession(entry: SessionView): void {
    const size = entry.view.fit();
    if (!size) return;
    if (size.cols === entry.term.cols && size.rows === entry.term.rows) return;

    entry.term.resize(size.cols, size.rows);
    entry.view.render();
    void deps.rpc
      .request('terminal.resize', { id: entry.session.id, cols: size.cols, rows: size.rows })
      .catch(() => undefined);
  }

  /** Открыть панель поиска и встать на первое совпадение. */
  function openFind(): void {
    const entry = active();
    if (!entry) return;
    findBar.hidden = false;
    findInput.focus();
    findInput.select();
    if (findInput.value.length > 0) {
      findCurrent = -1;
      findRun(true, 1);
    }
  }

  /** Закрыть поиск: спрятать панель и снять подсветку. */
  function closeFind(): void {
    findBar.hidden = true;
    findInput.value = '';
    findCount.textContent = '';
    findCurrent = -1;
    const entry = active();
    if (entry) {
      entry.view.clearSearch();
      entry.view.focus();
    }
  }

  /**
   * Прогнать поиск по активной сессии. `reset` — начать с первого совпадения
   * (новый запрос), иначе шаг от текущего. Ходим по кругу, как в редакторе.
   */
  function findRun(reset: boolean, step: number): void {
    const entry = active();
    if (!entry) return;
    const query = findInput.value;
    if (query.length === 0) {
      entry.view.clearSearch();
      findCount.textContent = '';
      return;
    }
    const result = searchBuffer((row) => entry.view.lineText(row), entry.view.bufferRows(), query);
    if (result.error) {
      entry.view.clearSearch();
      findCount.textContent = 'ошибка';
      return;
    }
    if (result.matches.length === 0) {
      entry.view.clearSearch();
      findCount.textContent = 'нет';
      return;
    }
    if (reset) findCurrent = -1;
    findCurrent = stepMatch(findCurrent, result.matches.length, step);
    entry.view.showSearch(result.matches, findCurrent);
    findCount.textContent = `${findCurrent + 1}/${result.matches.length}`;
  }
  function active(): SessionView | null {
    return activeId ? (sessions.get(activeId) ?? null) : null;
  }

  function clearActive(): void {
    const entry = active();
    if (!entry) return;
    // Очистка экрана — это ED 2 (весь экран), ED 3 (история) и возврат курсора домой:
    // так же это делает сама оболочка по `clear`.
    entry.term.write('\x1b[2J\x1b[3J\x1b[H');
    entry.view.render();
  }

  async function killActive(): Promise<void> {
    if (activeId) await closeSession(activeId);
  }

  const resizeObserver = new ResizeObserver(() => {
    const entry = active();
    if (entry && !entry.exited) fitSession(entry);
  });
  resizeObserver.observe(body);

  return {
    element,
    async open(cwd) {
      if (sessions.size === 0) await createSession(cwd);
      else {
        const entry = active();
        if (entry) fitSession(entry);
      }
    },
    newSession: async (cwd) => {
      await createSession(cwd);
    },
    async run(command, title) {
      // Команда идёт в уже открытую оболочку, а не в новую вкладку: вкладка
      // создаётся только если терминала ещё нет. Панель показывает вызывающая
      // сторона — поэтому здесь никакой связи с доком.
      const current = active();
      const id = current && !current.exited ? current.session.id : await createSession();
      if (!id) return;

      const entry = sessions.get(id);
      if (entry && title) {
        // Имя вкладки — по запуску: видно, что это запуск, а не
        // свободная оболочка. Подсказка хранит саму команду, если она отличается
        // от имени (у задачи из package.json они совпадают).
        entry.tab.textContent = title;
        entry.tab.title = title === command ? title : `${title} · ${command}`;
        // Подпись задачи закрепляем за вкладкой: заголовок от программы её не заменит.
        entry.renamed = title;
        activate(id);
      }
      await deps.rpc.request('terminal.write', { id, data: `${command}\r` }).catch(() => undefined);
      entry?.view.focus();
    },
    clearActive,
    killActive,
    fit() {
      const entry = active();
      if (entry) fitSession(entry);
    },
    refreshTheme() {
      for (const entry of sessions.values()) entry.view.refreshTheme();
    },
    setLigatures(on: boolean) {
      for (const entry of sessions.values()) entry.view.setLigatures(on);
    },
  };
}
