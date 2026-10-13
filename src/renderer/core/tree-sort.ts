/**
 * Порядок строк в дереве: по имени, по типу файла, по времени правки и по
 * пометкам git.
 *
 * Логика чистая: она получает список записей и настройки, а отдаёт новый порядок.
 * Так её можно проверить тестами — в дереве сортировка иначе не проверяется, а
 * ошибка в ней видна только глазом.
 *
 * Папки выше файлов (когда так настроено) — первым ключом во всех режимах: это
 * привычка, а не сортировка; остальные ключи решают, как упорядочить внутри групп.
 */

import type { DirEntry, GitChange, TreeSort } from '../../shared/api';

export interface SortOptions {
  /** Папки выше файлов. */
  foldersFirst: boolean;
  sort: TreeSort;
  /** Пометка git файла; `undefined` — правок нет. Нужна только для сортировки `git`. */
  changeOf?: (path: string) => GitChange | undefined;
}

/** Расширение без точки и в нижнем регистре: по нему сортируется «по типу». */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Сравнение по имени — в конце любого режима: порядок должен быть устойчивым. */
const byName = (a: DirEntry, b: DirEntry): number => a.name.localeCompare(b.name, 'ru');

/**
 * Отсортировать записи одной папки. Возвращаем новый массив: исходный порядок
 * идёт от диска, и портить его нельзя — по нему строится следующая отрисовка.
 */
export function sortTree(entries: readonly DirEntry[], options: SortOptions): DirEntry[] {
  const kindRank = (entry: DirEntry): number => (options.foldersFirst && entry.kind === 'directory' ? 0 : 1);
  const changeOf = options.changeOf ?? ((): undefined => undefined);

  return [...entries].sort((a, b) => {
    const byKind = kindRank(a) - kindRank(b);
    if (byKind !== 0) return byKind;

    if (options.sort === 'type') {
      const byType = extensionOf(a.name).localeCompare(extensionOf(b.name));
      if (byType !== 0) return byType;
    } else if (options.sort === 'modified') {
      // Свежее — выше: только что правленное обычно и нужно.
      const byTime = (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0);
      if (byTime !== 0) return byTime;
    } else if (options.sort === 'git') {
      // Файлы с правками — выше чистых: к ним и возвращаются.
      const rank = (entry: DirEntry): number => (changeOf(entry.path) === undefined ? 1 : 0);
      const byChange = rank(a) - rank(b);
      if (byChange !== 0) return byChange;
    }

    return byName(a, b);
  });
}
