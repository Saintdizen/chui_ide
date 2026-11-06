/**
 * Куда сдвигается запомненное место, когда текст правят за кадром.
 *
 * Зачем это вообще. Сессия помнит курсор по файлу и возвращает его при
 * открытии. Но правка может лечь в буфер, который сейчас НЕ НА ЭКРАНЕ: файл
 * поправил ассистент, языковой сервер, форматирование при сохранении или
 * перечитанный с диска текст. Позиция при этом остаётся старой — и после
 * перезапуска человек попадает НЕ туда, где остановился, хотя правки на
 * месте. Именно про это пункт: «восстановленный буфер помечает место, до
 * которого правки уже были.
 *
 * Почему функция чистая: сдвиг — простая арифметика по числам строк, и
 * ошибиться в ней легче всего на краях (правка выше курсора, правка на той
 * же строке, правка ниже). Числа строк — 1-базовые, столбцы — 1-базовые:
 * та же система, что у `CursorPosition`.
 */
import type { CursorPosition } from './api';
import type { TextEdit } from './edits';

const atLeast1 = (value: number): number => (Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1);

/**
 * Сдвинуть курсор вслед за правками.
 *
 * Правила:
 * 1. Правка ПОЛНОСТЬЮ ВЫШЕ курсора — курсор съезжает на разницу строк.
 * 2. Правка ПОЛНОСТЬЮ НИЖЕ — ничего не меняется.
 * 3. Правка перекрывает курсор — курсор встаёт в КОНЕЦ вставленного, а если
 *    ничего не вставлено (удаление), — туда, где был его верх. Терять «где я
 *    был» хуже, чем встать на строку удаления: файл всё равно изменился.
 * 4. Правка кончается РОВНО НА строке курсора — сдвиг на разницу строк, а
 *    столбец остаётся, потому что хвост строки после курсора цел.
 */
export function shiftCursor(position: CursorPosition, edits: readonly TextEdit[]): CursorPosition {
  let line = atLeast1(position.line);
  let column = atLeast1(position.column);

  for (const edit of edits) {
    const fromLine = atLeast1(edit.startLine);
    const toLine = Math.max(fromLine, atLeast1(edit.endLine));
    const fromColumn = atLeast1(edit.startColumn);
    const toColumn = Math.max(1, atLeast1(edit.endColumn));

    // Сколько строк пришло и сколько ушло — это же и сдвиг для всего, что ниже.
    const added = lineBreaks(edit.newText);
    const delta = added - (toLine - fromLine);
    const afterNew = tailLength(edit.newText);

    if (toLine < line) {
      // 1. Правка целиком выше: строк стало больше (или меньше) — курсор за ней.
      line += delta;
      continue;
    }
    if (fromLine > line) continue; // 2. Целиком ниже — не наша забота.

    if (fromLine === toLine && line === fromLine) {
      // 3. Правка на строке курсора: решает столбец.
      if (column < fromColumn) continue; // Правка строго справа — не трогаем.
      if (column === fromColumn && added > 0) {
        // Курсор РОВНО в точке вставки, а вставка многострочная: место, где он
        // стоял, теперь занято первыми строками. Встаём в конец последней —
        // туда, где текст правки кончился.
        line = fromLine + added;
        column = afterNew;
        continue;
      }
      if (column < toColumn) {
        // Курсор ВНУТРИ заменяемого куска — прежнего места больше нет.
        line = fromLine + added;
        column = afterNew;
        continue;
      }
      // Курсор ПРАВЕЕ правки: хвост строки цел. Столбец едет на разницу длин,
      // а строка — только на пришедшие переводы строки.
      const removedLen = toColumn - fromColumn;
      column = column - removedLen + (added > 0 ? afterNew - 1 : edit.newText.length);
      if (column < 1) column = 1;
      line += added;
      continue;
    }
    if (line === fromLine && column > fromColumn) {
      // Курсор на ПЕРВОЙ строке многострочной правки: после хвоста вставленного,
      // а остаток его строки сохраняется за хвостом.
      line = fromLine + added;
      column = afterNew + (column - fromColumn);
      continue;
    }
    if (line > fromLine) {
      // 4. Курсор ВНУТРИ диапазона правки — прежнего места нет.
      line = fromLine + added;
      column = afterNew;
      continue;
    }
    line += delta;
  }

  return { line: atLeast1(line), column: atLeast1(column) };
}

/** Сколько переводов строки в тексте. */
function lineBreaks(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) count += 1;
  return count;
}

/** Столбец сразу после вставленного, 1-базовый. */
function tailLength(text: string): number {
  const at = text.lastIndexOf('\n');
  return at < 0 ? text.length + 1 : text.length - at;
}
