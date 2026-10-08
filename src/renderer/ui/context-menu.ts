import { h } from './dom';

export type ContextMenuItem =
  | { separator: true }
  | { label: string; onSelect(): void; danger?: boolean; hint?: string };

let current: HTMLElement | null = null;
let detach: (() => void) | null = null;

/** Контекстное меню в духе PyCharm: скруглённая панель, закрытие по Esc и клику вне. */
export function showContextMenu(items: readonly ContextMenuItem[], x: number, y: number): void {
  closeContextMenu();

  const menu = h('div', { class: 'context-menu', role: 'menu' });
  for (const item of items) {
    if ('separator' in item) {
      menu.appendChild(h('div', { class: 'context-separator' }));
      continue;
    }
    const entry = h(
      'button',
      { class: `context-item${item.danger ? ' is-danger' : ''}`, type: 'button', role: 'menuitem' },
      h('span', {}, item.label),
      item.hint ? h('span', { class: 'context-hint' }, item.hint) : null,
    );
    entry.addEventListener('click', () => {
      closeContextMenu();
      item.onSelect();
    });
    menu.appendChild(entry);
  }

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(left, 8)}px`;
  menu.style.top = `${Math.max(top, 8)}px`;

  current = menu;

  const onPointerDown = (event: PointerEvent): void => {
    if (menu.contains(event.target as Node)) return;
    closeContextMenu();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeContextMenu();
    }
  };

  // Слушаем в capture и с задержкой: иначе тот же клик, которым открыли меню,
  // сразу же его и закроет.
  const timer = setTimeout(() => {
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
  }, 0);

  detach = () => {
    clearTimeout(timer);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('keydown', onKeyDown, true);
  };

  menu.addEventListener('contextmenu', (event) => event.preventDefault());
}

export function closeContextMenu(): void {
  detach?.();
  detach = null;
  current?.remove();
  current = null;
}
