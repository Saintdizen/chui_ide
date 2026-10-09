import type { SessionState } from './api';

/**
 * Проверка и границы сессии — в `shared`, а не в main: это чистая логика без
 * файлов и Electron, поэтому её покрывают юнит-тесты. main лишь добавляет
 * чтение и запись.
 */

/** Границы разумного: битый или огромный файл сессии не должен вредить запуску. */
export const MAX_TABS = 40;
export const MAX_EXPANDED = 400;
const MAX_PATH_CHARS = 4096;

/** Пустое рабочее место: используется, когда файла сессии ещё нет. */
export const EMPTY_SESSION: SessionState = {
  tabs: [],
  expanded: [],
  dockVisible: false,
  sidebarVisible: true,
  rightVisible: true,
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
  const state: SessionState = {
    tabs,
    expanded,
    dockVisible: value.dockVisible === true,
    sidebarVisible: value.sidebarVisible !== false,
    rightVisible: value.rightVisible !== false,
  };

  if (typeof value.activeTab === 'string' && tabs.includes(value.activeTab)) {
    state.activeTab = value.activeTab;
  }
  if (typeof value.dockActive === 'string' && value.dockActive) {
    state.dockActive = value.dockActive.slice(0, MAX_PATH_CHARS);
  }

  return state;
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
