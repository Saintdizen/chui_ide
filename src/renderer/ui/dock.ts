import { h, svgIcon } from './dom';

export interface DockTab {
  id: string;
  title: string;
  element: HTMLElement;
  /** Вызывается, когда вкладка становится видимой: терминалу нужно пересчитать размер. */
  onShow?(): void;
}

export interface DockView {
  element: HTMLElement;
  register(tab: DockTab): void;
  show(id: string): void;
  toggle(id: string): void;
  hide(): void;
  readonly visible: boolean;
  readonly activeId: string | null;
  onVisibilityChange(listener: (visible: boolean) => void): void;
}

/**
 * Нижняя панель (терминал, поиск) — как tool window в PyCharm:
 * свои вкладки слева, кнопка сворачивания справа.
 */
export function createDock(): DockView {
  const tabsHost = h('div', { class: 'dock-tabs' });
  const collapse = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Свернуть панель', onClick: () => hide() },
    svgIcon('chevronDown', 14),
  );
  const header = h('div', { class: 'dock-header' }, tabsHost, h('div', { class: 'dock-header-spacer' }), collapse);
  const body = h('div', { class: 'dock-body' });
  const element = h('div', { class: 'dock' }, header, body);

  const tabs: DockTab[] = [];
  const buttons = new Map<string, HTMLButtonElement>();
  const listeners = new Set<(visible: boolean) => void>();
  let activeId: string | null = null;
  let visible = false;

  const notify = (): void => {
    for (const listener of [...listeners]) listener(visible);
  };

  const activate = (id: string): void => {
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return;

    activeId = id;
    for (const item of tabs) item.element.hidden = item.id !== id;
    for (const [key, button] of buttons) button.classList.toggle('is-active', key === id);

    visible = true;
    element.classList.add('is-visible');
    tab.onShow?.();
    notify();
  };

  const hide = (): void => {
    visible = false;
    element.classList.remove('is-visible');
    notify();
  };

  return {
    element,
    register(tab) {
      tabs.push(tab);
      tab.element.hidden = true;
      body.appendChild(tab.element);

      const button = h('button', { class: 'dock-tab', type: 'button', onClick: () => activate(tab.id) }, tab.title);
      buttons.set(tab.id, button);
      tabsHost.appendChild(button);

      // Первую вкладку только запоминаем: панель откроется, когда её попросят.
      if (!activeId) activeId = tab.id;
    },
    show: activate,
    toggle(id) {
      if (visible && activeId === id) hide();
      else activate(id);
    },
    hide,
    get visible() {
      return visible;
    },
    get activeId() {
      return activeId;
    },
    onVisibilityChange(listener) {
      listeners.add(listener);
    },
  };
}
