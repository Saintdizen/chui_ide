/**
 * Горячие клавиши: что можно изменить и как это хранится.
 *
 * Сочетания по умолчанию заданы в коде (`renderer/core/default-keybindings.ts`) — там
 * их видит и служба перехвата, и редактор сочетаний в настройках. Человек может
 * переопределить любое: переопределения лежат в настройках рядом с прочими и
 * накладываются на сочетания по умолчанию. Правит файл и форма, поэтому значение
 * проверяется (`normalizeKeybindingOverrides`).
 */

/** Переопределение сочетания для одной команды. */
export interface KeybindingOverride {
  /** Команда (идентификатор из реестра). */
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
export function normalizeKeybindingOverrides(value: unknown): KeybindingOverride[] {
  if (!Array.isArray(value)) return [];
  const byCommand = new Map<string, string>();
  for (const item of value) {
    if (isOverride(item)) byCommand.set(item.command, item.combo.trim());
  }
  return [...byCommand.entries()].map(([command, combo]) => ({ command, combo }));
}
