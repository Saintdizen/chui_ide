/**
 * Хуки агента: проверка человека поверх правил инструментов.
 *
 * Правила (`shared/tool-policy.ts`) знают про опасные команды вообще, но не знают
 * про этот репозиторий: «`git push` в `release` не пускать», «после правки в `db/`
 * дописать, что миграции лежат рядом» — это знание живёт в проекте, а не в IDE.
 * Поэтому хук — скрипт из проекта: до вызова он решает, пускать ли, после вызова
 * дописывает строку к результату.
 *
 * Две вещи, за которые платят вниманием (см. `TASKS.md`, часть 7):
 * 1. Хук получает решение, а не данные. Ответ — вердикт и причина в одну-две
 *    строки: всё, что хук напишет в `note`, уедет в промпт на каждом шаге.
 * 2. Ошибка хука не запрещает вызов. Упавший или промолчавший скрипт — это «мнения
 *    нет»: запрет по таймауту остановил бы работу из-за опечатки в скрипте, а
 *    `tool-policy.ts` всё равно никуда не делся.
 */

/** Когда зовётся хук: до вызова инструмента или после. */
export type AgentHookEvent = 'before-tool' | 'after-tool';

/** Предел времени по умолчанию: хук стоит между шагами и не должен их держать. */
export const DEFAULT_HOOK_TIMEOUT_MS = 3_000;
/** Больше этого не ждём: хук, которому нужно полминуты, — это не проверка. */
export const MAX_HOOK_TIMEOUT_MS = 30_000;
/** Сколько символов ответа хука вообще доходит до модели. */
export const MAX_HOOK_TEXT_CHARS = 1_000;

export interface AgentHookConfig {
  /** Имя для карточки и для отказа: «Запрещено хуком `no-push`». */
  name: string;
  event: AgentHookEvent;
  /** Имена инструментов; пусто — ко всем. Звёздочка допустима: `edit*`. */
  match?: readonly string[];
  /** Команда оболочки: JSON на stdin, JSON на stdout (см. `agent-hooks.ts` в main). */
  command: string;
  timeoutMs?: number;
  /** Выключенный хук остаётся в настройках, но не зовётся. */
  enabled?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Подходит ли хук этому инструменту: `match` — glob по имени, пусто — все. */
export function hookMatchesTool(hook: AgentHookConfig, tool: string): boolean {
  const patterns = hook.match;
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((pattern) => {
    const text = pattern.trim();
    if (!text) return false;
    if (!text.includes('*')) return text === tool;
    // Одна звёздочка в шаблоне: `edit*`, `terminal*`. Больше — режем на куски нет смысла.
    const [head = '', tail = ''] = text.split('*');
    return tool.startsWith(head) && tool.endsWith(tail);
  });
}

/**
 * Настройки правят руками, поэтому берём только понятное: имя (или `hook-N`),
 * известное событие, непустую команду и разумный предел времени.
 */
export function normalizeAgentHooks(value: unknown): AgentHookConfig[] {
  if (!Array.isArray(value)) return [];

  const hooks: AgentHookConfig[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;

    const event = asString(record.event).trim();
    if (event !== 'before-tool' && event !== 'after-tool') continue;

    const command = asString(record.command).trim();
    if (!command) continue;

    let name = asString(record.name).trim().slice(0, 40) || `hook-${hooks.length + 1}`;
    // Два хука с одним именем неразличимы в отказе — второй получает номер.
    for (let suffix = 2; seen.has(name); suffix += 1) name = `${name.split('~')[0]}~${suffix}`;
    seen.add(name);

    const match = Array.isArray(record.match)
      ? record.match.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').slice(0, 20)
      : [];

    const rawTimeout = Math.round(Number(record.timeoutMs));
    const timeoutMs =
      Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(rawTimeout, MAX_HOOK_TIMEOUT_MS) : undefined;

    hooks.push({
      name,
      event,
      command,
      ...(match.length > 0 ? { match } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(record.enabled === false ? { enabled: false } : {}),
    });
  }

  return hooks;
}
