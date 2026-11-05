import type { CommandDescriptor } from './commands';

/**
 * Подсказки с сочетанием клавиш и путём в настройки клавиш (TASKS п.1).
 *
 * Источник (Zed `development-ui-checklist`: «Are shortcuts discoverable
 * (tooltips, menus, docs)?», JetBrains `action-system`): сочетание должно быть
 * видно там же, где живёт действие, а не только в списке настроек.
 *
 * ГЛАВНАЯ ГРАБЛЯ ЗДЕСЬ ОДНА: сочетание у действия имеет два источника.
 * Своё клавиши держит renderer (`core/default-keybindings.ts`), клавиши пунктов
 * меню — Electron (`accelerator` в `shared/app-menu.ts`). Возьми любой из них
 * молча — и подсказка соврёт: либо «нет сочетания» у меню, либо чужое
 * сочетание у перехваченной команды (меню в Electron срабатывает РАНЬШЕ, и
 * renderer своё не получит). Поэтому источники сводятся здесь явно, с
 * приоритетом: что видит Electron, то и напечатано.
 */
export interface ShortcutSource {
  /** Сочетания, которые держит renderer: команда → комбинация. */
  rendererBindings: ReadonlyMap<string, string>;
  /** Сочетания пунктов меню: команда → accelerator. */
  menuAccelerators: ReadonlyMap<string, string>;
}

/**
 * Сочетание для команды и то, чей оно.
 *
 * `null` — сочетания нет ни там, ни там. Это не ошибка: у большинства команд
 * его и не должно быть.
 */
export function shortcutFor(
  commandId: string,
  source: ShortcutSource,
): { combo: string; from: 'menu' | 'renderer' } | null {
  // Меню первым: Electron перехватывает раньше renderer — если показать
  // сочетание из renderer, когда то же действие есть в меню, человек увидит
  // одно, а сработает другое.
  const menu = source.menuAccelerators.get(commandId);
  if (menu) return { combo: menu, from: 'menu' };
  const own = source.rendererBindings.get(commandId);
  if (own) return { combo: own, from: 'renderer' };
  return null;
}

/**
 * Текст подсказки для кнопки, которая делает то же, что команда.
 *
 * К названию добавляется сочетание: без него действие есть только мышью,
 * хотя клавиши у него уже назначены.
 */
export function tooltipFor(label: string, commandId: string, source: ShortcutSource): string {
  const shortcut = shortcutFor(commandId, source);
  return shortcut ? `${label} (${shortcut.combo})` : label;
}

/**
 * Построить источники сочетаний из того, что уже есть в программе.
 *
 * Ничего не выдумывает: берёт объявленные сочетания реестра команд и
 * акселераторы меню. Команда, у которой есть `keybinding`, но нет пункта в меню,
 * попадает в renderer-источник; пункт меню без объявленного сочетания в реестре
 * всё равно попадает в menu-источник — сочетание у него есть и тогда, когда
 * реестр о нём не знает.
 */
export function shortcutSources(
  commands: readonly CommandDescriptor[],
  menuAccelerators: ReadonlyMap<string, string>,
): ShortcutSource {
  const rendererBindings = new Map<string, string>();
  for (const command of commands) {
    if (command.keybinding) rendererBindings.set(command.id, command.keybinding);
  }
  return { rendererBindings, menuAccelerators };
}
