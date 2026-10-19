import type {
  BrowserAction,
  BrowserNavState,
  BrowserRect,
  BrowserZoomMode,
  ChatAttachment,
  PickedImage,
} from '../../shared/api';
import { formatPickedElement, normalizeBrowserUrl } from '../../shared/browser';
import type { BrowserPage } from '../core/browser-tabs';
import type { RpcClient } from '../core/rpc';
import { showContextMenu } from './context-menu';
import { h, svgIcon } from './dom';

/**
 * Встроенный браузер: страница открывается вкладкой в редакторе.
 *
 * Саму страницу рисует НЕ renderer. Вложение — это `WebContentsView`: отдельный
 * слой окна, которым владеет main (`main/browser/panel.ts`). Здесь остаётся то,
 * чего слою не сделать самому:
 *
 *   • шапка — кнопки и адресная строка. Она живёт в DOM и потому ВСЕГДА видна:
 *     вложение ставится только на место «сцены» под шапкой, а не на всю вкладку;
 *   • место. Вложение не в DOM, поэтому его прямоугольник меряет renderer
 *     (`getBoundingClientRect` сцены) и присылает в main — при показе и на каждый
 *     переезд области редактора (окно, панели, сплиттер);
 *   • уступка оверлеям. Палитра, окна и уведомления — это DOM, а слой вложения
 *     лежит поверх DOM. Пока открыт оверлей, страницу приходится прятать, иначе
 *     её не увидеть и не нажать: слой перекроет и палитру.
 *
 * Состояние страницы (адрес, заголовок, кнопки «назад/вперёд») приходит обратным
 * событием, а не читается у вложения напрямую: у renderer'а нет доступа к слою.
 * Поэтому `update` — такой же вход, как события для любого другого вида.
 */

export interface BrowserView {
  element: HTMLElement;
  /** Показать вкладку. Вложение заводится при первом показе. */
  show(page: BrowserPage): void;
  hide(): void;
  /** Вкладку закрыли — вложение больше не нужно. */
  forget(id: string): void;
  /** Перейти по адресу в активной вкладке. */
  navigate(url: string): void;
  /** Поставить фокус в адресную строку — так «открыть адрес» не заставляет искать мышью. */
  focusAddress(): void;
  /** Вложение сообщило о себе: обновить адресную строку и кнопки. */
  update(id: string, state: BrowserNavState): void;
  /** Вложение сообщило, что вкладка отдана ассистенту (или доступ отозван). */
  setShared(id: string, shared: boolean): void;
  /** Агент действует на вкладке: показать это человеку и погасить через пару секунд. */
  setAgentAction(id: string, action: string): void;
  readonly isOpen: boolean;
  readonly pageId: string | null;
}

export interface BrowserViewDeps {
  rpc: RpcClient;
  /** Открыть адрес браузером системы. */
  openExternal(url: string): void;
  notify(message: string): void;
  /** Приложить картинку к вопросу чата: снимок страницы. */
  attachImage(image: PickedImage): void;
  /** Приложить текстовый контекст к вопросу чата: журнал консоли страницы. */
  attachContext(item: ChatAttachment): void;
}

/**
 * Что рисуется в DOM поверх сцены и потому требует спрятать страницу.
 *
 * Оверлеи и модалки (палитра, окна), панели-меню (`.context-menu`), попапы
 * (`.popover`: выпадающие списки, статус языковых серверов) и «Информация о сессии».
 * Список один на всех: разбирать «кто там сверху» по каждому окну значило бы
 * забывать новые попапы по одному.
 */
const OCCLUDERS =
  '.overlay:not([hidden]), .modal-backdrop:not([hidden]), .context-menu, .popover:not([hidden]), .session-info:not([hidden])';

export function createBrowserView(deps: BrowserViewDeps): BrowserView {
  const address = h('input', {
    class: 'browser-address',
    type: 'text',
    spellcheck: 'false',
    placeholder: 'Адрес страницы',
    'aria-label': 'Адрес страницы',
  }) as HTMLInputElement;

  const backButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Назад', onClick: () => run('back') },
    svgIcon('arrowLeft', 14),
  );
  const forwardButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Вперёд', onClick: () => run('forward') },
    svgIcon('arrowRight', 14),
  );
  // Одна кнопка на два дела: идёт загрузка — «стоп», иначе «обновить» (как в браузерах).
  const reloadButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Обновить', onClick: () => run('reload') },
    svgIcon('refresh', 14),
  );
  const externalButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Открыть в браузере системы', onClick: () => openExternal() },
    svgIcon('externalLink', 14),
  );
  const devtoolsButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Инструменты разработчика страницы', onClick: () => run('devtools') },
    svgIcon('command', 14),
  );
  // Поделиться страницей с ассистентом: без этого агент работает только в своей
  // вкладке (временная сессия), а поделившись — в этой же, с её логином и куками.
  const shareButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Поделиться страницей с ассистентом', onClick: () => toggleShare() },
    svgIcon('sparkle', 14),
  );
  // «Добавить в чат»: снимок страницы или её консоль уходят контекстом вопроса.
  const chatButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Добавить в чат', onClick: (event: Event) => openChatMenu(event) },
    svgIcon('chat', 14),
  );
  // Выбор элемента: страница уходит в чат контекстом вопроса вместе со снимком
  // этого элемента. Обычный путь для «а вот тут криво» — быстрее, чем описывать словами.
  const pickButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Выбрать элемент для чата', onClick: () => void pickElement() },
    svgIcon('pick', 14),
  );
  // Масштаб страницы — те же четыре кнопки, что у просмотра картинок: привычно
  // и не требует помнить, что у страницы он тоже есть (Ctrl+колесо работает).
  const zoomLabel = h('span', { class: 'browser-zoom-label' });
  const zoomOutButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Мельче (Ctrl+колесо)', onClick: () => void runZoom('out') },
    svgIcon('minus', 14),
  );
  const zoomInButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Крупнее (Ctrl+колесо)', onClick: () => void runZoom('in') },
    svgIcon('plus', 14),
  );
  const zoomActualButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Реальный масштаб (1:1)', onClick: () => void runZoom('actual') },
    h('span', { class: 'browser-actual' }, '1:1'),
  );
  const zoomFitButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Вписать по ширине', onClick: () => void runZoom('fit') },
    svgIcon('fit', 14),
  );
  // Метка «агент работает»: без неё страница под руками человека сама нажимает
  // кнопки и уходит на другие адреса — и не понять, кто это сделал. Живёт в шапке,
  // потому что шапка — единственная часть вкладки, которую рисует DOM: сама
  // страница — слой окна, и ничего поверх неё не положить.
  const agentBadge = h('span', { class: 'browser-agent', hidden: true });

  // Сцена — это «дырка», которую занимает вложение. Своей высоты у неё нет: она
  // тянется под шапкой, а вложение встаёт ровно по её прямоугольнику.
  //
  // Внутри сцены лежит замороженный кадр страницы (`snapshot`): пока над сценой висит
  // меню или попап, вложение приходится прятать, и без кадра на его месте осталась бы
  // пустая полоса — «окно браузера пропало». Со снимком страница не исчезает, а замирает.
  const snapshot = h('img', { class: 'browser-snapshot', alt: '', hidden: true }) as HTMLImageElement;
  const stage = h('div', { class: 'browser-stage' }, snapshot);
  const element = h(
    'div',
    { class: 'browser-view', hidden: true },
    h(
      'div',
      { class: 'browser-toolbar' },
      backButton,
      forwardButton,
      reloadButton,
      address,
      agentBadge,
      zoomLabel,
      zoomOutButton,
      zoomInButton,
      zoomActualButton,
      zoomFitButton,
      pickButton,
      externalButton,
      shareButton,
      devtoolsButton,
      chatButton,
    ),
    stage,
  );

  /** Вложения, уже заведённые в main: ключ вкладки → есть. */
  const created = new Set<string>();
  let open = false;
  let activeId: string | null = null;
  let loading = false;
  /** Адрес активной страницы: им адресная строка возвращается после правки. */
  let currentUrl = '';
  /**
   * Масштаб активной страницы. Живёт событием из main: там его меняют и кнопки,
   * и Ctrl+колесо, и агент — три пути, а подпись в шапке одна.
   */
  let zoom = 1;

  /**
   * Границы масштаба — те же числа, что в main (`panel.ts`): кнопка не должна
   * выглядеть живой там, где движок всё равно не даст дальше.
   */
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 5;
  /** Ключ страницы, отданной ассистенту: `null` — ничем не делились. */
  let sharedId: string | null = null;
  /** Оверлей закрывает сцену — вложение на это время спрятано. */
  let occluded = false;
  let layoutFrame = 0;
  /** Метка «агент работает» гаснет сама: держать её вечно — значит врать. */
  let agentTimer = 0;

  /** Как действие агента читается человеку. */
  const AGENT_ACTIONS: Record<string, string> = {
    open: 'открывает страницу',
    read: 'читает страницу',
    click: 'нажимает на странице',
    type: 'вводит текст',
    script: 'выполняет скрипт',
    zoom: 'меняет масштаб страницы',
  };
  /** Сколько метка держится после последнего действия. */
  const AGENT_NOTICE_MS = 3000;

  /** Прямоугольник сцены в координатах окна: по нему вложение и встаёт. */
  const rectOf = (): BrowserRect => {
    const box = stage.getBoundingClientRect();
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.max(0, Math.round(box.width)),
      height: Math.max(0, Math.round(box.height)),
    };
  };

  /** Действие над вкладкой уходит в main: у renderer'а нет доступа к слою. */
  function run(action: BrowserAction, url?: string): void {
    if (!activeId) return;
    const id = activeId;
    void deps.rpc
      .request('browser.viewCommand', url === undefined ? { id, action } : { id, action, url })
      .then((result) => {
        if (!result.ok && result.reason) deps.notify(result.reason);
      })
      .catch(() => undefined);
  }

  /**
   * Сменить масштаб страницы. Подпись и состояние кнопок придут событием —
   * по одному ответу их выставлять нельзя: масштаб меняет ещё и Ctrl+колесо.
   */
  async function runZoom(mode: BrowserZoomMode): Promise<void> {
    if (!activeId) return;
    const result = await deps.rpc.request('browser.viewZoom', { id: activeId, mode }).catch(() => null);
    if (!result) {
      deps.notify('Не удалось изменить масштаб страницы');
      return;
    }
    if (!result.ok && result.reason) deps.notify(result.reason);
  }

  /**
   * Выбрать элемент страницы и получить его контекстом вопроса: описание плюс снимок.
   *
   * Режим выбора живёт на самой странице (main), поэтому запрос висит до клика —
   * кнопка на это время помечена, чтобы было понятно, что от человека ждут клика.
   */
  async function pickElement(): Promise<void> {
    const id = activeId;
    if (!id) return;
    pickButton.classList.add('is-active');
    const result = await deps.rpc.request('browser.viewPick', { id }).catch(() => null);
    pickButton.classList.remove('is-active');
    if (!result) {
      deps.notify('Не удалось выбрать элемент');
      return;
    }
    // Отмена — Esc или ничего не выбрано: это не ошибка, ругать человека не за что.
    if (!result.ok || !result.element) {
      if (result.reason) deps.notify(result.reason);
      return;
    }

    const element = result.element;
    const label = element.name || element.tag;
    deps.attachContext({
      kind: 'note',
      label: 'Элемент: ' + element.tag + ' «' + label + '»',
      title: 'Элемент страницы ' + currentUrl,
      text: formatPickedElement(element, currentUrl),
    });
    if (result.shot) {
      deps.attachImage({
        name: 'Элемент ' + element.tag + '.png',
        mime: 'image/png',
        bytes: result.shot.bytes,
        dataUrl: result.shot.dataUrl,
      });
    }
    deps.notify('Элемент добавлен в чат');
  }

  /** Показать сцену на текущем месте: спрятанное вложение возвращается тем же путём. */
  function applyVisibility(): void {
    // Оверлей (палитра, окно) лежит в DOM, а вложение — слоем поверх DOM: пока он
    // открыт, показывать страницу нельзя, иначе она закроет его собой.
    if (!open || !activeId || occluded) return;
    deps.rpc
      .request('browser.viewShow', { id: activeId, rect: rectOf() })
      .then((result) => {
        if (!result.ok) {
          deps.notify('Не удалось показать страницу');
          return;
        }
        // Размер сцены в момент показа мог быть ещё не окончательным (панель
        // доезжает, сплиттер двигается) — дожимаем прямоугольник на следующем кадре.
        scheduleLayout();
      })
      .catch(() => undefined);
  }

  /** Завести вложение для вкладки, если его ещё нет, и показать по месту сцены. */
  async function openPage(page: BrowserPage): Promise<void> {
    if (!created.has(page.id)) {
      const result = await deps.rpc.request('browser.viewCreate', { id: page.id, url: page.url }).catch(() => null);
      if (!result || !result.ok) {
        deps.notify(result?.reason ?? 'Не удалось открыть страницу');
        return;
      }
      created.add(page.id);
    }
    // Пока ходили в main, человек мог переключиться на другую вкладку.
    if (!open || activeId !== page.id) return;
    applyVisibility();
  }

  /** Адресная строка и кнопки идут за состоянием активной страницы. */
  const syncToolbar = (): void => {
    if (!activeId) {
      backButton.disabled = true;
      forwardButton.disabled = true;
      reloadButton.disabled = true;
      externalButton.disabled = true;
      devtoolsButton.disabled = true;
      shareButton.disabled = true;
      chatButton.disabled = true;
      pickButton.disabled = true;
      zoomOutButton.disabled = true;
      zoomInButton.disabled = true;
      zoomActualButton.disabled = true;
      zoomFitButton.disabled = true;
      zoomLabel.textContent = '';
      return;
    }
    reloadButton.disabled = false;
    externalButton.disabled = false;
    devtoolsButton.disabled = false;
    shareButton.disabled = false;
    chatButton.disabled = false;
    pickButton.disabled = false;
    zoomOutButton.disabled = zoom <= ZOOM_MIN;
    zoomInButton.disabled = zoom >= ZOOM_MAX;
    zoomActualButton.disabled = zoom === 1;
    zoomFitButton.disabled = false;
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
    zoomLabel.title = 'Масштаб страницы: Ctrl+колесо тоже меняет его';
    // Кнопка показывает, поделена ли ИМЕННО эта страница: агент работает в ней же.
    const shared = sharedId === activeId;
    shareButton.classList.toggle('is-active', shared);
    shareButton.title = shared ? 'Отозвать доступ ассистента к странице' : 'Поделиться страницей с ассистентом';
    reloadButton.title = loading ? 'Остановить загрузку' : 'Обновить';
    reloadButton.replaceChildren(svgIcon(loading ? 'close' : 'refresh', 14));
    element.classList.toggle('is-loading', loading);
    // Адресную строку не трогаем, пока её правят: иначе навигация вырвала бы ввод.
    if (document.activeElement !== address) address.value = currentUrl;
  };

  /** Переставить вложение: сцена переехала или изменилась. Вызовы схлопываем по кадру. */
  function scheduleLayout(): void {
    if (!open || occluded) return;
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      if (!open) return;
      void deps.rpc.request('browser.viewLayout', { rect: rectOf() }).catch(() => undefined);
    });
  }

  /**
   * Накрывает ли всплывающее окно сцену. Спрашивать одно лишь «есть ли в документе
   * `.context-menu`» мало: меню проводника, вкладок и панели чата стоят в своих
   * углах и до области редактора не достают — гасить под ними страницу значило
   * мигать ею на каждый правый клик по дереву файлов.
   */
  const coversStage = (node: Element): boolean => {
    const box = node.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    const stageBox = stage.getBoundingClientRect();
    return (
      box.left < stageBox.right && box.right > stageBox.left && box.top < stageBox.bottom && box.bottom > stageBox.top
    );
  };

  /** Есть ли над сценой хоть что-то из DOM — то, что слой вложения перекроет собой. */
  const hiddenUnder = (): boolean => {
    // Всё, что рисуется в DOM поверх сцены. Кроме оверлеев и меню это ещё и попапы
    // (`.popover`: выпадающие списки, статус серверов) и «Информация о сессии» —
    // они всплывают вверх от своих кнопок и запросто накрывают область редактора.
    // Не спрячь мы страницу — они оказались бы ПОД ней: страница это слой окна,
    // и никакой `z-index` её не перебьёт.
    for (const node of document.querySelectorAll(OCCLUDERS)) if (coversStage(node)) return true;
    return false;
  };

  /**
   * Оверлеи (палитра, окна) лежат в DOM, а вложение — слоем поверх DOM: пока
   * оверлей открыт, страницу нужно спрятать. Следим за появлением и снятием
   * оверлеев наблюдателем, а не просьбами из каждого окна: окна заводятся в
   * разных местах, и не забыть ни одного проще с одной стороны.
   */
  const syncOcclusion = (): void => {
    const next = hiddenUnder();
    if (next === occluded) return;
    occluded = next;
    if (!open) return;
    if (occluded) void freezeStage();
    else thawStage();
  };

  /**
   * Спрятать вложение, оставив на его месте последний кадр страницы.
   *
   * Кадр снимается ДО утайки: спрятанное вложение отдаёт пустое полотно. Утайка
   * идёт сразу за снимком, потому что до неё меню целиком закрыто страницей (она —
   * слой окна), а снимок без утайки ничего бы не дал: его закрывает тот же слой.
   */
  async function freezeStage(): Promise<void> {
    const id = activeId;
    const shot = id ? await deps.rpc.request('browser.viewCapture', { id }).catch(() => null) : null;
    // Пока снимали, меню могли закрыть или человек — сменить вкладку: тогда и прятать нечего.
    if (!occluded || !open || !id || activeId !== id) return;
    if (shot?.ok && shot.dataUrl) {
      snapshot.src = shot.dataUrl;
      snapshot.hidden = false;
    }
    void deps.rpc.request('browser.viewHide', undefined).catch(() => undefined);
  }

  /** Всплывающее окно ушло: убираем кадр и возвращаем на место живое вложение. */
  function thawStage(): void {
    snapshot.hidden = true;
    snapshot.removeAttribute('src');
    applyVisibility();
  }

  const observer = new MutationObserver(syncOcclusion);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributeFilter: ['hidden', 'class', 'style'],
  });

  const resizeObserver = new ResizeObserver(scheduleLayout);
  resizeObserver.observe(stage);
  window.addEventListener('resize', scheduleLayout);

  address.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      navigate(address.value);
      return;
    }
    // Escape возвращает адрес страницы: правку в строке отменяют, а не закрывают панель.
    if (event.key === 'Escape') {
      event.preventDefault();
      address.value = currentUrl;
      address.blur();
    }
  });
  // Ушли из строки, ничего не набрав, — показываем настоящий адрес страницы.
  address.addEventListener('blur', () => {
    address.value = currentUrl;
  });

  /** Перейти по адресу в текущей вкладке: адрес мог быть набран в палитре команд. */
  function navigate(rawUrl: string): void {
    const normalized = normalizeBrowserUrl(rawUrl);
    if (!normalized.ok) {
      deps.notify(normalized.reason);
      return;
    }
    if (!activeId) return;
    address.value = normalized.url;
    run('navigate', normalized.url);
  }

  /** Найти текущий адрес: он нужен кнопке «открыть в браузере системы». */
  function openExternal(): void {
    if (currentUrl) deps.openExternal(currentUrl);
  }

  /** Поделиться активной страницей с ассистентом или отозвать доступ. */
  function toggleShare(): void {
    if (!activeId) return;
    if (sharedId === activeId) {
      void deps.rpc.request('browser.viewUnshare', undefined).catch(() => undefined);
      return;
    }
    void deps.rpc
      .request('browser.viewShare', { id: activeId })
      .then((result) => {
        if (!result.ok) deps.notify('Не удалось поделиться страницей');
      })
      .catch(() => undefined);
  }

  /** Меню «в чат»: снимок страницы и её консоль. */
  function openChatMenu(event: Event): void {
    const id = activeId;
    if (!id) return;
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    showContextMenu(
      [
        { label: 'Снимок страницы в чат', onSelect: () => void addScreenshot(id) },
        { label: 'Журнал консоли в чат', onSelect: () => void addConsole(id) },
      ],
      box.left,
      box.bottom,
    );
  }

  /** Снимок страницы уходит в чат картинкой: полотно — слой окна, снимает его main. */
  async function addScreenshot(id: string): Promise<void> {
    const result = await deps.rpc.request('browser.viewCapture', { id }).catch(() => null);
    if (!result || !result.ok || !result.dataUrl) {
      deps.notify(result?.reason ?? 'Не удалось снять страницу');
      return;
    }
    const comma = result.dataUrl.indexOf(',');
    const bytes = Math.round(Math.max(0, result.dataUrl.length - comma - 1) * 0.75);
    deps.attachImage({
      name: 'Страница ' + id + '.png',
      mime: 'image/png',
      bytes,
      dataUrl: result.dataUrl,
    });
    deps.notify('Снимок страницы добавлен в чат');
  }

  /** Журнал консоли уходит в чат текстовым контекстом. */
  async function addConsole(id: string): Promise<void> {
    const result = await deps.rpc.request('browser.viewConsole', { id }).catch(() => null);
    if (!result || !result.ok) {
      deps.notify('Не удалось прочитать журнал консоли');
      return;
    }
    if (result.lines.length === 0) {
      deps.notify('В консоли страницы пусто');
      return;
    }
    deps.attachContext({
      kind: 'note',
      label: 'Журнал консоли (' + result.lines.length + ' строк)',
      title: 'Журнал консоли страницы ' + currentUrl,
      text: result.lines.join('\n'),
    });
    deps.notify('Журнал консоли добавлен в чат: ' + result.lines.length);
  }

  return {
    element,

    show(page: BrowserPage): void {
      open = true;
      element.hidden = false;
      activeId = page.id;
      currentUrl = page.url;
      syncToolbar();
      void openPage(page);
    },

    hide(): void {
      open = false;
      element.hidden = true;
      void deps.rpc.request('browser.viewHide', undefined).catch(() => undefined);
    },

    forget(id: string): void {
      created.delete(id);
      void deps.rpc.request('browser.viewClose', { id }).catch(() => undefined);
      if (activeId === id) activeId = null;
    },

    navigate,

    setShared(id: string, shared: boolean): void {
      sharedId = shared ? id : sharedId === id ? null : sharedId;
      syncToolbar();
    },

    setAgentAction(id: string, action: string): void {
      // Метка в шапке говорит про активную вкладку: в шапке другой страницы она врёт.
      if (id !== activeId) return;
      if (agentTimer) clearTimeout(agentTimer);
      agentBadge.textContent = `Ассистент ${AGENT_ACTIONS[action] ?? 'работает со страницей'}`;
      agentBadge.hidden = false;
      element.classList.add('is-agent');
      agentTimer = window.setTimeout(() => {
        agentTimer = 0;
        agentBadge.hidden = true;
        element.classList.remove('is-agent');
      }, AGENT_NOTICE_MS);
    },

    focusAddress(): void {
      address.focus();
      address.select();
    },

    update(id: string, state: BrowserNavState): void {
      // Состояние приходит на любую вкладку, а показываем мы активную.
      if (id !== activeId) return;
      currentUrl = state.url;
      loading = state.loading;
      zoom = state.zoom;
      backButton.disabled = !state.canGoBack;
      forwardButton.disabled = !state.canGoForward;
      syncToolbar();
      if (state.error) deps.notify(`Страница не загрузилась: ${state.error}`);
    },

    get isOpen(): boolean {
      return open;
    },

    get pageId(): string | null {
      return activeId;
    },
  };
}
