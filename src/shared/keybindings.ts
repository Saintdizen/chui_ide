/**
 * Горячие клавиши: что можно изменить и как это хранится.
 *
 * Сочетания по умолчанию заданы в коде (`renderer/core/default-keybindings.ts`) — там
 * их видит и служба перехвата, и редактор сочетаний в настройках. Человек может
 * переопределить любое: переопределения лежат в настройках рядом с прочими и
 * накладываются на сочетания по умолчанию. Правит файл и форма, поэтому значение
 * проверяется (`normalizeKeybindingOverrides`).
 *
 * Сочетаний два сорта, и живут они в разных процессах:
 *
 *   • у пунктов меню клавишу держит Electron (`shared/app-menu.ts`), и нажатие
 *     обрабатывает main — пункт шлёт команду push-событием;
 *   • остальные (то, чего в меню нет) перехватывает сам renderer
 *     (`KeybindingService`) по `default-keybindings.ts`.
 *
 * Одна и та же команда бывает с клавишей И в меню, И в renderer (терминал: `Alt+F12`
 * из меню и ``Ctrl+` `` — привычка из VS Code). Поэтому переопределение адресуется
 * не только командой, но и родом клавиши: у меню впереди стоит `menu:`
 * (`menu:file.save`). Так правка клавиши меню не сбивает свою клавишу renderer у той
 * же команды, и наоборот.
 */

/** Переопределение сочетания для одной команды. */
export interface KeybindingOverride {
  /** Команда (идентификатор из реестра) либо `menu:<команда>` для акселератора меню. */
  command: string;
  /** Сочетание, например `Ctrl+Shift+K`. Пустая строка — сочетание снято. */
  combo: string;
}

/** Настройки сочетаний: только то, что человек изменил сам. */
export interface KeybindingSettings {
  overrides: KeybindingOverride[];
}

/** Команда и сочетание — обе строки, непустая только команда. */
function isOverride(value: unknown): value is KeybindingOverride {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as { command?: unknown; combo?: unknown };
  return typeof item.command === 'string' && item.command.length > 0 && typeof item.combo === 'string';
}

/**
 * Привести список переопределений из настроек к известному виду: только объекты с
 * командой и строкой сочетания, по одному на команду (последнее выигрывает).
 */
/** Приставка к команде, которой адресуется клавиша пункта меню. */
export const MENU_BINDING_PREFIX = 'menu:';

/** Ключ переопределения для акселератора меню команды. */
export function menuBindingId(command: string): string {
  return `${MENU_BINDING_PREFIX}${command}`;
}

/** Это переопределение клавиши меню (а не сочетания самого renderer). */
export function isMenuBinding(id: string): boolean {
  return id.startsWith(MENU_BINDING_PREFIX);
}

/** Команда из ключа переопределения меню. Для прочих ключей возвращает их сами. */
export function menuCommandOf(id: string): string {
  return isMenuBinding(id) ? id.slice(MENU_BINDING_PREFIX.length) : id;
}

/**
 * Переопределения клавиш МЕНЮ: карта `команда → сочетание`. Их читает main при
 * сборке меню. Ключи без приставки пропускаем — они принадлежат renderer.
 */
export function menuComboOverrides(overrides: readonly KeybindingOverride[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of overrides) {
    // Пустое сочетание у клавиши меню значит «снять»: Electron поймёт пустой `accelerator`.
    if (isMenuBinding(item.command)) map.set(menuCommandOf(item.command), item.combo);
  }
  return map;
}

/** Переопределения сочетаний renderer: клавиши меню из общего списка выпадают. */
export function rendererOverrides(overrides: readonly KeybindingOverride[]): KeybindingOverride[] {
  return overrides.filter((item) => !isMenuBinding(item.command));
}

/** Сочетание и команда — то, из чего ищутся столкновения. */
export interface BindingLike {
  readonly combo: string;
  readonly command: string;
}

/** Одно сочетание, занятое несколькими командами. */
export interface BindingConflict {
  readonly combo: string;
  readonly commands: string[];
}

/**
 * Сочетания, которые делят несколько команд. Одно сочетание у двух команд — почти
 * всегда описка: сработает первое, остальным достанется не то. Пустые сочетания
 * (снятые) не считаем. Порядок — по первому появлению сочетания, устойчивый.
 */
export function bindingConflicts(bindings: readonly BindingLike[]): BindingConflict[] {
  const used = new Map<string, string[]>();
  for (const binding of bindings) {
    if (!binding.combo) continue;
    const commands = used.get(binding.combo);
    if (commands) commands.push(binding.command);
    else used.set(binding.combo, [binding.command]);
  }
  const conflicts: BindingConflict[] = [];
  for (const [combo, commands] of used) {
    if (commands.length > 1) conflicts.push({ combo, commands: [...commands] });
  }
  return conflicts;
}

export function normalizeKeybindingOverrides(value: unknown): KeybindingOverride[] {
  if (!Array.isArray(value)) return [];
  const byCommand = new Map<string, string>();
  for (const item of value) {
    if (isOverride(item)) byCommand.set(item.command, item.combo.trim());
  }
  return [...byCommand.entries()].map(([command, combo]) => ({ command, combo }));
}
