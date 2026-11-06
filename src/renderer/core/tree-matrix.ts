/**
 * Что должно получиться в папке при всех настройках сразу.
 *
 * Почему это отдельный чистый модуль: порядок, группировка, вложенность и
 * скрытые работают ОДНОВРЕМЕННО, а проверяли их до сих пор по одному
 * (`tree-sort`, `tree-group`, `nesting`). Комбинаций четыре на два на два —
 * тридцать два случая, и в них прячутся ошибки, которых нет ни в одном
 * частном тесте: поменяли порядок так, что полки группировки распались на две;
 * свернули файлы в родителя и потеряли полку; спрятали скрытые после сортировки
 * и получили пустую полку с заголовком.
 *
 * Смысл матрицы — один вопрос: **набор файлов после всех преобразований тот же,
 * что до них**, и каждая условность соблюдена. Тест говорит, что именно должно
 * быть видно, а этот файл это считает.
 */

import type { DirEntry, TreeSort } from '../../shared/api';
import { entryIsDirectory } from '../../shared/entry-kind';
import { sortTree } from './tree-sort';
import { groupByKind, type FileGroup } from './tree-group';

/** Всё, что влиет на порядок и набор строка в одной папке. */
export interface MatrixOptions {
  readonly foldersFirst: boolean;
  readonly sort: TreeSort;
  readonly groupByType: boolean;
  readonly showHidden: boolean;
  /** Скрытые по вложенности (`core/nesting.ts`) — только имена. */
  readonly hidden?: ReadonlySet<string>;
  readonly changeOf?: (path: string) => 'added' | 'modified' | 'deleted' | undefined;
}

/** Полка списка: либо обычные строки, либо подпись группы и её строки. */
export interface MatrixSection {
  readonly label: string | null;
  readonly entries: readonly DirEntry[];
}

/**
 * Провести файлы папки через всё сразу — в том же порядке, что и вид дерева.
 *
 * Порядок шагов — это и есть смысл:
 * 1. скрытые — ПЕРВЫМИ: иначе в группе остётся заголовок без ни одной строки;
 * 2. вложенность — до сортировки: свёрнутый файл — уже не строка списка;
 * 3. сортировка — внутри каждой полки, одна на все;
 * 4. группировка — последней, ибо она делит уже осмысленный список.
 */
export function matrixSections(entries: readonly DirEntry[], options: MatrixOptions): MatrixSection[] {
  const visible = entries.filter((entry) => {
    if (!options.showHidden && entry.name.startsWith('.')) return false;
    return !(options.hidden?.has(entry.name) ?? false);
  });
  const ordered = sortTree(visible, {
    foldersFirst: options.foldersFirst,
    sort: options.sort,
    ...(options.changeOf ? { changeOf: options.changeOf } : {}),
  });
  if (!options.groupByType) return [{ label: null, entries: ordered }];

  const folders = ordered.filter((entry) => entryIsDirectory(entry));
  const files = ordered.filter((entry) => !entryIsDirectory(entry));
  const sections: MatrixSection[] = folders.length > 0 ? [{ label: null, entries: folders }] : [];
  const groups: FileGroup<DirEntry>[] = groupByKind(files, (entry) => entry.name);
  for (const group of groups) sections.push({ label: group.label, entries: group.entries });
  return sections;
}

/** Все имена, которые действительно видны — для сверки «никого не потеряли». */
export function matrixVisible(sections: readonly MatrixSection[]): string[] {
  return sections.flatMap((section) => section.entries.map((entry) => entry.name));
}
