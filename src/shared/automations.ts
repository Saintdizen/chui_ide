/**
 * Автоматизации: «сделай это само, когда».
 *
 * Правило из файла настроек: триггер (сохранение файла по маске или раз в N минут)
 * и текст задания. Само оно токены не тратят — запуск стоит прогона, а прогон
 * стоит денег, поэтому автоматизация только кладёт готовый запрос в поле ввода
 * новой беседы. Отправит его человек: Enter — его решение, а не побочный эффект.
 *
 * Здесь только разбор настроек и чистое решение «пора ли»: сами события знает
 * renderer (`core/automations.ts`), и проверить правила без таймеров проще.
 */
import { globToRegExp } from './glob';

export interface AutomationTrigger {
  /** Маска пути (`src/**\/*.ts`); пусто — любое сохранение. */
  save?: string;
  /** Раз в N минут, пока IDE открыта. */
  everyMinutes?: number;
}

export interface AutomationConfig {
  name: string;
  prompt: string;
  on: AutomationTrigger;
  /** Выключенная остаётся в файле: вернуть её проще, чем набирать заново. */
  enabled?: boolean;
}

/** Ближе друг к другу одного и того же правила не запускаем: это защита от цикла. */
export const MIN_AUTOMATION_INTERVAL_MS = 5 * 60_000;
/** Потолок на час: расписание не должно незаметно превращаться в очередь прогонов. */
export const MAX_AUTOMATION_FIRES_PER_HOUR = 4;
export const MIN_AUTOMATION_MINUTES = 5;

export function normalizeAutomations(value: unknown): AutomationConfig[] {
  if (!Array.isArray(value)) return [];
  const result: AutomationConfig[] = [];
  for (const item of value) {
    const entry = item as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object') continue;
    const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : '';
    if (prompt.length === 0) continue;
    const on = (entry.on ?? {}) as Record<string, unknown>;
    const save = typeof on.save === 'string' ? on.save.trim() : '';
    const minutes = Math.round(Number(on.everyMinutes));
    const everyMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.max(minutes, MIN_AUTOMATION_MINUTES) : 0;
    // Триггер без условия — не автоматизация, а «запускай всё время».
    if (save.length === 0 && everyMinutes === 0) continue;
    const name =
      typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : `автоматизация ${result.length + 1}`;
    result.push({
      name,
      prompt,
      on: { ...(save.length > 0 ? { save } : {}), ...(everyMinutes > 0 ? { everyMinutes } : {}) },
    });
  }
  return result;
}

/** Путь подходит под маску правила (`./` и `\` приводятся к одному виду). */
export function automationMatchesPath(pattern: string, path: string): boolean {
  const clean = path.replace(/^\.\//, '').replace(/\\/g, '/');
  return globToRegExp(pattern).test(clean);
}

/** Когда правило срабатывало в последний раз — по имени. */
export type AutomationHistory = ReadonlyMap<string, readonly number[]>;

/**
 * Пора ли запускать: не чаще MIN_AUTOMATION_INTERVAL_MS и не больше
 * MAX_AUTOMATION_FIRES_PER_HOUR. Защита не от человека, а от самого себя:
 * сохранение в цикле или частый таймер иначе превратятся в очередь прогонов.
 */
export function allowFire(history: AutomationHistory, name: string, now: number): boolean {
  const runs = history.get(name) ?? [];
  const last = runs[runs.length - 1];
  if (last !== undefined && now - last < MIN_AUTOMATION_INTERVAL_MS) return false;
  const hour = runs.filter((at) => now - at < 60 * 60_000).length;
  return hour < MAX_AUTOMATION_FIRES_PER_HOUR;
}

/** Правила, которым подходит сохранённый файл. */
export function automationsForSave(
  list: readonly AutomationConfig[],
  path: string,
  history: AutomationHistory,
  now: number,
): AutomationConfig[] {
  return list.filter(
    (item) =>
      item.enabled !== false &&
      item.on.save !== undefined &&
      automationMatchesPath(item.on.save, path) &&
      allowFire(history, item.name, now),
  );
}

/** Правила по часам: срабатывает то, у чего прошло `everyMinutes` с прошлого раза. */
export function automationsForClock(
  list: readonly AutomationConfig[],
  history: AutomationHistory,
  now: number,
): AutomationConfig[] {
  return list.filter((item) => {
    const minutes = item.on.everyMinutes ?? 0;
    if (item.enabled === false || minutes <= 0) return false;
    const runs = history.get(item.name) ?? [];
    const last = runs[runs.length - 1];
    if (last !== undefined && now - last < minutes * 60_000) return false;
    return allowFire(history, item.name, now);
  });
}
