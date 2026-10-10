import { clear, h } from './dom';

/**
 * Каркас в стиле PyCharm New UI: фон приложения темнее панелей, панели —
 * «острова» со скруглёнными углами, а зазоры между ними служат сплиттерами.
 */
export interface Layout {
  root: HTMLElement;
  topBar: HTMLElement;
  topBarLeft: HTMLElement;
  topBarTitle: HTMLElement;
  topBarRight: HTMLElement;
  sidebar: HTMLElement;
  sidebarBody: HTMLElement;
  tabsHost: HTMLElement;
  breadcrumbsHost: HTMLElement;
  editorHost: HTMLElement;
  /** Остров редактора: на нём переключаются режимы (например, чат вместо файлов). */
  editorIsland: HTMLElement;
  dockHost: HTMLElement;
  rightPanel: HTMLElement;
  rightBody: HTMLElement;
  statusBarHost: HTMLElement;
  readonly sidebarVisible: boolean;
  readonly rightVisible: boolean;
  readonly dockVisible: boolean;
  setSidebarVisible(visible: boolean): void;
  setRightVisible(visible: boolean): void;
  setDockVisible(visible: boolean): void;
  readonly sidebarSize: number;
  readonly rightSize: number;
  readonly dockSize: number;
  setSidebarSize(size: number): void;
  setRightSize(size: number): void;
  setDockSize(size: number): void;
}

export function createLayout(mount: HTMLElement, options: { onChange?: () => void } = {}): Layout {
  const topBarLeft = h('div', { class: 'topbar-left' });
  const topBarTitle = h('div', { class: 'topbar-title' });
  const topBarRight = h('div', { class: 'topbar-right' });
  const topBar = h('header', { class: 'topbar' }, topBarLeft, topBarTitle, topBarRight);

  const sidebarBody = h('div', { class: 'sidebar-body' });
  const sidebar = h('aside', { class: 'island sidebar' }, sidebarBody);
  const sidebarSplitter = h('div', { class: 'splitter splitter-left' });

  const tabsHost = h('div', { class: 'tabs-host' });
  const breadcrumbsHost = h('div', { class: 'breadcrumbs-host' });
  const editorHost = h('div', { class: 'editor-host' });
  const editorIsland = h('section', { class: 'island editor-island' }, tabsHost, breadcrumbsHost, editorHost);

  const dockSplitter = h('div', { class: 'splitter splitter-dock' });
  const dockHost = h('div', { class: 'dock-host' });
  const dockIsland = h('section', { class: 'island dock' }, dockHost);
  const dockWrap = h('div', { class: 'dock-wrap' }, dockSplitter, dockIsland);

  const center = h('div', { class: 'center' }, editorIsland, dockWrap);
  const rightSplitter = h('div', { class: 'splitter splitter-right' });

  const rightBody = h('div', { class: 'right-body' });
  const rightPanel = h('aside', { class: 'island right-panel' }, rightBody);

  const statusBarHost = h('footer', { class: 'statusbar-host' });

  const root = h(
    'div',
    { class: 'app' },
    topBar,
    sidebar,
    sidebarSplitter,
    center,
    rightSplitter,
    rightPanel,
    statusBarHost,
  );

  let sidebarVisible = true;
  let rightVisible = true;
  let dockVisible = false;

  const apply = (): void => {
    root.classList.toggle('is-sidebar-hidden', !sidebarVisible);
    root.classList.toggle('is-right-hidden', !rightVisible);
    root.classList.toggle('is-dock-hidden', !dockVisible);
  };

  clear(mount);
  mount.appendChild(root);
  apply();

  attachSplitter(root, sidebarSplitter, {
    cssVar: '--sidebar-size',
    axis: 'x',
    min: 170,
    max: 560,
    invert: false,
    reset: 260,
    oppositeVar: '--right-width',
    onCommit: options.onChange,
  });
  attachSplitter(root, rightSplitter, {
    cssVar: '--right-size',
    axis: 'x',
    min: 280,
    max: 760,
    invert: true,
    reset: 400,
    oppositeVar: '--sidebar-width',
    onCommit: options.onChange,
  });
  attachSplitter(root, dockSplitter, {
    cssVar: '--dock-size',
    onCommit: options.onChange,
    axis: 'y',
    min: 100,
    max: 800,
    invert: true,
    reset: 260,
  });

  return {
    root,
    topBar,
    topBarLeft,
    topBarTitle,
    topBarRight,
    sidebar,
    sidebarBody,
    tabsHost,
    breadcrumbsHost,
    editorHost,
    editorIsland,
    dockHost,
    rightPanel,
    rightBody,
    statusBarHost,
    get sidebarVisible() {
      return sidebarVisible;
    },
    get rightVisible() {
      return rightVisible;
    },
    get dockVisible() {
      return dockVisible;
    },
    setSidebarVisible(visible: boolean) {
      sidebarVisible = visible;
      apply();
      options.onChange?.();
    },
    setRightVisible(visible: boolean) {
      rightVisible = visible;
      apply();
      options.onChange?.();
    },
    setDockVisible(visible: boolean) {
      dockVisible = visible;
      apply();
      options.onChange?.();
    },
    get sidebarSize() {
      return readLayoutSize(root, '--sidebar-size');
    },
    get rightSize() {
      return readLayoutSize(root, '--right-size');
    },
    get dockSize() {
      return readLayoutSize(root, '--dock-size');
    },
    setSidebarSize(size: number) {
      root.style.setProperty('--sidebar-size', String(Math.round(size)) + 'px');
    },
    setRightSize(size: number) {
      root.style.setProperty('--right-size', String(Math.round(size)) + 'px');
    },
    setDockSize(size: number) {
      root.style.setProperty('--dock-size', String(Math.round(size)) + 'px');
    },
  };
}

interface SplitterOptions {
  cssVar: string;
  axis: 'x' | 'y';
  min: number;
  max: number;
  /** true для панелей справа и снизу: тянуть нужно в противоположную сторону. */
  invert: boolean;
  /** Ширина, к которой возвращает двойной клик. */
  reset?: number;
  /** Переменная панели напротив: по ней считаем предел, чтобы не съесть редактор. */
  oppositeVar?: string;
  /** Вызывается после изменения размера — для сохранения макета. */
  onCommit?: () => void;
}

/** Ниже этого редактор уже не читается — дальше панель не пускаем. */
const MIN_EDITOR = 200;

/**
 * Перетаскивание разделителя.
 *
 * Главное здесь — `setPointerCapture`. Без него события приходят, только пока
 * курсор физически лежит на полосе в 6 px: стоит дёрнуть мышь чуть быстрее,
 * и `pointermove` уходит в редактор, а перетаскивание «отваливается».
 * Захват перенаправляет все события разделителю, где бы курсор ни оказался.
 */
function readLayoutSize(root: HTMLElement, cssVar: string): number {
  const raw = getComputedStyle(root).getPropertyValue(cssVar).trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : 0;
}

function attachSplitter(root: HTMLElement, splitter: HTMLElement, options: SplitterOptions): void {
  const horizontal = options.axis === 'x';

  const readSize = (name: string): number => Number.parseFloat(getComputedStyle(root).getPropertyValue(name)) || 0;

  splitter.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const start = horizontal ? event.clientX : event.clientY;
    const startSize = readSize(options.cssVar);
    const opposite = options.oppositeVar ? readSize(options.oppositeVar) : 0;
    const limit = horizontal ? window.innerWidth - opposite - MIN_EDITOR : window.innerHeight - MIN_EDITOR;

    // Захват может не сработать (например, указатель уже отпущен) — тогда
    // перетаскивание продолжит работать, просто без «резинки» за курсором.
    try {
      splitter.setPointerCapture(event.pointerId);
    } catch {
      /* обойдёмся без захвата */
    }
    splitter.classList.add('is-dragging');
    // Курсор во время перетаскивания держим сами: иначе редактор под курсором
    // переключает его на текстовый и непонятно, что вообще происходит.
    root.classList.add(horizontal ? 'is-resizing-x' : 'is-resizing-y');

    const onMove = (move: PointerEvent): void => {
      const current = horizontal ? move.clientX : move.clientY;
      const delta = options.invert ? start - current : current - start;
      const size = Math.min(Math.max(startSize + delta, options.min), Math.min(options.max, limit));
      root.style.setProperty(options.cssVar, `${size}px`);
    };

    const onUp = (): void => {
      splitter.classList.remove('is-dragging');
      root.classList.remove('is-resizing-x', 'is-resizing-y');
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
      splitter.removeEventListener('pointercancel', onUp);
      splitter.removeEventListener('lostpointercapture', onUp);
      if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
      options.onCommit?.();
    };

    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
    splitter.addEventListener('pointercancel', onUp);
    splitter.addEventListener('lostpointercapture', onUp);
  });

  // Двойной клик возвращает размер по умолчанию — привычный жест.
  if (options.reset !== undefined) {
    const reset = options.reset;
    splitter.addEventListener('dblclick', () => {
      root.style.setProperty(options.cssVar, `${reset}px`);
      options.onCommit?.();
    });
  }
}
