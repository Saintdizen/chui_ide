/**
 * Метки файлов в дереве: цветной ярлык на файле — «в работе», «срочно», «не трогать».
 *
 * Метка — личная пометка человека, а не состояние кода: она не живёт в git и не
 * переживает смену проекта сама по себе. Поэтому метки лежат в сессии проекта рядом
 * с закреплёнными и закладками: у каждого проекта свои.
 *
 * Логика чистая: список записей, поставить, снять, прочитать. Проверяется тестами,
 * а проводнику остаётся нарисовать точку нужного цвета и собрать подменю.
 *
 * У файла не больше ОДНОЙ метки: две цветные точки на строке спорили бы за внимание,
 * а «метка» — это выбор одного ярлыка из набора, как в списке задач.
 */

import { isInsidePath } from './paths';

export type FileLabelId = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';

/** Набор меток и порядок в подменю — от «горячей» к «спокойной». */
export const FILE_LABEL_IDS: readonly FileLabelId[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];

const NAMES: Record<FileLabelId, string> = {
  red: 'Красная',
  orange: 'Оранжевая',
  yellow: 'Жёлтая',
  green: 'Зелёная',
  blue: 'Синяя',
  purple: 'Фиолетовая',
};

export function fileLabelName(id: FileLabelId): string {
  return NAMES[id];
}

export function isFileLabelId(value: unknown): value is FileLabelId {
  return typeof value === 'string' && (FILE_LABEL_IDS as readonly string[]).includes(value);
}

/** Метка файла: путь и цвет. Путь — абсолютный, как и везде в проводнике. */
export interface FileLabelRecord {
  path: string;
  label: FileLabelId;
}

/**
 * Привести записи к годным: чужие пути (из другого проекта), неизвестные цвета и
 * дубли по пути отбрасываем. Для одного пути остаётся последняя метка.
 */
export function sanitizeLabels(records: unknown, root: string | null): FileLabelRecord[] {
  if (!root || !Array.isArray(records)) return [];
  const byPath = new Map<string, FileLabelId>();
  for (const item of records) {
    if (!item || typeof item !== 'object') continue;
    const path = (item as { path?: unknown }).path;
    const label = (item as { label?: unknown }).label;
    if (typeof path !== 'string' || !isFileLabelId(label)) continue;
    if (!isInsidePath(root, path)) continue;
    byPath.set(path, label);
  }
  return [...byPath].map(([path, label]) => ({ path, label }));
}

/** Метка файла или `null`, если её нет. */
export function labelOf(records: readonly FileLabelRecord[], path: string): FileLabelId | null {
  for (const item of records) if (item.path === path) return item.label;
  return null;
}

/**
 * Поставить файлу метку, заменить прежнюю или снять её (`null`). Порядок прочих
 * записей сохраняем: он не важен по смыслу, но стабильность облегчает сравнение.
 */
export function setLabel(
  records: readonly FileLabelRecord[],
  path: string,
  label: FileLabelId | null,
): FileLabelRecord[] {
  const rest = records.filter((item) => item.path !== path);
  return label ? [...rest, { path, label }] : rest;
}

/** Сколько файлов с каждой меткой: подписи-счётчики в подменю и будущий фильтр. */
export function labelCounts(records: readonly FileLabelRecord[]): Record<FileLabelId, number> {
  const counts = Object.fromEntries(FILE_LABEL_IDS.map((id) => [id, 0])) as Record<FileLabelId, number>;
  for (const item of records) counts[item.label] += 1;
  return counts;
}
