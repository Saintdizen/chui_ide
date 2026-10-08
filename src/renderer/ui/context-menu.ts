import { closePopupMenu, showPopupMenu, type PopupMenuItem } from './popup-menu';

/**
 * Контекстное меню в духе PyCharm: скруглённая панель, закрытие по Esc и клику вне.
 *
 * Своего кода рисования здесь нет — панель одна на всё приложение (`popup-menu.ts`),
 * а этот модуль оставлен ради привычных имён: пункты правого клика в проводнике,
 * вкладках и чате описываются теми же полями.
 */
export type ContextMenuItem = PopupMenuItem;

export function showContextMenu(items: readonly ContextMenuItem[], x: number, y: number): void {
  showPopupMenu(items, x, y);
}

export function closeContextMenu(): void {
  closePopupMenu();
}
