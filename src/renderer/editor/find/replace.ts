/**
 * Замена по файлу: одно совпадение или все сразу.
 *
 * Замена строится на том же разборе запроса, что и поиск (`lineMatches`) — иначе
 * «нашлось 12, заменилось 8» было бы обычным делом, и человек этому не верит.
 *
 * Замена всех возвращает ОДНУ правку на весь диапазон от первого совпадения до
 * последнего, а не список из двенадцати. Причина не в удобстве, а в истории правок:
 * шаг истории применяется и отменяется по записанным правкам, и набор независимых
 * правок туда не годится — смещения второй правки после применения первой уже съехали
 * бы. Одна правка на диапазон этой проблемы не имеет: отменить её — значит вернуть
 * прежний текст участка. Цена — в истории лежит текст изменённой области, но это
 * ровно тот объём, который и менялся.
 *
 * Результат — правка в терминах модели (`start`, `removed`, `inserted`), а применять
 * её — дело вызывающего: в приложении это контроллер, который кладёт её в историю.
 * Так модуль остаётся чистым и его видно в тестах.
 */

import { expandReplacement, lineMatches, type CompiledQuery, type FindMatch, type FindOptions } from './search';

/** Правка участка: сколько было, сколько стало. В точности формат истории правок. */
export interface ReplaceEdit {
  readonly start: number;
  readonly removed: string;
  readonly inserted: string;
  /** Сколько совпадений заменено этой правкой — для сообщения «заменено N». */
  readonly count: number;
}

/** Что нужно знать о документе, чтобы собрать правку. */
export interface ReplaceSource {
  getLine(line0: number): string;
  /** Смещение начала строки; номер строки — с единицы, как в модели. */
  lineStart(line: number): number;
}

/** Применить замены к одной строке и вернуть её новый текст. */
function replaceInLineText(
  text: string,
  compiled: CompiledQuery,
  replacement: string,
  options: FindOptions,
): { text: string; count: number } {
  const found = lineMatches(text, compiled, options);
  if (found.length === 0) return { text, count: 0 };

  let out = '';
  let cursor = 0;
  for (const match of found) {
    out += text.slice(cursor, match.start);
    const matched = text.slice(match.start, match.end);
    out += expandReplacement(match, matched, replacement, options.regex === true);
    cursor = match.end;
  }
  out += text.slice(cursor);
  return { text: out, count: found.length };
}

/**
 * Заменить все совпадения. Возвращает одну правку или `null`, если заменять нечего.
 *
 * Диапазон — от начала строки первого совпадения до конца строки последнего; строки
 * между ними входят в правку целиком, даже если совпадений в них нет. Так участок
 * цельный, а отмена возвращает ровно прежний текст.
 *
 * `matches` задают диапазон строк, а сами замены делаются заново по `options` — теми
 * же настройками, какими совпадения и найдены. Так замена и поиск гарантированно
 * согласованы: нельзя заменить не то, что нашёл.
 */
export function replaceAll(
  source: ReplaceSource,
  matches: readonly FindMatch[],
  compiled: CompiledQuery,
  replacement: string,
  options: FindOptions = {},
): ReplaceEdit | null {
  if (matches.length === 0) return null;
  const firstLine = matches[0]!.line;
  const lastLine = matches[matches.length - 1]!.line;

  const before: string[] = [];
  const after: string[] = [];
  let count = 0;
  for (let line = firstLine; line <= lastLine; line += 1) {
    const text = source.getLine(line - 1);
    before.push(text);
    const result = replaceInLineText(text, compiled, replacement, options);
    after.push(result.text);
    count += result.count;
  }

  return {
    start: source.lineStart(firstLine),
    removed: before.join('\n'),
    inserted: after.join('\n'),
    count,
  };
}

/**
 * Правка для одного совпадения — по ней работает «заменить текущее». Совпадение ищем
 * заново в его строке: так получаем группы, которые нужны в режиме регулярки.
 */
export function replaceOne(
  source: ReplaceSource,
  match: FindMatch,
  compiled: CompiledQuery,
  replacement: string,
  options: FindOptions = {},
): ReplaceEdit | null {
  const text = source.getLine(match.line - 1);
  const lineStart = source.lineStart(match.line);
  const localStart = match.start - lineStart;
  const localEnd = match.end - lineStart;
  if (localStart < 0 || localEnd > text.length) return null;

  const found = lineMatches(text, compiled, options).find((item) => item.start === localStart && item.end === localEnd);
  if (!found) return null;

  const matched = text.slice(found.start, found.end);
  return {
    start: match.start,
    removed: matched,
    inserted: expandReplacement(found, matched, replacement, options.regex === true),
    count: 1,
  };
}
