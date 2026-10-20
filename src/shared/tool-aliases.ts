/** Старые имена инструментов: вызов по ним не должен упираться в тупик.
 *
 * Схемы сливаются, имена исчезают, а вызовы остаются — в сохранённых беседах, в
 * истории прогонов. Модель, продолжая такую беседу, копирует прошлый вызов
 * (`read_file`, `spawn_agent`) и получает «Инструмент недоступен»: тупик за целый
 * шаг, хотя инструмент есть — он просто называется иначе.
 */
export interface CanonicalCall {
  /** Имя, под которым инструмент живёт сейчас. */
  name: string;
  /** Аргументы: у агентов к ним дописано действие. */
  arguments: string;
  /** Имя отличалось от нынешнего. */
  renamed: boolean;
}

/** Старое имя → нынешнее. Совпадение точное. */
const NAME_ALIASES: Readonly<Record<string, string>> = {
  // Чтение и просмотр: пары слиты по кратности, аргументы у них те же.
  read_file: 'read',
  read_files: 'read',
  list_dir: 'list',
  find_files: 'list',
  // Живые агенты: пять имён стали одним инструментом с `action`.
  spawn_agent: 'agents',
  list_agents: 'agents',
  wait_agent: 'agents',
  send_message: 'agents',
  interrupt_agent: 'agents',
};

/** Старое имя → действие, которое оно означало. */
const ACTION_ALIASES: Readonly<Record<string, string>> = {
  spawn_agent: 'spawn',
  list_agents: 'list',
  wait_agent: 'wait',
  send_message: 'send',
  interrupt_agent: 'interrupt',
};

/** Незнакомое имя возвращается как есть: чужие (MCP) не наше дело. */
export function canonicalCall(name: string, rawArguments: string): CanonicalCall {
  const target = NAME_ALIASES[name];
  if (!target) return { name, arguments: rawArguments, renamed: false };

  const action = ACTION_ALIASES[name];
  if (!action) return { name: target, arguments: rawArguments, renamed: true };

  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawArguments.trim() || '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { name: target, arguments: rawArguments, renamed: true };
    }
    value = parsed as Record<string, unknown>;
  } catch {
    return { name: target, arguments: rawArguments, renamed: true };
  }

  if (typeof value.action === 'string' && value.action.trim() !== '') {
    return { name: target, arguments: rawArguments, renamed: true };
  }
  return { name: target, arguments: JSON.stringify({ ...value, action }), renamed: true };
}
