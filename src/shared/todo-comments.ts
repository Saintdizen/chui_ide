/**
 * Пометки TODO/FIXME в строке: где они стоят.
 *
 * Такую пометку пишут в комментарии, чтобы вернуться к ней позже, и её полезно видеть
 * глазом: «тут ещё не доделано». Модуль только НАХОДИТ пометки — как их покрасить,
 * решает представление (в редакторе это подсветка слова, в панели — список).
 *
 * Правило чистое: строка на входе, отрезки на выходе. Поэтому проверяется тестами без
 * окна и годится и редактору, и поиску по проекту.
 */

/** Слова-пометки. Совпадают со списком команды «Найти TODO и FIXME». */
const MARKERS = /\b(TODO|FIXME|HACK|XXX)\b/gi;

/** Отрезок строки (в единицах UTF-16) с пометкой. */
export interface TodoMark {
  readonly start: number;
  readonly end: number;
}

/** Пометки в строке: границы каждого слова-пометки. */
export function todoMarks(text: string): TodoMark[] {
  const marks: TodoMark[] = [];
  // Регулярка с `g` хранит `lastIndex` — на каждой новой строке начинаем с нуля.
  MARKERS.lastIndex = 0;
  for (let match = MARKERS.exec(text); match !== null; match = MARKERS.exec(text)) {
    marks.push({ start: match.index, end: match.index + match[0].length });
  }
  return marks;
}
