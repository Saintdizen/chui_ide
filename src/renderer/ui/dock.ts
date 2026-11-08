import { h, svgIcon } from './dom';

export interface DockTab {
  id: string;
  title: string;
  element: HTMLElement;
  /** Число-значок на вкладке (проблемы): `null`/пусто — значка нет. */
  badge?: () => string | null;
  /** Вызывается, когда вкладка становится видимой: терминалу нужно пересчитать размер. */
  onShow?(): void;
}

export interface DockView {
  element: HTMLElement;
  /**
   * Шапка с вкладками — за неё таскают плавающую панель.
   *
   * Отдаём наружу, а не вешаем обработчик здесь: таскать имеет смысл только
   * плавающую панель, и знает об этом раскладка, а не сама панель.
   */
  handle: HTMLElement;
  register(tab: DockTab): void;
  show(id: string): void;
  /** Показать вкладку и увести в неё фокус: шаг с клавиатуры, а не только вид. */
  showAndFocus(id: string): void;
  toggle(id: string): void;
  hide(): void;
  /** Перечитать значки вкладок: их источник изменился (число проблем). */
  refreshBadges(): void;
  readonly visible: boolean;
  readonly activeId: string | null;
  /** Где была панель до дзена: по этому месту она и вернётся. */
  readonly height: number;
  setHeight(height: number): void;
  onVisibilityChange(listener: (visible: boolean) => void): void;
}

/**
 * Нижняя панель (терминал, поиск) — как панель инструментов:
 * свои вкладки слева, кнопка сворачивания справа.
 */
export function createDock(): DockView {
  const tabsHost = h('div', { class: 'dock-tabs', role: 'tablist', 'aria-label': 'Нижняя панель' });
  const collapse = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Свернуть нижнюю панель', onClick: () => hide() },
    svgIcon('chevronDown', 14),
  );
  const header = h('div', { class: 'dock-header' }, tabsHost, h('div', { class: 'dock-header-spacer' }), collapse);
  const body = h('div', { class: 'dock-body' });
  const element = h('div', { class: 'dock' }, header, body);

  const tabs: DockTab[] = [];
  const buttons = new Map<string, HTMLButtonElement>();
  /** Значки вкладок по id: текст берём у самой вкладки (`badge`). */
  const badges = new Map<string, HTMLElement>();
  const listeners = new Set<(visible: boolean) => void>();
  let activeId: string | null = null;
  let visible = false;
  /** Высота, которую панель отдала дзену: пока она не ноль, панель свою высоту помнит. */
  let stash: number | null = null;

  const notify = (): void => {
    for (const listener of [...listeners]) listener(visible);
  };

  const activate = (id: string): void => {
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return;

    activeId = id;
    for (const item of tabs) item.element.hidden = item.id !== id;
    // Один обход Tab на весь ряд вкладок (APG `tabs`). Без этого Tab честно
    // перебирал бы все до одной, а их до десятка.
    for (const [key, button] of buttons) {
      button.classList.toggle('is-active', key === id);
      button.tabIndex = key === id ? 0 : -1;
      button.setAttribute('aria-selected', key === id ? 'true' : 'false');
    }

    visible = true;
    element.classList.add('is-visible');
    tab.onShow?.();
    notify();
  };

  /**
   * Открыть вкладку и увести в неё фокус. Отличается от `activate` ровно
   * этим: команда `view.*` — это шаг с клавиатуры, и если после неё фокус
   * остался в старом месте, следующее нажатие уйдёт туда же. Дальше `onShow`
   * сам решает, куда ставить фокус внутри панели (поиску — в поле, терминалу —
   * в свой)
   */
  const showAndFocus = (id: string): void => {
    activate(id);
    // Фокус — туда, куда его поставил `onShow` вкладки (поле поиска, терминал),
    // а если не поставил — на саму вкладку: она честный вход, и дальше Tab
    // ведёт внутрь панели, а не в обход всего окна.
    // Сравниваем с `document.body`: после `activate` там сидит ноль — вкладка
    // могла отдать фокус своему полю, и перебивать это нечего.
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    buttons.get(id)?.focus();
  };

  /**
   * Стрелки по вкладкам дока. APG `tabs`: стрелка ходит по кругу и СРАЗУ
   * активирует, ибо соседних панелей не видно и `Home/End` ищут то же самое.
   * С обработчиком на `tabsHost`, а не на каждой кнопке: вкладки пересоздаются
   * при `refreshBadges`, а панель живёт.
   */
  tabsHost.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    if (buttons.size === 0) return;
    const order = tabs.map((tab) => tab.id).filter((id) => buttons.has(id));
    const current = activeId === null ? 0 : Math.max(order.indexOf(activeId), 0);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next =
      event.key === 'Home'
        ? order[0]
        : event.key === 'End'
          ? order[order.length - 1]
          : order[(current + step + order.length) % order.length];
    if (!next) return;
    event.preventDefault();
    activate(next);
    buttons.get(next)?.focus();
  });

  const refreshBadges = (): void => {
    for (const tab of tabs) {
      const node = badges.get(tab.id);
      if (!node) continue;
      const text = tab.badge?.() ?? null;
      node.textContent = text ?? '';
      node.hidden = !text;
    }
  };

  const hide = (): void => {
    visible = false;
    element.classList.remove('is-visible');
    notify();
  };

  return {
    element,
    handle: header,
    register(tab) {
      tabs.push(tab);
      tab.element.hidden = true;
      // Связь вкладка ↔ панель по `id`: без неё читалка не скажет, что
      // открылось — она видит две разные вещи и не знает, что они пара.
      const panelId = `dock-panel-${tab.id}`;
      tab.element.id = panelId;
      tab.element.setAttribute('role', 'tabpanel');
      tab.element.setAttribute('aria-label', tab.title);
      body.appendChild(tab.element);

      const badge = h('span', { class: 'dock-tab-badge', hidden: true });
      const button = h(
        'button',
        {
          class: 'dock-tab',
          type: 'button',
          role: 'tab',
          // APG `tabs`: в обходе Tab — только активная вкладка, соседние берутся
          // стрелками. Иначе Tab перебирал бы все подряд, а их до десятка, и
          // добраться до содержимого панели стоило бы восьми нажатий.
          // Кому 0, а кому -1, решает обход в `activate` — при каждой активации.
          tabIndex: -1,
          'aria-controls': panelId,
          'aria-selected': 'false',
          onClick: () => activate(tab.id),
        },
        tab.title,
        badge,
      );
      buttons.set(tab.id, button);
      badges.set(tab.id, badge);
      tabsHost.appendChild(button);
      refreshBadges();

      // Первую вкладку только запоминаем: панель откроется, когда её попросят.
      if (!activeId) activeId = tab.id;
    },
    show: activate,
    showAndFocus,
    toggle(id) {
      if (visible && activeId === id) hide();
      else activate(id);
    },
    hide,
    refreshBadges,
    get visible() {
      return visible;
    },
    get activeId() {
      return activeId;
    },
    get height() {
      return stash ?? 0;
    },
    setHeight(height) {
      stash = height > 0 ? height : null;
    },
    onVisibilityChange(listener) {
      listeners.add(listener);
    },
  };
}
