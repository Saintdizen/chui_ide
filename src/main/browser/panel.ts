import { type BrowserWindow, WebContentsView, type WebContents } from 'electron';
import { PushTopic, type BrowserAction, type BrowserNavState, type BrowserRect } from '../../shared/api';
import { normalizeBrowserUrl } from '../../shared/browser';
import { isWebPageUrl, isSafeExternalUrl } from '../../shared/url';

/**
 * Встроенный браузер: страница рисуется `WebContentsView` — отдельным слоем окна
 * (как во встроенных браузерах редакторов), а не тегом `<webview>` в DOM.
 *
 * Почему так. `<webview>` — устаревающий тег, и вся его возня (санитизация
 * `will-attach-webview`, пляска вокруг момента готовности) существует только
 * ради него. `WebContentsView` — то, что Electron советует вместо тега, и у него
 * есть важное свойство: это ТО ЖЕ вложение, к которому агент может подключиться
 * по CDP прямо из main (`webContents.debugger`), без отдельного процесса Chromium
 * и без WebSocket. Одна страница — и человек её видит вкладкой, и агент работает
 * с ней же, а не с копией.
 *
 * Цена — раскладка. Вложение не в DOM: оно лежит поверх содержимого окна, и место
 * ему задают числами. Поэтому прямоугольник области редактора меряет renderer
 * (`getBoundingClientRect`) и присылает сюда, а всё, что должно быть ПОВЕРХ
 * страницы (палитра, окна, уведомления), требует спрятать вложение — этот слой
 * перекрывает и DOM.
 *
 * Профиль сессии: у страниц человека — постоянный (`persist:`), чтобы логины и
 * куки переживали перезапуск. Раздел агента приходит снаружи: страницы, которые
 * открыл агент, живут во временной сессии и сессий человека не видят.
 */

/** Раздел сессии вкладок человека: логины и куки переживают перезапуск IDE. */
export const HUMAN_PARTITION = 'persist:chui-browser';

/**
 * Раздел сессии страниц агента. Без `persist:` — сессия в памяти: агент работает
 * с пустым профилем и не добирается до того, где человек вошёл в свой аккаунт.
 */
export const AGENT_PARTITION = 'chui-browser-agent';

export interface BrowserPanelDeps {
  /** Окно IDE. `null` — приложение ещё без окна: вложение создавать некуда. */
  window(): BrowserWindow | null;
  /** Уведомить renderer: вложение сообщило о своём состоянии. */
  notify(topic: string, payload: unknown): void;
  /** Отдать адрес браузеру системы: всплывающие окна с чужой схемой. */
  openExternal(url: string): void;
}

/** Одна вкладка: вложение и то, что мы о ней знаем. */
interface Entry {
  view: WebContentsView;
  /** Последняя неудача загрузки: о ней сообщаем один раз, а не на каждый чих. */
  error?: string;
  /** Хвост журнала консоли: страница пишет в неё, а мы держим последнее. */
  console: string[];
}

/** Сколько строк консоли держим на вкладку: это контекст для модели, а не лог. */
const CONSOLE_LIMIT = 200;

/**
 * Разбор события консоли страницы. Сигнатуру Electron менял: сначала
 * `(event, level, message, line, sourceId)`, позже — один объект-деталь.
 * Понимаем оба вида, чтобы не зависеть от версии.
 */
function pushConsole(entry: Entry | undefined, args: readonly unknown[]): void {
  if (!entry) return;
  const first = args[0] as { message?: unknown; level?: unknown } | undefined;
  let level: unknown;
  let message: string;
  if (first !== null && typeof first === 'object' && typeof first.message === 'string') {
    level = first.level;
    message = first.message;
  } else {
    level = args[1];
    message = typeof args[2] === 'string' ? args[2] : '';
  }
  if (!message) return;
  const name = typeof level === 'string' ? level : level === 3 ? 'error' : level === 2 ? 'warning' : 'log';
  entry.console.push('[' + name + '] ' + message);
  if (entry.console.length > CONSOLE_LIMIT) entry.console.splice(0, entry.console.length - CONSOLE_LIMIT);
}

export interface BrowserViewState extends BrowserNavState {
  id: string;
}

export class BrowserPanel {
  private readonly views = new Map<string, Entry>();
  /** Какое вложение сейчас прикреплено к окну: остальные живут, но не показаны. */
  private activeId: string | null = null;
  /** Вкладка агента: одна на сессию, чтобы `browser_open` не плодил вкладки. */
  private agentId: string | null = null;
  /** Вкладка, которой человек поделился с агентом: `null` — не делились. */
  private sharedId: string | null = null;
  /** Счётчик ключей вкладок агента: они не должны совпадать с ключами renderer'а. */
  private agentSeq = 0;
  /** Прикреплено ли активное вложение прямо сейчас. */
  private attached = false;
  /** Где стоит вложение: renderer присылает и при показе, и при переезде области. */
  private rect: BrowserRect | null = null;
  /** Слушатель закрытия окна: с ним вместе уходят и вложения. */
  private watched: BrowserWindow | null = null;

  constructor(private readonly deps: BrowserPanelDeps) {}

  /** Есть ли вложение для вкладки. Нужно инструментам агента и пробам. */
  contents(id: string): WebContents | null {
    return this.views.get(id)?.view.webContents ?? null;
  }

  /** Все вложения, какие есть: ключ → страница. Агенту для выбора цели. */
  ids(): string[] {
    return [...this.views.keys()];
  }

  /**
   * Завести вложение для вкладки. Адрес приходит нормализованным, но проверяем
   * ещё раз: схему мы пускаем только сетевую, а вход сюда — из renderer.
   */
  create(id: string, rawUrl: string, partition = HUMAN_PARTITION): { ok: boolean; reason?: string } {
    const window = this.deps.window();
    if (!window || window.isDestroyed()) return { ok: false, reason: 'Окно редактора не открыто' };

    const normalized = normalizeBrowserUrl(rawUrl);
    if (!normalized.ok) return { ok: false, reason: normalized.reason };
    if (!isWebPageUrl(normalized.url)) return { ok: false, reason: 'Открываю только http и https' };

    const existing = this.views.get(id);
    if (existing) {
      // Вложение уже заведено. Адрес второй раз НЕ грузим: у вкладки один адрес и
      // одно вложение, а перезагрузка сбила бы работу — main заводит вкладку агенту
      // сам, и renderer потом просит ту же вкладку по тому же ключу.
      return { ok: true };
    }

    const view = new WebContentsView({
      webPreferences: {
        partition,
        // Гостю не нужно ничего нашего: ни preload, ни Node, ни общий контекст.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    this.views.set(id, { view, console: [] });
    this.wire(window, id, view);
    if (this.rect) view.setBounds(this.rect);
    void view.webContents.loadURL(normalized.url).catch(() => undefined);
    return { ok: true };
  }

  /** Показать вкладку на месте области редактора: остальные вложения отцепляем. */
  show(id: string, rect: BrowserRect): { ok: boolean } {
    const window = this.deps.window();
    const entry = this.views.get(id);
    if (!window || window.isDestroyed() || !entry) return { ok: false };

    this.rect = rect;
    this.detach(window);
    this.activeId = id;
    window.contentView.addChildView(entry.view);
    entry.view.setBounds(rect);
    this.attached = true;
    this.publish(id);
    return { ok: true };
  }

  /** Спрятать вложение: активна не страница (файл, чат, картинка) или открыт оверлей. */
  hide(): { ok: boolean } {
    const window = this.deps.window();
    if (window && !window.isDestroyed()) this.detach(window);
    return { ok: true };
  }

  /** Область редактора переехала (окно, панели, док) — переставляем вложение. */
  layout(rect: BrowserRect): { ok: boolean } {
    this.rect = rect;
    if (!this.attached || !this.activeId) return { ok: true };
    this.views.get(this.activeId)?.view.setBounds(rect);
    return { ok: true };
  }

  command(id: string, action: BrowserAction, rawUrl?: string): { ok: boolean; reason?: string } {
    const contents = this.views.get(id)?.view.webContents;
    if (!contents) return { ok: false, reason: 'Вкладка не найдена' };

    switch (action) {
      case 'back':
        goBy(contents, -1);
        return { ok: true };
      case 'forward':
        goBy(contents, 1);
        return { ok: true };
      case 'reload':
        contents.reload();
        return { ok: true };
      case 'stop':
        contents.stop();
        return { ok: true };
      case 'devtools':
        // Вложение — не элемент окна, поэтому «пристыкованные» инструменты ему некуда
        // лечь: открываем отдельным окном.
        contents.openDevTools({ mode: 'detach' });
        return { ok: true };
      case 'navigate': {
        const normalized = normalizeBrowserUrl(rawUrl ?? '');
        if (!normalized.ok) return { ok: false, reason: normalized.reason };
        this.clearError(id);
        void contents.loadURL(normalized.url).catch(() => undefined);
        return { ok: true };
      }
    }
  }

  close(id: string): { ok: boolean } {
    const entry = this.views.get(id);
    if (!entry) return { ok: true };
    const window = this.deps.window();
    if (window && !window.isDestroyed() && this.activeId === id) this.detach(window);
    this.views.delete(id);
    if (this.activeId === id) this.activeId = null;
    // Вкладка ушла — делиться больше нечем: снимаем общий доступ, чтобы агент не
    // прицепился к мёртвому вложению.
    if (this.sharedId === id) {
      this.sharedId = null;
      this.deps.notify(PushTopic.BrowserNav, { kind: 'unshared', id });
    }
    // Вложение держит процесс: без закрытия он остался бы жить впустую.
    entry.view.webContents.close();
    return { ok: true };
  }

  closeAll(): { ok: boolean } {
    for (const id of [...this.views.keys()]) this.close(id);
    return { ok: true };
  }

  /**
   * Открыть страницу для агента: своя вкладка в полосе человека и ВРЕМЕННАЯ сессия.
   *
   * Человек должен видеть, что делает агент, — поэтому вкладка настоящая, а renderer
   * о ней узнаёт событием `opened`. Сессия — временная: страница агента не должна
   * добираться до того, где человек вошёл в свой аккаунт (см. `AGENT_PARTITION`).
   */
  openForAgent(rawUrl: string): { ok: boolean; id?: string; reason?: string } {
    const normalized = normalizeBrowserUrl(rawUrl);
    if (!normalized.ok) return { ok: false, reason: normalized.reason };

    // Вкладка агента живёт до `closeAgent`: второй `browser_open` идёт в неё же.
    if (this.agentId && this.views.has(this.agentId)) {
      const id = this.agentId;
      const moved = this.command(id, 'navigate', normalized.url);
      return moved.ok ? { ok: true, id } : { ok: false, reason: moved.reason };
    }

    this.agentSeq += 1;
    const id = `agent-${this.agentSeq}`;
    const created = this.create(id, normalized.url, AGENT_PARTITION);
    if (!created.ok) return created;
    this.agentId = id;
    this.deps.notify(PushTopic.BrowserNav, { kind: 'opened', id, url: normalized.url });
    return { ok: true, id };
  }

  /** Агент закончил: вложение закрываем, а renderer убирает вкладку. */
  closeAgent(): void {
    const id = this.agentId;
    if (!id) return;
    this.agentId = null;
    this.close(id);
    this.deps.notify(PushTopic.BrowserNav, { kind: 'closed', id });
  }

  /** Текущая общая вкладка: `null`, если человек ничем не поделился (или вкладка ушла). */
  get sharedPageId(): string | null {
    return this.sharedId && this.views.has(this.sharedId) ? this.sharedId : null;
  }

  /**
   * Поделиться вкладкой с ассистентом. Это осознанное действие человека: без него
   * агент работает только в своей вкладке во временной сессии и до сессий человека
   * не добирается (`AGENT_PARTITION`). Поделившись, человек отдаёт агенту ровно эту
   * страницу — вместе с её логином и куками, поэтому и отзывается доступ одной кнопкой.
   */
  share(id: string): { ok: boolean; reason?: string } {
    if (!this.views.has(id)) return { ok: false, reason: 'Вкладка не найдена' };
    this.sharedId = id;
    this.deps.notify(PushTopic.BrowserNav, { kind: 'shared', id });
    return { ok: true };
  }

  /** Отозвать общий доступ: агент снова заводит свою вкладку. */
  unshare(): { ok: boolean } {
    const id = this.sharedId;
    this.sharedId = null;
    if (id) this.deps.notify(PushTopic.BrowserNav, { kind: 'unshared', id });
    return { ok: true };
  }

  /** Что страница вывела в консоль: хвост журнала для вложения-контекста. */
  consoleLines(id: string): string[] {
    return [...(this.views.get(id)?.console ?? [])];
  }

  /**
   * Снимок страницы: уходит в чат картинкой. Вложение — слой окна, а не элемент
   * документа, поэтому снять его может только main.
   */
  async capture(id: string): Promise<{ ok: boolean; dataUrl?: string; reason?: string }> {
    const contents = this.views.get(id)?.view.webContents;
    if (!contents) return { ok: false, reason: 'Вкладка не найдена' };
    try {
      const image = await contents.capturePage();
      return { ok: true, dataUrl: image.toDataURL() };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  dispose(): void {
    this.closeAll();
  }

  /** Текущее состояние вкладки: им живут адресная строка и кнопки. */
  private stateOf(id: string): BrowserViewState | null {
    const entry = this.views.get(id);
    if (!entry) return null;
    const contents = entry.view.webContents;
    return {
      id,
      url: contents.getURL(),
      title: contents.getTitle() || contents.getURL(),
      loading: contents.isLoading(),
      canGoBack: canGo(contents, -1),
      canGoForward: canGo(contents, 1),
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  private publish(id: string): void {
    const state = this.stateOf(id);
    if (state) this.deps.notify(PushTopic.BrowserNav, { kind: 'state', ...state });
  }

  private clearError(id: string): void {
    const entry = this.views.get(id);
    if (entry) delete entry.error;
  }

  /** Отцепить активное вложение от окна: оно остаётся жить, но не рисуется. */
  private detach(window: BrowserWindow): void {
    if (!this.attached || !this.activeId) return;
    const entry = this.views.get(this.activeId);
    if (entry) window.contentView.removeChildView(entry.view);
    this.attached = false;
  }

  /** Подписки вложения: без них адресная строка и полоса вкладок не узнают ничего. */
  private wire(window: BrowserWindow, id: string, view: WebContentsView): void {
    const contents = view.webContents;
    this.watchWindow(window);

    const announce = (): void => this.publish(id);
    // Журнал консоли страницы держим в хвосте: его просят вложением в чат.
    const onConsole = (...args: unknown[]): void => pushConsole(this.views.get(id), args);
    (contents.on as (name: string, handler: (...args: unknown[]) => void) => unknown)('console-message', onConsole);
    contents.on('did-navigate', () => {
      this.clearError(id);
      announce();
    });
    contents.on('did-navigate-in-page', announce);
    contents.on('did-start-loading', announce);
    contents.on('did-stop-loading', announce);
    contents.on('page-title-updated', announce);
    contents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      // -3 — прерванная навигация (человек ушёл на другой адрес): это не ошибка.
      if (!isMainFrame || errorCode === -3) return;
      const entry = this.views.get(id);
      if (entry) entry.error = errorDescription || 'неизвестная причина';
      announce();
    });

    // Схему гостю тоже ограничиваем: `file:` показал бы локальный файл мимо дерева
    // и прав, а `data:` и `javascript:` — это уже запуск чужого кода.
    contents.on('will-navigate', (event, target) => {
      if (!isWebPageUrl(target)) event.preventDefault();
    });
    // Новое окно не создаём: у IDE своя рамка. Сетевую ссылку открываем вкладкой
    // в той же полосе (строку попросит renderer), остальное — браузером системы.
    contents.setWindowOpenHandler(({ url }) => {
      if (isWebPageUrl(url)) this.deps.notify(PushTopic.BrowserNav, { kind: 'newTab', id, url });
      else if (isSafeExternalUrl(url)) this.deps.openExternal(url);
      return { action: 'deny' };
    });
  }

  /** Окно закрылось — вложения вместе с ним: держать их больше некому. */
  private watchWindow(window: BrowserWindow): void {
    if (this.watched === window) return;
    this.watched = window;
    window.on('closed', () => {
      this.watched = null;
      for (const entry of this.views.values()) entry.view.webContents.close();
      this.views.clear();
      this.activeId = null;
      this.sharedId = null;
      this.attached = false;
    });
  }
}

/**
 * Доступен ли шаг по истории и сам шаг.
 *
 * Считаем сами, а не через `navigationHistory.canGoBack()/goBack()`: в Electron 44
 * эти методы врут. История у вложения с адресами `/a` и `/b` читается верно
 * (`length() === 2`, `getActiveIndex() === 1`), но `canGoBack()` отвечает `false`,
 * и `goBack()` ничего не делает — а `goToIndex()` на тот же индекс переходит.
 * Тот же ответ даёт и устаревший `webContents.canGoBack()`. Поэтому доступность
 * выводим из индекса и длины, а ходим исключительно по индексу.
 */
function canGo(contents: WebContents, delta: number): boolean {
  const history = contents.navigationHistory;
  const target = history.getActiveIndex() + delta;
  return history.getActiveIndex() >= 0 && target >= 0 && target < history.length();
}

function goBy(contents: WebContents, delta: number): void {
  const history = contents.navigationHistory;
  const target = history.getActiveIndex() + delta;
  if (target >= 0 && target < history.length()) history.goToIndex(target);
}
