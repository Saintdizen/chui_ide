import { h, svgIcon } from './dom';

/**
 * Выпадающие панели: контекстное меню и меню приложения — один движок.
 *
 * Оба места выглядят и ведут себя одинаково (панель, разделители, подсказка справа),
 * поэтому и код один: `.context-menu` рисуется здесь, а `context-menu.ts` и
 * `app-menu.ts` только собирают пункты. Отличие меню приложения — подменю, поэтому
 * уровней может быть несколько: каждый следующий открывается от своего пункта.
 */
export type PopupMenuItem =
  | { separator: true }
  | {
      label: string;
      /** Подсказка справа: горячая клавиша или пояснение. */
      hint?: string;
      danger?: boolean;
      /** Подменю: открывается рядом с пунктом. */
      submenu?: readonly PopupMenuItem[];
      onSelect?(): void;
    };

export interface PopupOptions {
  /** Элемент, от которого отсчитывается место: первая панель встаёт под ним. */
  anchor?: HTMLElement;
  /** Меню закрылось — неважно, выбором пункта, Esc или кликом вне. */
  onClose?(): void;
}

interface Level {
  menu: HTMLElement;
  /** Пункт, из которого открыт этот уровень: к нему возвращает стрелка влево. */
  parent?: HTMLElement;
  /** Пункты уровня: нужны для навигации с клавиатуры. */
  entries: HTMLElement[];
  items: readonly PopupMenuItem[];
}

const GAP = 6;
const EDGE = 8;

const levels: Level[] = [];
let detach: (() => void) | null = null;
let closed: (() => void) | null = null;

export function isPopupOpen(): boolean {
  return levels.length > 0;
}

/**
 * Панель уровня: пункты, подсказки и подменю.
 *
 * Обработчики пункта работают со СВОИМ уровнем (`levels.indexOf(level)`), а не
 * с последним открытым: как только открывается подменю, `levels.length - 1` —
 * уже чужой уровень, и наведение на пункты верхнего уровня перестаёт что-либо
 * открывать (подсветка «залипает», подменю остаётся прежним).
 */
function buildLevel(level: Level): void {
  const menu = level.menu;

  for (const item of level.items) {
    if ('separator' in item) {
      menu.appendChild(h('div', { class: 'context-separator' }));
      continue;
    }

    const entry = h(
      'button',
      {
        class: `context-item${item.danger ? ' is-danger' : ''}${item.submenu ? ' has-submenu' : ''}`,
        type: 'button',
        role: 'menuitem',
        'aria-haspopup': item.submenu ? 'true' : undefined,
      },
      h('span', {}, item.label),
      item.hint && !item.submenu ? h('span', { class: 'context-hint' }, item.hint) : null,
      item.submenu ? h('span', { class: 'context-arrow' }, svgIcon('chevron', 11)) : null,
    );

    const own = (): number => levels.indexOf(level);
    const index = (): number => level.entries.indexOf(entry);

    entry.addEventListener('mouseenter', () => {
      const at = own();
      if (at < 0) return;
      highlight(at, index());
      if (item.submenu) openSubmenu(at, index());
      else closeLevelsAbove(at);
    });
    entry.addEventListener('click', (event) => {
      event.stopPropagation();
      const at = own();
      if (at < 0) return;
      if (item.submenu) {
        openSubmenu(at, index());
        return;
      }
      const select = item.onSelect;
      closePopupMenu();
      select?.();
    });

    level.entries.push(entry);
    menu.appendChild(entry);
  }
}

function position(menu: HTMLElement, x: number, y: number): void {
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(Math.min(x, window.innerWidth - rect.width - EDGE), EDGE)}px`;
  menu.style.top = `${Math.max(Math.min(y, window.innerHeight - rect.height - EDGE), EDGE)}px`;
}

function openLevel(items: readonly PopupMenuItem[], x: number, y: number, parent?: HTMLElement): Level {
  const level: Level = { menu: h('div', { class: 'context-menu', role: 'menu' }), parent, entries: [], items };
  buildLevel(level);
  document.body.appendChild(level.menu);
  position(level.menu, x, y);
  levels.push(level);
  return level;
}

/** Подменю от пункта: справа от него, а если места нет — слева. */
function openSubmenu(levelIndex: number, itemIndex: number): void {
  const level = levels[levelIndex];
  const item = level?.items[itemIndex];
  const entry = level?.entries[itemIndex];
  if (!level || !item || !entry || !('submenu' in item) || !item.submenu) return;

  // Уровень уже открыт от этого пункта — ничего не пересобираем, иначе подменю
  // мигало бы на каждом движении мыши.
  const open = levels[levelIndex + 1];
  if (open?.parent === entry) return;

  closeLevelsAbove(levelIndex);

  const itemRect = entry.getBoundingClientRect();
  const panelRect = level.menu.getBoundingClientRect();
  const probe = openLevel(item.submenu, panelRect.right + 2, itemRect.top - 4, entry);
  entry.classList.add('is-open');
  const width = probe.menu.getBoundingClientRect().width;
  // Подменю встаёт рядом с ПАНЕЛЬЮ, а не с пунктом: иначе оно наезжает на неё.
  const right = panelRect.right + 2;
  const left = right + width + EDGE <= window.innerWidth ? right : panelRect.left - width - 2;
  position(probe.menu, left, itemRect.top - 4);
  highlight(levelIndex + 1, 0);
}

function closeLevelsAbove(index: number): void {
  while (levels.length > index + 1) levels.pop()?.menu.remove();
  for (const entry of levels[index]?.entries ?? []) entry.classList.remove('is-open');
}

function highlight(levelIndex: number, itemIndex: number): void {
  const level = levels[levelIndex];
  if (!level) return;
  level.entries.forEach((entry, index) => {
    entry.classList.toggle('is-highlighted', index === itemIndex);
  });
}

function highlighted(levelIndex: number): number {
  return levels[levelIndex]?.entries.findIndex((entry) => entry.classList.contains('is-highlighted')) ?? -1;
}

/** Шаг по пунктам уровня: подсветка ходит по кругу, разделители пропускает. */
function move(levelIndex: number, step: number): void {
  const level = levels[levelIndex];
  if (!level || level.entries.length === 0) return;
  const current = highlighted(levelIndex);
  const next = (current + step + level.entries.length) % level.entries.length;
  highlight(levelIndex, next);
  // Стрелками подменю само не раскрывается: иначе ходить по списку невозможно —
  // первый же пункт с подменю перехватывал бы движение. Раскрытие — вправо или Enter.
  closeLevelsAbove(levelIndex);
}

function activateHighlighted(levelIndex: number): void {
  const index = highlighted(levelIndex);
  const item = levels[levelIndex]?.items[index];
  if (item && 'submenu' in item && item.submenu) openSubmenu(levelIndex, index);
  else closeLevelsAbove(levelIndex);
}

export function showPopupMenu(items: readonly PopupMenuItem[], x: number, y: number, options: PopupOptions = {}): void {
  closePopupMenu();
  closed = options.onClose ?? null;

  const anchor = options.anchor;
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    openLevel(items, rect.left, rect.bottom + GAP);
  } else {
    openLevel(items, x, y);
  }
  highlight(0, firstSelectable(0));

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node;
    if (levels.some((level) => level.menu.contains(target))) return;
    closePopupMenu();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    const last = levels.length - 1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(last, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      activateHighlighted(last);
      return;
    }
    if (event.key === 'ArrowLeft' && last > 0) {
      event.preventDefault();
      const parent = levels[last]?.parent;
      levels.pop()?.menu.remove();
      if (parent) {
        const level = levels[last - 1];
        const index = level?.entries.indexOf(parent) ?? -1;
        if (index >= 0) highlight(last - 1, index);
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const index = highlighted(last);
      const item = levels[last]?.items[index];
      if (item && !('separator' in item)) {
        event.preventDefault();
        levels[last]?.entries[index]?.click();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closePopupMenu();
    }
  };
  const onDismiss = (): void => closePopupMenu();

  // Слушаем в capture и с задержкой: иначе тот же клик, которым меню открыли,
  // сразу же его и закроет.
  const timer = setTimeout(() => {
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onDismiss);
    window.addEventListener('blur', onDismiss);
  }, 0);

  detach = () => {
    clearTimeout(timer);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onDismiss);
    window.removeEventListener('blur', onDismiss);
  };

  // Правый клик внутри панели не должен открывать системное меню.
  for (const level of levels) level.menu.addEventListener('contextmenu', (event) => event.preventDefault());
}

/** Первый пункт, который можно нажать: разделители пропускаем. */
function firstSelectable(levelIndex: number): number {
  const level = levels[levelIndex];
  const index = level?.items.findIndex((item) => !('separator' in item)) ?? 0;
  return index < 0 ? 0 : index;
}

export function closePopupMenu(): void {
  detach?.();
  detach = null;
  while (levels.length > 0) levels.pop()?.menu.remove();

  const notify = closed;
  closed = null;
  notify?.();
}
