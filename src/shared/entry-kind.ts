/**
 * Как ведёт себя запись дерева: файл это, папка или символическая ссылка.
 *
 * В контракте у записи есть вид (`kind`), и у символической ссылки он свой —
 * `symlink`. Но для работы важно другое: на что ссылка указывает. Ссылка на папку
 * должна раскрываться, ссылка на файл — открываться, а битая — только показываться
 * (и не звать читать то, чего нет). Решение об этом принимается в одном месте, а не
 * россыпью `kind === 'directory'` по дереву: так же поступает и main, когда
 * сортирует записи папки. Модуль чистый — закреплён тестом (`tests/entry-kind.test.ts`).
 */

import type { DirEntry } from './api';

export type { SymlinkInfo, SymlinkTarget } from './api';

/** Ведёт ли запись себя как папка: настоящая папка или рабочая ссылка на папку. */
export function entryIsDirectory(entry: Pick<DirEntry, 'kind' | 'symlink'>): boolean {
  if (entry.kind === 'directory') return true;
  return entry.kind === 'symlink' && entry.symlink?.kind === 'directory' && !entry.symlink.broken;
}

/** Ведёт ли запись себя как файл: обычный файл или рабочая ссылка на файл. */
export function entryIsFile(entry: Pick<DirEntry, 'kind' | 'symlink'>): boolean {
  if (entry.kind === 'file') return true;
  return entry.kind === 'symlink' && entry.symlink?.kind === 'file' && !entry.symlink.broken;
}

/** Символическая ссылка (годная или битая) — для значка в дереве. */
export function entryIsSymlink(entry: Pick<DirEntry, 'kind'>): boolean {
  return entry.kind === 'symlink';
}

/** Подпись ссылки для подсказки. Для прочих записей — `null`. */
export function symlinkLabel(entry: Pick<DirEntry, 'kind' | 'symlink'>): string | null {
  if (entry.kind !== 'symlink') return null;
  const info = entry.symlink;
  if (!info) return 'символическая ссылка';
  if (info.broken) return `битая символическая ссылка → ${info.target}`;
  return `символическая ссылка → ${info.target}`;
}

/**
 * Записи папки: сначала папки (в том числе ссылки на них), потом файлы, внутри —
 * по имени. Так же ведёт себя дерево, и так же сортировал main до ссылок: порядок
 * от вида ссылки не зависит.
 */
export function compareEntries(a: DirEntry, b: DirEntry): number {
  const rank = (entry: DirEntry): number => (entryIsDirectory(entry) ? 0 : 1);
  return rank(a) === rank(b) ? a.name.localeCompare(b.name) : rank(a) - rank(b);
}
