import { isInsidePath, nameOf, pathAfter } from './paths';

/**
 * Закладки: строки файлов, к которым хочется вернуться. Логика чистая — список
 * записей (файл + строка) и операции над ним; рисует значки редактор, хранит
 * список сессия проекта, а этот модуль знает только «что дальше» и «что изменилось».
 *
 * Порядок записей канонический: по пути файла, затем по строке. Так «следующая
 * закладка» — это просто сосед в списке, а не поиск по карте; вставка одной
 * закладки не переставляет остальные.
 *
 * Закладка — вещь рабочего места, а не проекта: она привязана к путям этой машины,
 * поэтому живёт в сессии (`userData`), а не в репозитории.
 */

/** Одна закладка: файл и строка в нём (1-based). */
export interface BookmarkRecord {
  path: string;
  line: number;
}

/** Потолок закладок проекта: больше в списке всё равно не найти. */
export const MAX_BOOKMARKS = 500;

/** Предел длины пути: как у прочих записей сессии. */
const MAX_PATH_CHARS = 4096;

/** Привести записи из сессии к безопасному виду: целые строки и непустые пути, без повторов. */
export function sanitizeBookmarks(raw: unknown): BookmarkRecord[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: BookmarkRecord[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const value = item as Record<string, unknown>;
    if (typeof value.path !== 'string' || value.path === '') continue;
    if (!Number.isInteger(value.line) || (value.line as number) < 1) continue;
    const path = value.path.slice(0, MAX_PATH_CHARS);
    const line = value.line as number;
    const key = `${path}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ path, line });
    if (result.length >= MAX_BOOKMARKS) break;
  }
  return sortBookmarks(result);
}

/** Канонический порядок: по пути файла, затем по строке. */
export function sortBookmarks(records: readonly BookmarkRecord[]): BookmarkRecord[] {
  return [...records].sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
}

/** Строки закладок файла по возрастанию — их берёт редактор для значков. */
export function bookmarkLines(records: readonly BookmarkRecord[], path: string): number[] {
  const lines = records.filter((record) => record.path === path).map((record) => record.line);
  return lines.sort((a, b) => a - b);
}

/** Файлы, в которых есть закладки, — в порядке появления. */
export function bookmarkFiles(records: readonly BookmarkRecord[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const record of sortBookmarks(records)) {
    if (seen.has(record.path)) continue;
    seen.add(record.path);
    files.push(record.path);
  }
  return files;
}

export function isBookmarked(records: readonly BookmarkRecord[], path: string, line: number): boolean {
  return records.some((record) => record.path === path && record.line === line);
}

/** Поставить закладку, если её нет, и снять, если есть. Возвращает новое состояние. */
export function toggleBookmark(records: readonly BookmarkRecord[], path: string, line: number): BookmarkRecord[] {
  if (isBookmarked(records, path, line)) return removeBookmark(records, path, line);
  if (records.length >= MAX_BOOKMARKS) return [...records];
  return sortBookmarks([...records, { path, line }]);
}

/** Снять закладку со строки. Строки нет в списке — список не меняется. */
export function removeBookmark(records: readonly BookmarkRecord[], path: string, line: number): BookmarkRecord[] {
  return records.filter((record) => !(record.path === path && record.line === line));
}

/** Убрать все закладки файла. */
export function clearBookmarksIn(records: readonly BookmarkRecord[], path: string): BookmarkRecord[] {
  return records.filter((record) => record.path !== path);
}

/**
 * Следующая (`direction` = 1) или предыдущая (-1) закладка от позиции `from`.
 *
 * Список замкнут: за последней идёт первая. Так «следующая» не заводит в тупик,
 * когда закладка только одна, — она возвращает на себя же, и жест не «немеет».
 * `null` — закладок нет вовсе (позиция `from` при этом может быть любой).
 */
export function nextBookmark(
  records: readonly BookmarkRecord[],
  from: BookmarkRecord,
  direction: 1 | -1,
): BookmarkRecord | null {
  if (records.length === 0) return null;
  const ordered = sortBookmarks(records);
  const index = ordered.findIndex((record) => record.path === from.path && record.line === from.line);
  if (index < 0) {
    // Позиции нет среди закладок: берём ближайшую в нужную сторону, иначе — с края.
    if (direction === 1) return ordered.find((record) => after(record, from)) ?? ordered[0]!;
    const before = ordered.filter((record) => after(from, record));
    return before.length > 0 ? before[before.length - 1]! : ordered[ordered.length - 1]!;
  }
  const step = (index + direction + ordered.length) % ordered.length;
  return ordered[step]!;
}

/** Позиция `a` строго после `b` в каноническом порядке. */
function after(a: BookmarkRecord, b: BookmarkRecord): boolean {
  if (a.path !== b.path) return a.path > b.path;
  return a.line > b.line;
}

export function countBookmarks(records: readonly BookmarkRecord[]): number {
  return records.length;
}

/** Путь закладки для показа: от корня проекта, если он внутри, иначе как есть. */
export function bookmarkPath(record: BookmarkRecord, root: string | null): string {
  if (!root || !isInsidePath(root, record.path)) return record.path;
  return pathAfter(root, record.path) || nameOf(record.path);
}

/** Строка списка: путь от корня и номер строки через двоеточие. */
export function bookmarkLabel(record: BookmarkRecord, root: string | null): string {
  return `${bookmarkPath(record, root)}:${record.line}`;
}
