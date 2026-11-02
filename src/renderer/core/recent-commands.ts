import type { CommandDescriptor } from './commands';

/** Сколько последних команд помнить. Хватит на привычки, но не на весь реестр (231 команда). */
export const RECENT_COMMANDS_LIMIT = 12;

export interface RecentCommands {
  /** Идентификаторы в порядке свежести: первый — тот, что запускали последним. */
  ids(): readonly string[];
  /** Отметить запуск: команда всплывает в начало, повторы не дублируются. */
  remember(id: string): void;
  /** Забыть команду — например, если её больше нет в реестре. */
  forget(id: string): void;
  /** Заменить всю историю — при загрузке из настроек. */
  restore(ids: readonly string[]): void;
}

/**
 * История запущенных команд для палитры (Ctrl+Shift+P).
 *
 * Палитра отдавала команды в порядке регистрации — алфавит по сути. Человек, живущий в двух
 * командах, искал их каждый раз заново. Здесь только порядок: что показывать решает палитра,
 * а хранилище не знает ни о DOM, ни о настройках.
 *
 * Пустой `id` и повторы отбрасываются: первый заход — самый свежий.
 */
export function createRecentCommands(limit = RECENT_COMMANDS_LIMIT): RecentCommands {
  let list: string[] = [];

  const put = (id: string): void => {
    const trimmed = id.trim();
    if (!trimmed) return;
    list = [trimmed, ...list.filter((item) => item !== trimmed)].slice(0, limit);
  };

  return {
    ids: () => list.slice(),
    remember: put,
    forget(id) {
      list = list.filter((item) => item !== id);
    },
    restore(ids) {
      list = [];
      // С конца: `put` ставит в начало, поэтому последний в исходном списке окажется первым.
      // Проще и честнее — обойти с конца, чтобы порядок сохранился как есть.
      for (const id of [...ids].reverse()) put(id);
    },
  };
}

/**
 * Переставить команды по истории: недавние сверху (в порядке свежести), затем остальные
 * в исходном порядке. Команды из истории, которых нет в реестре, молча пропускаются:
 * реестр — источник правды, история — только подсказка о привычках.
 */
export function orderByRecent(commands: readonly CommandDescriptor[], recent: readonly string[]): CommandDescriptor[] {
  if (recent.length === 0) return [...commands];
  const byId = new Map(commands.map((command) => [command.id, command]));
  const noticed: CommandDescriptor[] = [];
  const used = new Set<string>();
  for (const id of recent) {
    const command = byId.get(id);
    if (!command || used.has(id)) continue;
    used.add(id);
    noticed.push(command);
  }
  for (const command of commands) {
    if (!used.has(command.id)) noticed.push(command);
  }
  return noticed;
}
