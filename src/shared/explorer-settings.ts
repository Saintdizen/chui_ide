/**
 * Настройки вида дерева НА КАЖДУЮ папку рабочей области.
 *
 * Зачем: в многообласти корни живут разной жизнью. В одном репозитории скрытые
 * файлы нужны (там `.env`, `.eslintrc`), в другом они только мешают; в чужой
 * библиотеке хочется выключить пометки git, чтобы дерево читалось как справочник.
 * Общий набор настроек заставляет выбирать что-то одно на всю область, а держать
 * вторую копию проекта в другом окне — не выход.
 *
 * Как устроено: у общей настройки `explorer` есть карта `byRoot`:
 * «путь корня → отличия от общей настройки». Отличия описывают ВИД и фильтрацию
 * дерева: сортировку, скрытое, значки, пометки git, исключения. Поведение, которое
 * меняет файлы (править импорты при переименовании), и вещи, общие для IDE, сюда
 * не входят: это свойство работы, а не папки.
 *
 * Модуль чистый: ни ФС, ни DOM. Наследование и слияние проверяются тестами, а
 * интерфейс лишь показывает и правит готовую карту.
 */

import type { ExplorerSettings, ExplorerRootOverride, ExplorerRootOverrides } from './api';

/**
 * Булевы ключи, которые можно переопределить: по ним строится форма «Настройки
 * папки» и разбор подсказки. Список закрытый и живёт в одном месте.
 */
export const ROOT_OVERRIDE_FLAGS = [
  'showHidden',
  'foldersFirst',
  'icons',
  'gitDecorations',
  'folderChangeDot',
  'recentChanges',
  'dimIgnored',
  'openOnSingleClick',
  'confirmDelete',
  'fileNesting',
  'groupByType',
  'groupByPackage',
] as const satisfies readonly (keyof ExplorerRootOverride)[];

export type RootOverrideFlag = (typeof ROOT_OVERRIDE_FLAGS)[number];

/** Отличия этого корня (пустой объект, если своих настроек нет). */
export function rootOverrideOf(
  overrides: ExplorerRootOverrides | undefined,
  root: string | null,
): ExplorerRootOverride {
  if (!overrides || !root) return {};
  return overrides[root] ?? {};
}

/** Есть ли у корня свои настройки (для значка в дереве и пункта «Сбросить»). */
export function hasRootOverride(overrides: ExplorerRootOverrides | undefined, root: string | null): boolean {
  return Object.keys(rootOverrideOf(overrides, root)).length > 0;
}

/**
 * Настройки дерева для активного корня: общий набор плюс отличия этого корня.
 * Ключ `byRoot` в результат не попадает — он про все корни сразу.
 */
export function resolveExplorerSettings(base: ExplorerSettings, root: string | null): ExplorerSettings {
  const override = rootOverrideOf(base.byRoot, root);
  const resolved: ExplorerSettings = { ...base, byRoot: base.byRoot };
  for (const [key, value] of Object.entries(override) as [keyof ExplorerRootOverride, unknown][]) {
    if (value === undefined) continue;
    // Копии списков: правка настроек не должна менять уже отданный снимок.
    (resolved as unknown as Record<string, unknown>)[key] = Array.isArray(value) ? [...value] : value;
  }
  return resolved;
}

/**
 * Записать отличия корня. Пустая правка (все ключи `undefined`) УДАЛЯЕТ запись:
 * корень без своих настроек наследует общие, и держать в файле пустой объект
 * незачем — по нему не отличить «настроил и снял» от «никогда не настраивал».
 */
export function setRootOverride(
  overrides: ExplorerRootOverrides | undefined,
  root: string,
  patch: ExplorerRootOverride,
): ExplorerRootOverrides {
  const next: ExplorerRootOverrides = { ...(overrides ?? {}) };
  const merged: ExplorerRootOverride = { ...(next[root] ?? {}), ...patch };
  const cleaned: ExplorerRootOverride = {};
  for (const [key, value] of Object.entries(merged) as [keyof ExplorerRootOverride, unknown][]) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    (cleaned as Record<string, unknown>)[key] = value;
  }
  if (Object.keys(cleaned).length === 0) delete next[root];
  else next[root] = cleaned;
  return next;
}

/** Снять настройки корня: он снова живёт по общим. */
export function clearRootOverride(overrides: ExplorerRootOverrides | undefined, root: string): ExplorerRootOverrides {
  const next: ExplorerRootOverrides = { ...(overrides ?? {}) };
  delete next[root];
  return next;
}

/** Известен ли такой ключ переопределения. */
export function isOverrideKey(key: string): key is keyof ExplorerRootOverride {
  return (
    key === 'sort' ||
    key === 'indent' ||
    key === 'rowDensity' ||
    key === 'exclude' ||
    key === 'nestingRules' ||
    (ROOT_OVERRIDE_FLAGS as readonly string[]).includes(key)
  );
}

/**
 * Разбор карты из настроек: файл правят и руками, поэтому берём только известные
 * ключи и известные типы. Значение глубже не проверяем (какие бывают сортировки):
 * его подставляет `resolveExplorerSettings` как есть, а дерево по общим настройкам
 * имеет свою проверку.
 */
export function normalizeRootOverrides(raw: unknown): ExplorerRootOverrides {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const result: ExplorerRootOverrides = {};
  for (const [root, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof root !== 'string' || root.trim() === '') continue;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const source = value as Record<string, unknown>;
    const override: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      if (!isOverrideKey(key) || entry === undefined) continue;
      if (Array.isArray(entry)) override[key] = entry.filter((item): item is string => typeof item === 'string');
      else if (typeof entry === 'boolean') override[key] = entry;
      else if (typeof entry === 'string') override[key] = entry;
      else if (typeof entry === 'number' && Number.isFinite(entry)) override[key] = entry;
    }
    if (Object.keys(override).length > 0) result[root] = override as ExplorerRootOverride;
  }
  return result;
}

/** Подпись отличий — для подсказки и списка настроенных корней. */
export function describeOverride(override: ExplorerRootOverride): string {
  const parts: string[] = [];
  for (const flag of ROOT_OVERRIDE_FLAGS) {
    const value = override[flag];
    if (value === undefined) continue;
    parts.push(`${OVERRIDE_LABELS[flag]}: ${value ? 'вкл' : 'выкл'}`);
  }
  if (override.exclude && override.exclude.length > 0) parts.push(`исключений: ${override.exclude.length}`);
  if (override.nestingRules && override.nestingRules.length > 0)
    parts.push(`правил вложения: ${override.nestingRules.length}`);
  if (override.sort) parts.push(`сортировка: ${override.sort}`);
  if (override.rowDensity) parts.push(`плотность строк: ${override.rowDensity}`);
  if (override.indent !== undefined) parts.push(`отступ: ${override.indent}`);
  return parts.join(', ');
}

/** Подписи булевых ключей — те же слова, что в форме настроек. */
export const OVERRIDE_LABELS: Record<RootOverrideFlag, string> = {
  showHidden: 'Показывать скрытые',
  foldersFirst: 'Папки выше файлов',
  icons: 'Значки по типу файла',
  gitDecorations: 'Пометки git',
  folderChangeDot: 'Точка у папки с правками',
  recentChanges: 'Подсвечивать недавние',
  dimIgnored: 'Приглушать игнорируемые',
  openOnSingleClick: 'Открывать одним кликом',
  confirmDelete: 'Спрашивать перед удалением',
  fileNesting: 'Сворачивать связанные файлы',
  groupByType: 'Группировать по назначению',
  groupByPackage: 'Пакеты монорепо строками',
};
