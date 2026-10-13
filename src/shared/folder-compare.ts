/**
 * Сравнение двух папок: какие файлы различаются.
 *
 * Сравниваем по относительным путям внутри папок: файл, который есть только слева,
 * считается удалённым, только справа — добавленным, в обеих — сравнивается по
 * содержимому. Логика разбора списков чистая (без диска и DOM), поэтому проверяется
 * тестами; чтение файлов делает main.
 */

export type FolderChange = 'added' | 'deleted' | 'modified';

export interface FolderCompareEntry {
  /** Путь относительно СРАВНИВАЕМОЙ папки, с прямыми слэшами (как в git). */
  path: string;
  change: FolderChange;
}

export interface FolderCompareResult {
  /** Абсолютные пути сравниваемых папок. */
  left: string;
  right: string;
  /** Различающиеся файлы, отсортированные по пути. */
  files: FolderCompareEntry[];
  /** Сколько файлов совпало по содержимому (в список не попадают). */
  identical: number;
  /** Обход упёрся в потолок файлов — список неполный. */
  truncated: boolean;
}

/** Списки относительных путей, разложенные на «только слева», «только справа» и общие. */
export interface FolderLists {
  leftOnly: string[];
  rightOnly: string[];
  common: string[];
}

/**
 * Разложить два списка относительных путей. Порядок результата — по пути: список
 * читается как оглавление, а не как порядок обхода диска (он разный у двух папок).
 */
export function splitFolderLists(left: readonly string[], right: readonly string[]): FolderLists {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const leftOnly: string[] = [];
  const rightOnly: string[] = [];
  const common: string[] = [];

  for (const path of leftSet) {
    if (rightSet.has(path)) common.push(path);
    else leftOnly.push(path);
  }
  for (const path of rightSet) if (!leftSet.has(path)) rightOnly.push(path);

  const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    leftOnly: leftOnly.sort(byPath),
    rightOnly: rightOnly.sort(byPath),
    common: common.sort(byPath),
  };
}

/**
 * Итоговый список различий из разложенных списков и решения о содержимом общих
 * файлов. `contentDiffers` зовётся для общих путей и отвечает, различается ли
 * файл; сколько совпало — считаем здесь же.
 */
export function buildFolderDiff(
  lists: FolderLists,
  contentDiffers: (path: string) => boolean,
): { files: FolderCompareEntry[]; identical: number } {
  const files: FolderCompareEntry[] = [];
  for (const path of lists.leftOnly) files.push({ path, change: 'deleted' });
  for (const path of lists.rightOnly) files.push({ path, change: 'added' });

  let identical = 0;
  for (const path of lists.common) {
    if (contentDiffers(path)) files.push({ path, change: 'modified' });
    else identical += 1;
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, identical };
}
