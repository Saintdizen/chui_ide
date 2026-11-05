import type { CommandDescriptor } from './commands';

/**
 * Подсказки с сочетанием клавиш и путём в настройки клавиш (TASKS п.1).
 *
 * Источник (Zed `development-ui-checklist`: «Are shortcuts discoverable
 * (tooltips, menus, docs)?», JetBrains `action-system`): сочетание должно быть
 * видно там же, где живёт действие, а не только в списке настроек.
 *
 * ПОРЯДОК КТО КОМУ УСТУПАЕТ — не догадка, а замер (проба `npm run probe:shortcuts`,
 * шаг 4: шлёт настоящие нажатия в живое окно):
 *
 *   Ctrl+P     → сработал ТОЛЬКО `file.quickOpen` (сочетание renderer),
 *   Ctrl+Alt+E → сработал ТОЛЬКО `view.toggleEditor` (то же самое).
 *
 * В обоих случаях команда есть и в меню с тем же accelerator, так что Electron
 * нажатие окну УСТУПАЕТ — выигрывает запись renderer. Поэтому renderer первым;
 * меню — запасной источник для команд, которые живут только в меню
 * (`role`-пункты вроде «Свернуть окно»: их в реестре команд нет).
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
  // Renderer первым — замерено, а не выведено: окно обгоняет меню (см. шапку).
  // Показывать accelerator меню при живом своём сочетании значило бы назвать
  // клавишу, которая не сработает, если её поменяли в настройках.
  const own = source.rendererBindings.get(commandId);
  if (own) return { combo: own, from: 'renderer' };
  const menu = source.menuAccelerators.get(commandId);
  if (menu) return { combo: menu, from: 'menu' };
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
