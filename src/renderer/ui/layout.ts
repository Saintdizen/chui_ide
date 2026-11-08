import { clear, h } from './dom';
import { FILE_PANEL_ID } from './tabs';
import { applyPanelIntent, type PanelState, panelOrder } from '../core/panel-layout';
import type { SidebarPosition } from '../../shared/api/settings';
import { centeredFloating, clampFloating, dragFloating, resizeFloating, type FloatingRect } from '../../shared/floating-dock';

/**
 * Каркас в духе современных IDE: фон приложения темнее панелей, панели —
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
  readonly dockPosition: 'bottom' | 'right';
  readonly editorVisible: boolean;
  setSidebarVisible(visible: boolean): void;
  setRightVisible(visible: boolean): void;
  setDockVisible(visible: boolean): void;
  setDockPosition(position: 'bottom' | 'right'): void;
  /** Панель плавает поверх окна (`true`) или стоит в сетке (`false`). */
  readonly dockFloating: boolean;
  setDockFloating(on: boolean): void;
  moveDockFloating(dx: number, dy: number): void;
  resizeDockFloating(dx: number, dy: number): void;
  setEditorVisible(visible: boolean): void;
  readonly sidebarSize: number;
  readonly rightSize: number;
  readonly dockSize: number;
  setSidebarSize(size: number): void;
  setRightSize(size: number): void;
  setDockSize(size: number): void;
  /**
   * С какой стороны стоит боковая панель. Переезд — это класс на корне и порядок
   * элементов сетки, а не пересборка DOM: содержимое панели живёт в `sidebarBody`
   * и переезжает вместе с ней (см. `SidebarPosition`).
   */
  readonly sidebarPosition: SidebarPosition;
  setSidebarPosition(position: SidebarPosition): void;
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
  // Остров редактора — панель полосы вкладок-файлов: вкладка называет его через
  // `aria-controls` (`FILE_PANEL_ID` в `ui/tabs.ts`), а он — её через
  // `aria-labelledby`, которое ставит `app.ts` при смене активной вкладки.
  const editorHost = h('div', { class: 'editor-host', id: FILE_PANEL_ID });
  const editorIsland = h('section', { class: 'island editor-island', role: 'tabpanel' }, tabsHost, editorHost);

  const dockSplitter = h('div', { class: 'splitter splitter-dock' });
  const dockHost = h('div', { class: 'dock-host' });
  // Уголок размера — только в плавающем виде: у панели в сетке размер задаёт
  // разделитель, и второй способ тянуть то же самое только путал бы.
  const dockResizeGrip = h('div', {
    class: 'dock-resize-grip',
    role: 'presentation',
    title: 'Потянуть за угол: размер панели',
  });
  const dockIsland = h('section', { class: 'island dock' }, dockHost, dockResizeGrip);
  dockResizeGrip.addEventListener('pointerdown', (event) => {
    if (floating === null || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dockResizeGrip.setPointerCapture(event.pointerId);
    let lastX = event.clientX;
    let lastY = event.clientY;
    const move = (moveEvent: PointerEvent): void => {
      // От предыдущего события, как и перетаскивание: иначе рывок догоняния.
      floating =
        floating === null
          ? null
          : resizeFloating(
              floating,
              { dx: moveEvent.clientX - lastX, dy: moveEvent.clientY - lastY },
              { width: root.clientWidth, height: root.clientHeight },
            );
      lastX = moveEvent.clientX;
      lastY = moveEvent.clientY;
      applyFloating();
    };
    const end = (): void => {
      dockResizeGrip.removeEventListener('pointermove', move);
      dockResizeGrip.removeEventListener('pointerup', end);
      dockResizeGrip.removeEventListener('pointercancel', end);
      options.onChange?.();
    };
    dockResizeGrip.addEventListener('pointermove', move);
    dockResizeGrip.addEventListener('pointerup', end);
    dockResizeGrip.addEventListener('pointercancel', end);
  });
  // Нижний остров — своей дорожкой сетки: только под редактором. Ни под проводником,
  // ни под правой панелью: обе идут вниз до строки состояния.
  const dockWrap = h('div', { class: 'dock-wrap' }, dockSplitter, dockIsland);
  // Слой для плавающей панели: он же ловит клики ПО МИМО неё — но только пока
  // панель плавает, иначе перекрывал бы всё окно.
  const floatingLayer = h('div', { class: 'floating-layer', hidden: true });

  const center = h('div', { class: 'center' }, editorIsland);
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
    dockWrap,
    statusBarHost,
    // Слой плавающей панели — последним: он поверх всех, включая строку
    // состояния, иначе панель, поднятая вниз, оказалась бы под ней.
    floatingLayer,
  );

  // Видимость панелей — одним состоянием: редактор и правая панель связаны
  // инвариантом (см. `applyPanelIntent`), а разнесённые `let` однажды применят
  // его наполовину.
  let panels: PanelState = { sidebar: true, right: true, editor: true };
  let dockVisible = false;
  let dockPosition: 'bottom' | 'right' = 'bottom';
  /**
   * Плавающее положение панели; `null` — панель стоит в сетке.
   *
   * Панель при этом не создаётся заново: `dockIsland` переезжает между двумя
   * хозяевами (сетка и слой поверх). Терминал и поиск живут в тех же узлах и
   * переживают переезд — пересборка съела бы их содержимое и прокрутку.
   */
  let floating: FloatingRect | null = null;
  // Сторона, с которой стоит боковая панель. Хранится классом на корне и порядком
  // элементов сетки — так содержимое панели переезжает, не теряя состояния
  // (открытые блоки, прокрутка, фокус), и не нужно пересобирать DOM.
  let sidebarPosition: SidebarPosition = 'left';

  /**
   * Перевезти панель между сеткой и слоем поверх и поставить по размеру.
   *
   * Место в сетке после переезда держит `dockWrap` (он остаётся на месте),
   * поэтому по возвращении панель встаёт туда же, где стояла, а не в конец.
   */
  const applyFloating = (): void => {
    if (floating === null) {
      // Назад в сетку: вставляем туда, где панель и была — после разделителя.
      if (dockIsland.parentElement !== dockWrap) dockWrap.appendChild(dockIsland);
      for (const key of ['position', 'left', 'top', 'width', 'height'] as const) {
        dockIsland.style.removeProperty(key);
      }
      floatingLayer.hidden = true;
      if (dockIsland.parentElement === floatingLayer) floatingLayer.removeChild(dockIsland);
      return;
    }
    const rect = clampFloating(floating, {
      width: root.clientWidth,
      height: root.clientHeight,
    });
    floatingLayer.hidden = false;
    if (dockIsland.parentElement !== floatingLayer) floatingLayer.appendChild(dockIsland);
    dockIsland.style.position = 'absolute';
    dockIsland.style.left = `${rect.left}px`;
    dockIsland.style.top = `${rect.top}px`;
    dockIsland.style.width = `${rect.width}px`;
    dockIsland.style.height = `${rect.height}px`;
  };

  const apply = (): void => {
    root.classList.toggle('is-sidebar-hidden', !panels.sidebar);
    root.classList.toggle('is-right-hidden', !panels.right);
    root.classList.toggle('is-editor-hidden', !panels.editor);
    root.classList.toggle('is-dock-hidden', !dockVisible);
    // Имя раскладки берём из чистой функции — тест проверяет её, а не строку в CSS.
    root.classList.toggle('is-sidebar-right', panelOrder(sidebarPosition) === 'sidebar-last');
    root.classList.toggle('is-dock-right', dockPosition === 'right');
    root.classList.toggle('is-dock-floating', floating !== null);
    applyFloating();
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
    min: RIGHT_MIN_SIZE,
    max: 760,
    invert: true,
    reset: RIGHT_DEFAULT_SIZE,
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
    editorHost,
    editorIsland,
    dockHost,
    rightPanel,
    rightBody,
    statusBarHost,
    get sidebarVisible() {
      return panels.sidebar;
    },
    get rightVisible() {
      return panels.right;
    },
    get dockPosition() {
      return dockPosition;
    },
    get dockFloating() {
      return floating !== null;
    },
    get dockVisible() {
      return dockVisible;
    },
    get editorVisible() {
      return panels.editor;
    },
    setSidebarVisible(visible: boolean) {
      panels = applyPanelIntent(panels, { sidebar: visible });
      apply();
      options.onChange?.();
    },
    setRightVisible(visible: boolean) {
      const next = applyPanelIntent(panels, { right: visible });
      // Инвариант отклонил намерение: скрытый редактор держит правую панель.
      // Молча, без записи в настройки — панель ведь не менялась.
      if (next.right === panels.right) return;
      panels = next;
      apply();
      options.onChange?.();
    },
    /**
     * С какой стороны нижняя панель. Классом на корне, а не перестройкой DOM:
     * перестройка убила бы содержимое панели (терминал, поиск) и сбросила бы
     * прокрутку — панель та же, только стоит иначе.
     */
    setDockPosition(position: 'bottom' | 'right') {
      dockPosition = position;
      apply();
      options.onChange?.();
    },
    /**
     * Отпустить панель в свободное плавание или вернуть в сетку.
     *
     * `true` без размера — поставить по центру окна: отдавать повеление без
     * места хуже, чем не отдавать вовсе: панель окажется в случайных координатах.
     */
    setDockFloating(on: boolean) {
      floating = on ? centeredFloating({ width: root.clientWidth, height: root.clientHeight }) : null;
      apply();
      options.onChange?.();
    },
    /** Сдвинуть плавающую панель на смещение в пикселях (перетаскивание). */
    moveDockFloating(dx: number, dy: number) {
      if (floating === null) return;
      floating = dragFloating(floating, { dx, dy }, {
        width: root.clientWidth,
        height: root.clientHeight,
      });
      applyFloating();
    },
    /** Потянуть за угол: размер окна, с пределом по содержимому. */
    resizeDockFloating(dx: number, dy: number) {
      if (floating === null) return;
      floating = resizeFloating(floating, { dx, dy }, {
        width: root.clientWidth,
        height: root.clientHeight,
      });
      applyFloating();
    },
    setDockVisible(visible: boolean) {
      dockVisible = visible;
      apply();
      options.onChange?.();
    },
    setEditorVisible(visible: boolean) {
      // Скрывая редактор при свёрнутой правой, раскладка возвращает правую:
      // пустое окно — не состояние, а поломка (см. `applyPanelIntent`).
      panels = applyPanelIntent(panels, { editor: visible });
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
      root.style.setProperty('--sidebar-size', `${Math.round(size)}px`);
    },
    setRightSize(size: number) {
      // Кламп: макет из прежней версии или другого экрана мог быть уже минимума.
      root.style.setProperty('--right-size', `${Math.round(Math.max(size, RIGHT_MIN_SIZE))}px`);
    },
    setDockSize(size: number) {
      root.style.setProperty('--dock-size', `${Math.round(size)}px`);
    },
    get sidebarPosition() {
      return sidebarPosition;
    },
    setSidebarPosition(position: SidebarPosition) {
      if (position === sidebarPosition) return;
      sidebarPosition = position;
      apply();
      options.onChange?.();
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
 * Ниже этого правую панель не сужаем: чат с композером в 250 px ещё читается
 * (тулбар композера — сетка из двух колонок и переносит контролы внутри первой),
 * а дальше панель уже не панель. Предел общий для перетаскивания и
 * восстановления макета: сохранённый размер из прежней версии мог быть меньше,
 * и без клампа панель открылась бы уже минимума.
 */
const RIGHT_MIN_SIZE = 250;

/** Ширина правой панели по умолчанию — к ней возвращает двойной клик. */
const RIGHT_DEFAULT_SIZE = 500;

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

    // Кадр на жест: на мыши с высокой частотой опроса `pointermove` приходит
    // сотни раз в секунду, и запись размера на каждое событие пересчитывала бы
    // раскладку чаще, чем экран успевает показать кадр. Копим последнее значение
    // и пишем раз в кадр — так же, как растягивание окна (window-frame.ts).
    let frame = 0;
    let queued = startSize;

    const onMove = (move: PointerEvent): void => {
      const current = horizontal ? move.clientX : move.clientY;
      const delta = options.invert ? start - current : current - start;
      queued = Math.min(Math.max(startSize + delta, options.min), Math.min(options.max, limit));
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        root.style.setProperty(options.cssVar, `${queued}px`);
      });
    };

    const onUp = (): void => {
      // Доводим последнее значение: отпустить могли, не дождавшись кадра.
      if (frame) cancelAnimationFrame(frame);
      root.style.setProperty(options.cssVar, `${queued}px`);
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
