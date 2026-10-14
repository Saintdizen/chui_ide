/**
 * Сравнение двух ноутбуков по ЯЧЕЙКАМ.
 *
 * Сравнивать `.ipynb` как строки JSON бесполезно: любой пересчёт выводов или смена
 * порядка ключей меняет половину файла, и настоящие правки в них тонут. Поэтому ячейки
 * сопоставляются как есть — по виду и тексту исходника, — а выводы в сравнении не
 * участвуют: они пересчитываются при каждом запуске и к замыслу ноутбука отношения не
 * имеют.
 *
 * Сопоставление — по общей подпоследовательности (LCS) ячеек: она сохраняет порядок и
 * не «сдвигает» совпадения, как сделало бы сравнение по номерам. Затем подряд идущие
 * удаления и вставки ОДНОГО вида склеиваются в «изменено» с построчным различием — так
 * же поступает git, и это ровно то, что человек ищет: «эта ячейка переписана».
 *
 * Модуль чистый: ни диска, ни DOM. Окно лишь рисует готовые строки изменений.
 */

import type { Notebook, NotebookCell, NotebookCellKind } from './notebook';

/** Статус ячейки в сравнении. */
export type NotebookChangeKind = 'equal' | 'added' | 'removed' | 'changed';

/** Строка построчного различия внутри изменённой ячейки. */
export interface NotebookLineDiff {
  kind: 'equal' | 'added' | 'removed';
  text: string;
}

/** Одна запись сравнения: ячейка и что с ней стало. */
export interface NotebookChange {
  kind: NotebookChangeKind;
  cellKind: NotebookCellKind;
  /** Текст ячейки слева (было); `null` — ячейки не было. */
  before: string | null;
  /** Текст ячейки справа (стало); `null` — ячейки не стало. */
  after: string | null;
  /** Построчное различие — только у `changed`. */
  lines: NotebookLineDiff[];
}

export interface NotebookDiff {
  changes: NotebookChange[];
  /** Сколько ячеек добавлено, удалено и изменено — для подписи. */
  added: number;
  removed: number;
  changed: number;
}

/** Предел строк в одной ячейке для построчного различия: гигантская ячейка не нужна. */
const MAX_DIFF_LINES = 400;

/** Ключ сопоставления: вид и текст ячейки как есть (выводы не участвуют). */
function cellKey(cell: NotebookCell): string {
  return `${cell.kind}\u0000${normalize(cell.source)}`;
}

/** Хвостовые пробелы и пустые строки на конце не меняют ячейку. */
function normalize(source: string): string {
  return source.replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
}

/** Разбить текст ячейки на строки. */
function lines(source: string): string[] {
  return source === '' ? [] : source.replace(/\n$/, '').split('\n');
}

/**
 * Построчное различие двух текстов (LCS по строкам). Строки длиннее предела режем:
 * для сравнения ячейки этого достаточно, а память тратить не на что.
 */
export function lineDiff(before: string, after: string): NotebookLineDiff[] {
  const a = lines(before).slice(0, MAX_DIFF_LINES);
  const b = lines(after).slice(0, MAX_DIFF_LINES);
  const n = a.length;
  const m = b.length;
  // Классическое динамическое программирование: таблица длин общей подпоследовательности.
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = table[i]!;
      const next = table[i + 1]!;
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }

  const result: NotebookLineDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ kind: 'equal', text: a[i]! });
      i += 1;
      j += 1;
      continue;
    }
    if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      result.push({ kind: 'removed', text: a[i]! });
      i += 1;
    } else {
      result.push({ kind: 'added', text: b[j]! });
      j += 1;
    }
  }
  while (i < n) result.push({ kind: 'removed', text: a[i++]! });
  while (j < m) result.push({ kind: 'added', text: b[j++]! });
  return result;
}

/** Одна операция LCS: совпадение или пропуск с той либо другой стороны. */
type Op =
  | { type: 'equal'; cell: NotebookCell }
  | { type: 'removed'; cell: NotebookCell }
  | { type: 'added'; cell: NotebookCell };

/** Сопоставить ячейки двух ноутбуков по общей подпоследовательности. */
function align(before: readonly NotebookCell[], after: readonly NotebookCell[]): Op[] {
  const n = before.length;
  const m = after.length;
  const keyA = before.map(cellKey);
  const keyB = after.map(cellKey);
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = table[i]!;
      const next = table[i + 1]!;
      row[j] = keyA[i] === keyB[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (keyA[i] === keyB[j]) {
      ops.push({ type: 'equal', cell: before[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ type: 'removed', cell: before[i]! });
      i += 1;
    } else {
      ops.push({ type: 'added', cell: after[j]! });
      j += 1;
    }
  }
  while (i < n) ops.push({ type: 'removed', cell: before[i++]! });
  while (j < m) ops.push({ type: 'added', cell: after[j++]! });
  return ops;
}

/**
 * Сравнить два ноутбука. Подряд идущие удаления и вставки одного вида склеиваются в
 * «изменено»: ячейку переписали, а не удалили и завели рядом такую же.
 */
export function diffNotebooks(before: Notebook, after: Notebook): NotebookDiff {
  const ops = align(before.cells, after.cells);
  const changes: NotebookChange[] = [];

  let cursor = 0;
  while (cursor < ops.length) {
    const op = ops[cursor]!;
    if (op.type === 'equal') {
      changes.push({ kind: 'equal', cellKind: op.cell.kind, before: op.cell.source, after: op.cell.source, lines: [] });
      cursor += 1;
      continue;
    }

    // Собираем идущий подряд блок пропусков, затем разбираем его на «удаления» и «вставки».
    const block: Op[] = [];
    while (cursor < ops.length && ops[cursor]!.type !== 'equal') {
      block.push(ops[cursor]!);
      cursor += 1;
    }
    const removed = block.filter((item) => item.type === 'removed').map((item) => item.cell);
    const added = block.filter((item) => item.type === 'added').map((item) => item.cell);

    // Пары «удалили и вставили того же вида» — это правка ячейки, показываем построчно.
    const paired = Math.min(removed.length, added.length);
    let pair = 0;
    while (pair < paired && removed[pair]!.kind === added[pair]!.kind) {
      changes.push({
        kind: 'changed',
        cellKind: removed[pair]!.kind,
        before: removed[pair]!.source,
        after: added[pair]!.source,
        lines: lineDiff(removed[pair]!.source, added[pair]!.source),
      });
      pair += 1;
    }
    for (const cell of removed.slice(pair)) {
      changes.push({ kind: 'removed', cellKind: cell.kind, before: cell.source, after: null, lines: [] });
    }
    for (const cell of added.slice(pair)) {
      changes.push({ kind: 'added', cellKind: cell.kind, before: null, after: cell.source, lines: [] });
    }
  }

  return {
    changes,
    added: changes.filter((change) => change.kind === 'added').length,
    removed: changes.filter((change) => change.kind === 'removed').length,
    changed: changes.filter((change) => change.kind === 'changed').length,
  };
}
