import { APP_MENU, type MenuNode, type MenuRole } from '../../shared/app-menu';
import { showPopupMenu, type PopupMenuItem } from './popup-menu';

/**
 * Меню приложения — то же, что открывает кнопка «☰». Рисует его renderer, поэтому
 * внешне оно не отличается от контекстных меню и выпадающих списков.
 *
 * Структура берётся из `shared/app-menu.ts` — из того же шаблона main собирает
 * системное меню, которое держит горячие клавиши. Так списки не разъезжаются.
 */
export interface AppMenuDeps {
  /** Выполнить команду реестра: тот же путь, что у кнопок интерфейса. */
  execute(command: string): void;
  /** Действие, которое умеет только main: буфер обмена, масштаб, окно. */
  runRole(role: MenuRole): void;
}

export function showApplicationMenu(anchor: HTMLElement, deps: AppMenuDeps, onClose?: () => void): void {
  showPopupMenu(toItems(APP_MENU, deps), 0, 0, { anchor, onClose });
}

function toItems(nodes: readonly MenuNode[], deps: AppMenuDeps): PopupMenuItem[] {
  const items: PopupMenuItem[] = [];

  for (const node of nodes) {
    if (node.separator) {
      items.push({ separator: true });
      continue;
    }
    if (node.children) {
      items.push({ label: node.label ?? '', submenu: toItems(node.children, deps) });
      continue;
    }
    if (node.role) {
      const role = node.role;
      items.push({ label: node.label ?? role, hint: node.accelerator, onSelect: () => deps.runRole(role) });
      continue;
    }
    if (node.command) {
      const command = node.command;
      items.push({ label: node.label ?? command, hint: node.accelerator, onSelect: () => deps.execute(command) });
    }
  }

  return items;
}
