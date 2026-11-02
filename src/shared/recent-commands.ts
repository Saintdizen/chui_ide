/**
 * Палитра команд: то, что человек менял сам.
 *
 * Здесь же живёт разбор: файл настроек правят руками, а палитре нужен список известного
 * вида — строки id без повторов. Чужой id ничего не показывает, поэтому такой просто
 * остаётся в списке до первого `remember` с лимитом: фильтровать по реестру команд
 * здесь нельзя — у main нет самих команд.
 */

/** Сколько недавних команд помним. Больше — уже не «недавнее», а алфавит. */
export const RECENT_COMMANDS_LIMIT = 30;

export interface CommandPaletteSettings {
  /** Id выполненных команд, свежие сверху. */
  recent: string[];
}

/**
 * Недавние команды из файла настроек: только непустые строки, без повторов, не больше
 * лимита. Не массив — пустой список: мусор в файле не должен ломать палитру.
 */
export function normalizeRecentCommands(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) continue;
    if (out.includes(item)) continue;
    out.push(item);
    if (out.length >= RECENT_COMMANDS_LIMIT) break;
  }
  return out;
}
