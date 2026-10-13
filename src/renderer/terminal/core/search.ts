/**
 * Поиск по выводу терминала: где в ленте встречается то, что человек ищет.
 *
 * Правило чистое — на вход строки ленты, на выход места совпадений; поэтому оно
 * проверяется без окна. Разбор запроса не свой: берём тот же, что у поиска по файлу
 * (`editor/find/search`) — иначе «в консоли ищет иначе, чем в коде» выглядело бы
 * случайностью, а не правилом. Одинаковый разбор даёт и одинаковые режимы: регистр,
 * слово целиком, регулярка.
 *
 * Строку ищем в пределах одной строки ленты: так же ведёт себя поиск в файле, и так же
 * ждёт человек — `foo bar` не должен находиться через перевод строки. Перенос строки
 * (soft wrap) у нас не рисуется отдельным рядом, поэтому строка ленты и есть строка
 * поиска.
 *
 * Смещение совпадения — в знаках текста строки, а не в клетках: у широкого знака две
 * клетки, и путать эти мерки нельзя. Перевод в клетки делает `cellRange` — им
 * пользуется подсветка, чтобы закрасить ровно то, что видно.
 */

import { compileQuery, lineMatches, type FindOptions } from '../../editor/find/search';

/** Совпадение в ленте: строка (0-based от начала истории) и смещения в тексте строки. */
export interface TermMatch {
  readonly row: number;
  /** Начало в знаках текста строки. */
  readonly start: number;
  /** Конец (не включается). */
  readonly end: number;
}

export interface TermSearchResult {
  readonly matches: TermMatch[];
  /** Причина, по которой запрос не разобрался (недописанная регулярка). */
  readonly error: string | null;
}

const EMPTY: TermSearchResult = { matches: [], error: null };

/** Сколько совпадений держим: терминал может выдать тьму строк, а показать всё равно нечего. */
const MAX_MATCHES = 5000;

/**
 * Найти совпадения во всех строках ленты. `getLine` отдаёт текст строки — вид собирает
 * его из клеток, а тест может дать обычный массив.
 */
export function searchBuffer(
  getLine: (row: number) => string,
  rowCount: number,
  query: string,
  options: FindOptions = {},
): TermSearchResult {
  if (query.length === 0) return EMPTY;
  const compiled = compileQuery(query, options);
  if (!compiled) return { matches: [], error: 'Регулярное выражение не разобрано' };

  const matches: TermMatch[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    for (const found of lineMatches(getLine(row), compiled, options)) {
      matches.push({ row, start: found.start, end: found.end });
      if (matches.length >= MAX_MATCHES) return { matches, error: null };
    }
  }
  return { matches, error: null };
}

/**
 * Границы совпадения по клеткам: `from` — первая клетка, `to` — последняя (включительно).
 * Пустая строка (`['']`) на второй половине широкого знака значит, что своей клетки у неё
 * нет, — так совпадение не «переползёт» на соседний знак.
 */
export function cellRange(chars: readonly string[], start: number, end: number): { from: number; to: number } {
  let offset = 0;
  let from = -1;
  let lastBase = -1;
  for (let index = 0; index < chars.length; index += 1) {
    const text = chars[index] ?? '';
    const length = text.length;
    // Пустая строка — вторая клетка широкого знака: своей части текста у неё нет.
    if (length > 0) {
      const cellStart = offset;
      const cellEnd = offset + length;
      // Клетка входит в совпадение, если её отрезок текста с ним пересекается.
      if (cellEnd > start && cellStart < end) {
        if (from < 0) from = index;
        lastBase = index;
      }
      offset = cellEnd;
    }
  }
  if (lastBase < 0) return { from: 0, to: 0 };
  // Достраиваем хвост: клетки-продолжения широкого знака принадлежат тому же знаку.
  let to = lastBase;
  while (to + 1 < chars.length && (chars[to + 1] ?? '').length === 0) to += 1;
  return { from: Math.max(0, from), to };
}

/**
 * Какое совпадение считаем текущим при переходе на `step` (+1 вперёд, −1 назад). Ходим
 * по кругу: после последнего идёт первое — так делает и поиск в редакторе.
 */
export function stepMatch(current: number, count: number, step: number): number {
  if (count === 0) return -1;
  if (current < 0) return step >= 0 ? 0 : count - 1;
  return (((current + step) % count) + count) % count;
}
