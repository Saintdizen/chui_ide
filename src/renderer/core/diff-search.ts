/**
 * Поиск сразу по обеим сторонам сравнения.
 *
 * Зачем. Сравнив два файла, человек чаще всего ищет не «где это», а «есть ли это
 * по обе стороны»: имя функции, ключ, константу. Обычный поиск по одной панели
 * этого не отвечает, и приходится искать дважды и сводить в голове.
 *
 * Почему отдельный модуль. Ряды сравнения — не два независимых текста: в одном
 * ряду слева и справа могут лежать РАЗНЫЕ строки (ряд `replace`). Поэтому
 * обычный поиск по строке файла здесь даёт неверный счётчик, а «сколько
 * попаданий» нужен именно по сторонам.
 */

import type { DiffRow } from '../editor/host/diff-model';

/** Одна сторона сравнения. */
export type DiffSideName = 'original' | 'modified';

/** Попадание: где и в какой строке. */
export interface DiffSearchHit {
  readonly side: DiffSideName;
  /** Номер строки на этой стороне, 1 с единицы (та же нумерация, что в жёлобе). */
  readonly line: number;
  /** Сколько раз запрос встретился в этой строке. */
  readonly count: number;
}

/** Сводка: попадания по сторонам и итог «в обоих файлах». */
export interface DiffSearchResult {
  readonly hits: readonly DiffSearchHit[];
  readonly original: number;
  readonly modified: number;
  /** Запрос нашёлся и слева, и справа — то, ради чего этот поиск и нужен. */
  readonly both: boolean;
}

/**
 * Найти запрос по обеим сторонам.
 *
 * `count` в строке считается, а не «есть/нет»: «есть ли по обе стороны» — вопрос
 * к наличию, а «сколько раз» — к числу, и смешивать их в одном поле значило бы
 * врать в одном из двух случаев.
 *
 * Регистр по умолчанию не важен: в сравнении ищут имена и ключи, и разница в
 * регистре там чаще всего не то, что искали.
 */
export function searchDiff(
  rows: readonly DiffRow[],
  query: string,
  options: { caseSensitive?: boolean } = {},
): DiffSearchResult {
  const caseSensitive = options.caseSensitive === true;
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  if (needle === '') return { hits: [], original: 0, modified: 0, both: false };

  const hits: DiffSearchHit[] = [];
  let original = 0;
  let modified = 0;

  for (const row of rows) {
    // У ряда вставки слева строки нет и наоборот — считаем только то, что есть.
    if (row.originalLine !== null) {
      const count = countIn(row.originalText, needle, caseSensitive);
      if (count > 0) {
        hits.push({ side: 'original', line: row.originalLine, count });
        original += count;
      }
    }
    if (row.modifiedLine !== null) {
      const count = countIn(row.modifiedText, needle, caseSensitive);
      if (count > 0) {
        hits.push({ side: 'modified', line: row.modifiedLine, count });
        modified += count;
      }
    }
  }

  // Порядок — как обещано в nextHit: сначала вся левая сторона, потом правая.
  // По рядам список шёл бы вперемешку, и «Enter» прыгал бы между панелями на
  // каждой строке — читать сравнение подряд так нельзя.
  hits.sort((a, b) => (a.side === b.side ? a.line - b.line : a.side === 'original' ? -1 : 1));
  return { hits, original, modified, both: original > 0 && modified > 0 };
}

/**
 * Сколько раз запрос встретился в строке, вхождения не перекрываются.
 *
 * Перекрытие важно: в «ааа» запрос «аа» встречается один раз по правилу «съели —
 * двигаемся дальше», а наивный `indexOf` в цикле отдал бы два, и счётчик
 * разошёлся бы с тем, что человек видит при подсветке.
 */
function countIn(text: string, needle: string, caseSensitive: boolean): number {
  const haystack = caseSensitive ? text : text.toLocaleLowerCase();
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * Следующее попадание по кругу — для «Enter» в панели сравнения.
 *
 * Порядок обхода задан порядком попаданий: сначала левая сторона сверху вниз,
 * потом правая. Так человек прочитывает сравнение один раз, а не прыгает между
 * сторонами на каждой строке.
 *
 * `from` — позиция в списке попаданий (`-1` — начинаем с первого). От края
 * заворачиваем: поиск, который упирается в конец и молчит, читается как поломка.
 */
export function nextHit(hits: readonly DiffSearchHit[], from: number, direction: 1 | -1): number {
  if (hits.length === 0) return -1;
  const next = from + direction;
  if (next < 0) return hits.length - 1;
  if (next >= hits.length) return 0;
  return next;
}
