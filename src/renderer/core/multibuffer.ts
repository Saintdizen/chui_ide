import { replaceAll } from '../../shared/replace';

export interface GroupHit {
  /** Строка результата в порядке вывода: номер строки в файле (1-based). */
  line: number;
  column: number;
  /** Весь текст строки — так, как его увидит человек. */
  text: string;
}

export interface HitGroup {
  path: string;
  hits: GroupHit[];
}

/**
 * Мультибуфер: результаты поиска одним списком, у каждого — свой файл и место.
 *
 * Зачем отдельный модуль: до него панель поиска открывала файл по одному и об
 * остальных совпадениях забывала. «Найти и заменить везде» было одной кнопкой на
 * весь проект, а после замены список совпадений становился ложью — он показывал
 * текст, которого больше нет.
 *
 * Здесь только арифметика списка: группировка, подсчёт и точное место в файле
 * для каждого попадания. Ни DOM, ни диска — поэтому это можно проверить
 * юнит-тестами, а перенос строки и регулярку не изобретать заново: замена идёт
 * через `shared/replace.ts`, тот же, что у серверной замены по проекту.
 */

/**
 * Собрать плоский список попаданий в группы по файлам, сохраняя порядок: файлы —
 * в порядке первого попадания, попадания внутри файла — по строке.
 *
 * Зачем порядок вообще важен: при замене сверху вниз позиции ниже съезжают, и
 * группировка с сортировкой — то, что делает последовательные правки верными.
 */
export function groupHits(hits: readonly { path: string; line: number; column: number; text: string }[]): HitGroup[] {
  const groups = new Map<string, HitGroup>();
  for (const hit of hits) {
    let group = groups.get(hit.path);
    if (!group) {
      group = { path: hit.path, hits: [] };
      groups.set(hit.path, group);
    }
    group.hits.push({ line: hit.line, column: hit.column, text: hit.text });
  }
  for (const group of groups.values()) {
    group.hits.sort((left, right) => left.line - right.line || left.column - right.column);
  }
  return [...groups.values()];
}

/** Сколько попаданий всего — то, что показывает заголовок «N из M». */
export function countHits(groups: readonly HitGroup[]): number {
  let total = 0;
  for (const group of groups) total += group.hits.length;
  return total;
}

/**
 * Сколько вхождений в строке — без построения текста, только счёт.
 *
 * Нужно для статуса группы: попаданий может быть больше, чем строк.
 */
export function countInLine(
  line: string,
  query: string,
  options: { isRegex?: boolean; caseSensitive?: boolean } = {},
): number {
  if (!query) return 0;
  return replaceAll(line, query, '', options).count;
}

/**
 * Адреса попаданий в одной строке, в порядке слева направо.
 *
 * Зачем не `indexOf` в цикле: так же, как `replaceAll`, это учитывает регулярку
 * и регистр — один разбор запроса и на поиск, и на замену. Отдельный от
 * `replaceAll` путь был бы вторым мнением о том, что такое «совпадение».
 */
export function columnHits(
  line: string,
  query: string,
  options: { isRegex?: boolean; caseSensitive?: boolean } = {},
): number[] {
  if (!query) return [];
  const flags = options.caseSensitive ? 'g' : 'gi';
  const source = options.isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, flags);
  } catch {
    // Некорректная регулярка — это ошибка ввода, а не повод считать чужие места.
    return [];
  }
  return [...line.matchAll(pattern)].map((match) => match.index ?? 0);
}

export type ReplaceOutcome =
  | { kind: 'ok'; text: string; count: number }
  | { kind: 'empty-query' }
  | { kind: 'same-text' };

/**
 * Замена в одном тексте — один файл мультибуфера.
 *
 * Отдельно от `replaceAll`, чтобы различать три исхода, которые человек видит
 * по-разному: «нечего менять» (запрос пуст), «уже так и есть» (замена совпадает
 * с запросом) и «заменено столько-то». Молча прислать «заменено 0» вместо
 * объяснения — худший из исходов.
 */
export function replaceInText(
  text: string,
  query: string,
  replacement: string,
  options: { isRegex?: boolean; caseSensitive?: boolean } = {},
): ReplaceOutcome {
  if (!query) return { kind: 'empty-query' };
  const result = replaceAll(text, query, replacement, options);
  if (result.count === 0) return { kind: 'empty-query' };
  if (result.text === text) return { kind: 'same-text' };
  return { kind: 'ok', text: result.text, count: result.count };
}
