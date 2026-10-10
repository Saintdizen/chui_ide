/**
 * Конфигурация уровня проекта, которая живёт в самом проекте — в папке
 * `.chui_ide/` рядом с кодом. Пользовательские настройки (модель ИИ,
 * оформление) и макет рабочей области остаются в userData: они общие для всех
 * проектов. Здесь же — только то, что имеет смысл привязать к конкретной папке.
 *
 * Файл: `.chui_ide/settings.json` (секции настроек). Формат терпимый: незнакомые
 * ключи молча игнорируются, битый JSON не роняет загрузку — берём пустые настройки.
 */
import type { Settings } from './api';

/** Секции настроек, которые разрешено переопределять на уровне проекта. */
export type ProjectSettings = Partial<Pick<Settings, 'editor' | 'explorer' | 'run' | 'lsp'>>;

export const PROJECT_SETTINGS_SECTIONS = ['editor', 'explorer', 'run', 'lsp'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Рекурсивно накладывает `patch` на `base`, не мутируя ни один из них. */
export function mergeDeep<T>(base: T | undefined, patch: T | undefined): T | undefined {
  if (patch === undefined) return base;
  if (base === undefined || !isPlainObject(base) || !isPlainObject(patch)) return patch;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isPlainObject(value) && isPlainObject(result[key]) ? mergeDeep(result[key], value) : value;
  }
  return result as T;
}

/** Оставляем только известные секции-объекты; остальное игнорируем молча. */
export function sanitizeProjectSettings(raw: unknown): ProjectSettings {
  if (!isPlainObject(raw)) return {};
  const out: ProjectSettings = {};
  for (const section of PROJECT_SETTINGS_SECTIONS) {
    const value = raw[section];
    if (isPlainObject(value)) out[section] = value as never;
  }
  return out;
}

/** Дополняет проектные настройки патчем: послойно, по секциям и внутри них. */
export function applyProjectSettingsPatch(current: ProjectSettings, patch: ProjectSettings): ProjectSettings {
  const out: ProjectSettings = { ...current };
  for (const section of PROJECT_SETTINGS_SECTIONS) {
    const value = patch[section];
    if (value !== undefined) out[section] = mergeDeep(current[section], value) as never;
  }
  return out;
}
