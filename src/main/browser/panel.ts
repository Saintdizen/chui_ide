import { type BrowserWindow, WebContentsView, type WebContents } from 'electron';
import {
  PushTopic,
  type BrowserAction,
  type BrowserNavState,
  type BrowserPickedElement,
  type BrowserRect,
  type BrowserZoomMode,
} from '../../shared/api';
import { normalizeBrowserUrl, sanitizePickedElement } from '../../shared/browser';
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
  /**
   * Масштаб страницы (1 — 100 %). Храним своё значение, а не спрашиваем у движка:
   * Ctrl+колесо переведено в ручной режим (`zoomMode`), поэтому единственный
   * источник правды — здесь. Иначе шаг колеса иногда применялся бы дважды.
   */
  zoom: number;
}

/** Сколько строк консоли держим на вкладку: это контекст для модели, а не лог. */
const CONSOLE_LIMIT = 200;

/**
 * Границы масштаба страницы — те же, что у движка (25–500 %): шире он всё равно
 * не даст, а за своими числами проще следить.
 */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
/** Шаг кнопок и колеса: тот же, что у просмотра картинок — привычная глазу доля. */
const ZOOM_STEP = 1.25;

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

/**
 * Мерка страницы для «вписать». Ширина контента в CSS-пикселях и ширина окна
 * вложения в тех же единицах: по ним видно, во сколько раз нужно уменьшить
 * масштаб, чтобы страница перестала прокручиваться вбок.
 */
const MEASURE_SCRIPT = `(() => {
  const doc = document.documentElement;
  const body = document.body;
  return {
    contentWidth: Math.max(doc.scrollWidth, body ? body.scrollWidth : 0),
    viewportWidth: doc.clientWidth,
  };
})()`;

/**
 * Выбор элемента мышью прямо на странице.
 *
 * Почему скрипт, а не DOM в renderer'е: страница — слой окна, элементами которого
 * владеет main. Ни подсветить её из нашего DOM, ни узнать, что человек нажал,
 * renderer не может — поэтому режим выбора живёт в самой странице (подсветка и
 * сбор описания), а результат уходит в main готовым объектом.
 *
 * Правила, по которым он написан:
 *  • `pointer-events: none` на подсветке — иначе она сама стала бы целью клика;
 *  • слушатели в capture-фазе и с отменой события: выбор элемента не должен
 *    нажать кнопку или уйти по ссылке;
 *  • Esc отменяет, повторный вызов гасит прошлый режим, а свой таймаут нужен,
 *    чтобы запрос из окна не висел вечно, если человек передумал и ушёл;
 *  • всё оформление — через `style.*`, а не атрибутом `style`: его режет CSP
 *    чужих страниц.
 */
const PICK_SCRIPT = `(() => {
  if (typeof window.__chuiPickCancel === 'function') window.__chuiPickCancel();

  const accent = '#1f9cf0';
  const box = document.createElement('div');
  box.style.position = 'fixed';
  box.style.zIndex = '2147483647';
  box.style.pointerEvents = 'none';
  box.style.border = '2px solid ' + accent;
  box.style.background = 'rgba(31, 156, 240, 0.16)';
  box.style.borderRadius = '2px';
  box.style.display = 'none';

  const tip = document.createElement('div');
  tip.style.position = 'fixed';
  tip.style.zIndex = '2147483647';
  tip.style.pointerEvents = 'none';
  tip.style.padding = '2px 6px';
  tip.style.borderRadius = '3px';
  tip.style.background = '#1f2937';
  tip.style.color = '#f8fafc';
  tip.style.font = '11px/1.4 monospace';
  tip.style.whiteSpace = 'nowrap';
  tip.style.maxWidth = '70vw';
  tip.style.overflow = 'hidden';
  tip.style.display = 'none';

  document.documentElement.appendChild(box);
  document.documentElement.appendChild(tip);

  const selectorOf = (node) => {
    const parts = [];
    let current = node;
    while (current && current.nodeType === 1 && parts.length < 6) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(part + '#' + current.id);
        break;
      }
      const classes = [];
      for (const name of current.classList) {
        if (classes.length < 2 && name.length < 30) classes.push(name);
      }
      if (classes.length > 0) part += '.' + classes.join('.');
      const parent = current.parentElement;
      if (parent) {
        let same = 0;
        let index = 0;
        for (const sibling of parent.children) {
          if (sibling.tagName !== current.tagName) continue;
          same += 1;
          if (sibling === current) index = same;
        }
        if (same > 1) part += ':nth-of-type(' + index + ')';
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ');
  };

  const clean = (value) => String(value === null || value === undefined ? '' : value).replace(/\\s+/g, ' ').trim();

  const describe = (node) => {
    const rect = node.getBoundingClientRect();
    const computed = getComputedStyle(node);
    const styles = {};
    const keys = [
      'display',
      'position',
      'color',
      'background-color',
      'font-family',
      'font-size',
      'font-weight',
      'line-height',
      'padding',
      'margin',
      'border',
      'border-radius',
      'width',
      'height',
      'overflow',
    ];
    for (const key of keys) {
      const value = computed.getPropertyValue(key);
      if (value) styles[key] = value;
    }
    const text = clean(node.innerText || node.textContent).slice(0, 600);
    const name = clean(node.getAttribute('aria-label') || node.getAttribute('title') || text).slice(0, 160);
    return {
      tag: node.tagName.toLowerCase(),
      selector: selectorOf(node),
      name,
      role: clean(node.getAttribute('role')).slice(0, 40),
      text,
      html: node.outerHTML.slice(0, 1200),
      styles,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      },
    };
  };

  const place = (node) => {
    const rect = node.getBoundingClientRect();
    const selector = selectorOf(node);
    box.style.display = 'block';
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = Math.max(0, rect.width) + 'px';
    box.style.height = Math.max(0, rect.height) + 'px';
    tip.textContent = selector;
    tip.style.display = 'block';
    const above = rect.top > 26;
    tip.style.left = Math.max(2, rect.left) + 'px';
    tip.style.top = Math.max(2, above ? rect.top - 22 : rect.bottom + 4) + 'px';
  };

  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      box.remove();
      tip.remove();
      window.__chuiPickCancel = undefined;
      resolve(value);
    };
    const onMove = (event) => {
      const target = event.target;
      if (target && target.nodeType === 1) place(target);
    };
    const onClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const target = event.target;
      finish(target && target.nodeType === 1 ? describe(target) : null);
    };
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      finish(null);
    };
    // Человек мог уйти, ничего не выбрав: без своего потолка запрос висел бы вечно.
    const timer = setTimeout(() => finish(null), 120000);
    window.__chuiPickCancel = () => finish(null);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  });
})()`;

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
    this.views.set(id, { view, console: [], zoom: 1 });
    // Масштаб ведёт приложение, а не движок: в ручном режиме Ctrl+колесо
    // присылает событие `zoom-changed`, но страницу не масштабирует — масштаб
    // меняем мы сами. Так у кнопок шапки, у колеса и у агента один источник правды.
    view.webContents.setZoomMode('manual');
    this.wire(window, id, view);
    if (this.rect) view.setBounds(this.rect);
    void view.webContents.loadURL(normalized.url).catch(() => undefined);
    return { ok: true };
  }

  /**
   * Показать вкладку на месте области редактора: остальные вложения гасим.
   *
   * Вложение при этом НЕ отцепляется от окна и не прицепляется заново. Так было
   * раньше, и это стоило дорого: после `removeChildView` + `addChildView` слой
   * переставал рисоваться — вкладка возвращалась, шапка была на месте, а сцена
   * оставалась пустой до перерисовки окна. Скрытие — это `setVisible(false)`:
   * слой живёт в дереве окна, но не рисуется, и возврат к вкладке ничего не
   * пересобирает.
   */
  show(id: string, rect: BrowserRect): { ok: boolean } {
    const window = this.deps.window();
    const entry = this.views.get(id);
    if (!window || window.isDestroyed() || !entry) return { ok: false };

    this.rect = rect;
    if (this.activeId !== null && this.activeId !== id) this.undraw();
    this.activeId = id;
    // Слой поднимается наверх: в окне поверх страницы не должно остаться ничего,
    // кроме того, что рисует сам renderer.
    window.contentView.addChildView(entry.view);
    // Прямоугольник ставим ВСЕГДА, даже если он совпал с прежним: область редактора
    // могла переехать, пока вкладка была в фоне.
    entry.view.setBounds(rect);
    entry.view.setVisible(true);
    this.attached = true;
    this.publish(id);
    return { ok: true };
  }

  /** Спрятать вложение: активна не страница (файл, чат, картинка) или открыт оверлей. */
  hide(): { ok: boolean } {
    this.undraw();
    return { ok: true };
  }

  /**
   * Рисуется ли вложение прямо сейчас. Нужно пробам и отладке: прикреплённых
   * слоёв теперь может быть много (скрытые тоже в дереве), и по числу детей окна
   * уже не видно, что на экране.
   */
  isShown(id: string): boolean {
    const entry = this.views.get(id);
    return entry !== undefined && this.attached && this.activeId === id && entry.view.getVisible();
  }

  /** Где стоит вложение: тот же прямоугольник, что пришёл от renderer'а. */
  boundsOf(id: string): BrowserRect | null {
    const bounds = this.views.get(id)?.view.getBounds();
    if (!bounds) return null;
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }

  /** Область редактора переехала (окно, панели, док) — переставляем вложение. */
  layout(rect: BrowserRect): { ok: boolean } {
    this.rect = rect;
    if (!this.attached || !this.activeId) return { ok: true };
    this.views.get(this.activeId)?.view.setBounds(rect);
    return { ok: true };
  }

  /**
   * Масштаб страницы: кнопки шапки, Ctrl+колесо и агент ходят сюда же.
   *
   * «Вписать» здесь — по ширине: страница по высоте всё равно прокручивается,
   * а подгонять её целиком в окно значило бы мельчить текст до нечитаемого.
   * Крупнее 100 % вписывание не увеличивает: теснота заставляет уменьшать, а не растягивать.
   */
  async zoom(id: string, mode: BrowserZoomMode): Promise<{ ok: boolean; zoom?: number; reason?: string }> {
    const entry = this.views.get(id);
    if (!entry) return { ok: false, reason: 'Вкладка не найдена' };

    if (mode === 'actual') return this.setZoom(entry, id, 1);
    if (mode === 'in') return this.setZoom(entry, id, entry.zoom * ZOOM_STEP);
    if (mode === 'out') return this.setZoom(entry, id, entry.zoom / ZOOM_STEP);

    const measured = await this.measure(entry);
    if (!measured) return { ok: false, reason: 'Страница ещё не загрузилась' };
    if (measured.contentWidth <= 0 || measured.viewportWidth <= 0) {
      return { ok: false, reason: 'Нечего вписывать: страница пуста' };
    }
    // Ширины Measured в CSS-пикселях, и масштаб их не меняет: окно вложения
    // остаётся 534 CSS px и при 100 %, и при 195 % (проверено пробой), поэтому
    // нынешний масштаб в долю не входит — в отличие от «вписать» у картинки.
    const factor = measured.viewportWidth / measured.contentWidth;
    return this.setZoom(entry, id, Math.min(1, factor));
  }

  /** Нынешний масштаб вкладки — для отчёта агента и проб. */
  zoomOf(id: string): number | null {
    return this.views.get(id)?.zoom ?? null;
  }

  /**
   * Выбрать элемент страницы мышью: описание для чата и снимок его области.
   *
   * Выбор идёт на самой странице (см. `PICK_SCRIPT`): поверх чужого слоя окна
   * нам нечем рисовать, а узнать, куда нажали, можно только там. Отмена (Esc или
   * закрытие вкладки) возвращает `ok: false` без причины: человек передумал — это
   * не ошибка, и ругаться на него незачем.
   */
  async pick(id: string): Promise<{
    ok: boolean;
    element?: BrowserPickedElement;
    shot?: { dataUrl: string; bytes: number };
    reason?: string;
  }> {
    const entry = this.views.get(id);
    if (!entry) return { ok: false, reason: 'Вкладка не найдена' };
    if (!this.attached || this.activeId !== id) {
      return { ok: false, reason: 'Сначала покажите страницу: выбрать элемент можно только на ней' };
    }

    let raw: unknown;
    try {
      raw = await entry.view.webContents.executeJavaScript(PICK_SCRIPT, true);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    const element = sanitizePickedElement(raw);
    if (!element) return { ok: false };
    return { ok: true, element, ...(await this.shotOf(entry, element.rect)) };
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
    if (window && !window.isDestroyed()) {
      if (this.activeId === id) this.undraw();
      // Слой живёт в дереве окна и после скрытия — убираем его совсем, иначе
      // закрытая вкладка оставила бы в окне висячий невидимый слой.
      window.contentView.removeChildView(entry.view);
    }
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

  /**
   * Агент что-то делает на вкладке. Об этом обязательно знать человеку: страница
   * может быть у него перед глазами, а действия приходят не от его мыши. Событие
   * короткое — renderer сам решает, сколько держать метку.
   */
  noteAgentAction(id: string, action: string): void {
    if (!this.views.has(id)) return;
    this.deps.notify(PushTopic.BrowserNav, { kind: 'agent', id, action });
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
      zoom: entry.zoom,
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

  /** Поставить масштаб и рассказать о нём renderer'у: подпись в шапке живёт событием. */
  private setZoom(entry: Entry, id: string, factor: number): { ok: boolean; zoom: number } {
    // До сотых: иначе шаг 1.25 три раза подряд даёт 1.953125 и подпись врёт.
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(factor * 100) / 100));
    entry.zoom = zoom;
    entry.view.webContents.setZoomFactor(zoom);
    this.publish(id);
    return { ok: true, zoom };
  }

  /** Мерка страницы для «вписать». `null` — страница ещё не готова считать. */
  private async measure(entry: Entry): Promise<{ contentWidth: number; viewportWidth: number } | null> {
    try {
      const data = (await entry.view.webContents.executeJavaScript(MEASURE_SCRIPT)) as {
        contentWidth?: unknown;
        viewportWidth?: unknown;
      } | null;
      const contentWidth = Number(data?.contentWidth);
      const viewportWidth = Number(data?.viewportWidth);
      if (!Number.isFinite(contentWidth) || !Number.isFinite(viewportWidth)) return null;
      return { contentWidth, viewportWidth };
    } catch {
      return null;
    }
  }

  /**
   * Снимок области элемента: подсветить его в нашем DOM нечем, а показать человеку
   * и модели «вот про это речь» — самое короткое объяснение.
   *
   * Прямоугольник со страницы — в CSS-пикселях, а `capturePage` ждёт DIP окна:
   * при масштабе 80 % элемент занимает меньше точек, чем CSS-пикселей.
   */
  private async shotOf(entry: Entry, rect: BrowserRect): Promise<{ shot?: { dataUrl: string; bytes: number } }> {
    if (rect.width <= 0 || rect.height <= 0) return {};
    try {
      const image = await entry.view.webContents.capturePage({
        x: Math.max(0, Math.round(rect.x * entry.zoom)),
        y: Math.max(0, Math.round(rect.y * entry.zoom)),
        width: Math.round(rect.width * entry.zoom),
        height: Math.round(rect.height * entry.zoom),
      });
      const dataUrl = image.toDataURL();
      const comma = dataUrl.indexOf(',');
      return { shot: { dataUrl, bytes: Math.round(Math.max(0, dataUrl.length - comma - 1) * 0.75) } };
    } catch {
      return {};
    }
  }

  /** Погасить активное вложение: оно остаётся в дереве окна, но не рисуется. */
  private undraw(): void {
    if (!this.attached) return;
    const entry = this.activeId === null ? undefined : this.views.get(this.activeId);
    // Режим выбора мог остаться включённым: страницу прячут — выходим из него,
    // иначе подсветка ждала бы клика на невидимой странице до своего таймера.
    entry?.view.webContents.executeJavaScript('window.__chuiPickCancel?.(); undefined').catch(() => undefined);
    entry?.view.setVisible(false);
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
    // Ctrl+колесо: движок в ручном режиме (`setZoomMode('manual')`), поэтому он лишь
    // сообщает о жесте, а масштаб меняем мы — тем же путём, что кнопки шапки.
    contents.on('zoom-changed', (_event, direction) => {
      void this.zoom(id, direction === 'in' ? 'in' : 'out');
    });
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
