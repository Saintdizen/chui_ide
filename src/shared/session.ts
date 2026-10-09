import type { BreakpointRecord, DebugExceptionFilters, DebugLaunchOptions, SessionState } from './api';

/**
 * Проверка и границы сессии — в `shared`, а не в main: это чистая логика без
 * файлов и Electron, поэтому её покрывают юнит-тесты. main лишь добавляет
 * чтение и запись.
 */

/** Границы разумного: битый или огромный файл сессии не должен вредить запуску. */
export const MAX_TABS = 40;
export const MAX_EXPANDED = 400;
export const MAX_ARGS = 100;
export const MAX_WATCH = 50;
export const MAX_BREAKPOINTS = 500;
const MAX_ENV_ENTRIES = 100;
/** Настройки точки — короткие строки; общий предел пути здесь избыточен, но безопасен. */
const MAX_SETTING_CHARS = 4096;
/** Общий предел длины строки: хватает и пути, и одному аргументу. */
const MAX_PATH_CHARS = 4096;
const MAX_ENV_VALUE_CHARS = 8192;

/** Пустое рабочее место: используется, когда файла сессии ещё нет. */
export const EMPTY_SESSION: SessionState = {
  tabs: [],
  expanded: [],
};

/**
 * Новый пустой объект каждый раз: `{ ...EMPTY_SESSION }` копирует лишь ссылки
 * на массивы, и правка одного «пустого» состояния портила бы общий образец.
 */
export function emptySession(): SessionState {
  return { ...EMPTY_SESSION, tabs: [], expanded: [] };
}

/**
 * Приводит прочитанную сессию к безопасному виду: файл мог быть правлен руками
 * или достаться от старой версии. Активная вкладка оставляется, только если она
 * есть среди открытых, — иначе она бессмысленна.
 */
export function sanitizeSession(raw: unknown): SessionState {
  if (typeof raw !== 'object' || raw === null) return emptySession();
  const value = raw as Record<string, unknown>;

  const tabs = stringList(value.tabs, MAX_TABS);
  const expanded = stringList(value.expanded, MAX_EXPANDED);
  // Видимость панелей в сессию не входит: это часть общего макета (userData),
  // одного на все проекты, а не рабочего места конкретной папки.
  const state: SessionState = {
    tabs,
    expanded,
  };

  if (typeof value.activeTab === 'string' && tabs.includes(value.activeTab)) {
    state.activeTab = value.activeTab;
  }
  if (typeof value.dockActive === 'string' && value.dockActive) {
    state.dockActive = value.dockActive.slice(0, MAX_PATH_CHARS);
  }

  const launch = launchOptions(value.debugLaunch);
  if (launch) state.debugLaunch = launch;
  const watch = stringList(value.debugWatch, MAX_WATCH);
  if (watch.length > 0) state.debugWatch = watch;
  const exceptions = exceptionFilters(value.debugExceptions);
  if (exceptions) state.debugExceptions = exceptions;
  const breakpoints = breakpointRecords(value.breakpoints);
  if (breakpoints.length > 0) state.breakpoints = breakpoints;

  return state;
}

/**
 * Точки останова из сессии: только с целой положительной строкой и строковым
 * путём. Настройки-строки обрезаем по краям (как и при постановке): пустые
 * означают «настройки нет», поэтому поля не появляются.
 */
function breakpointRecords(raw: unknown): BreakpointRecord[] {
  if (!Array.isArray(raw)) return [];
  const result: BreakpointRecord[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const value = item as Record<string, unknown>;
    if (typeof value.path !== 'string' || !value.path) continue;
    if (!Number.isInteger(value.line) || (value.line as number) < 1) continue;

    const record: BreakpointRecord = { path: value.path.slice(0, MAX_PATH_CHARS), line: value.line as number };
    for (const key of ['condition', 'hitCondition'] as const) {
      const text = value[key];
      if (typeof text === 'string' && text.trim()) record[key] = text.trim().slice(0, MAX_SETTING_CHARS);
    }
    // Сообщение журнала не обрезаем по краям: пробелы в нём — часть формата.
    const log = value.logMessage;
    if (typeof log === 'string' && log.length > 0) record.logMessage = log.slice(0, MAX_SETTING_CHARS);

    result.push(record);
    if (result.length >= MAX_BREAKPOINTS) break;
  }
  return result;
}

/**
 * Параметры запуска отладки из сессии. Пустой набор возвращаем как `undefined`:
 * так в файле не копятся `{args: []}` и `{env: {}}` — они значат «настройки нет».
 */
function launchOptions(raw: unknown): DebugLaunchOptions | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const options: DebugLaunchOptions = {};

  const args = stringList(value.args, MAX_ARGS);
  if (args.length > 0) options.args = args;
  const env = stringMap(value.env, MAX_ENV_ENTRIES);
  if (Object.keys(env).length > 0) options.env = env;
  if (typeof value.cwd === 'string' && value.cwd) options.cwd = value.cwd.slice(0, MAX_PATH_CHARS);

  return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * Останов по исключению из сессии. Возвращаем `undefined`, если оба фильтра
 * выключены: так в файле не оседает `{uncaught:false,caught:false}` — это значит
 * «настройки нет», и адаптер не трогают раньше времени.
 */
function exceptionFilters(raw: unknown): DebugExceptionFilters | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const uncaught = value.uncaught === true;
  const caught = value.caught === true;
  return uncaught || caught ? { uncaught, caught } : undefined;
}

/** Именованные строки (переменные окружения): ключ и значение — строки. */
function stringMap(raw: unknown, limit: number): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || typeof value !== 'string') continue;
    result[key.slice(0, MAX_PATH_CHARS)] = value.slice(0, MAX_ENV_VALUE_CHARS);
    if (Object.keys(result).length >= limit) break;
  }
  return result;
}

function stringList(raw: unknown, limit: number): string[] {
  if (!Array.isArray(raw)) return [];
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item) continue;
    result.push(item.length > MAX_PATH_CHARS ? item.slice(0, MAX_PATH_CHARS) : item);
    if (result.length >= limit) break;
  }
  return result;
}
