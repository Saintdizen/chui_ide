/**
 * Правки в стиле LSP → правки нашего буфера.
 *
 * Ассистент, языковой сервер и «правки с диска» присылают правки позициями: строка и
 * столбец, оба с единицы, столбец — в единицах UTF-16 (`shared/edits.ts`). Нашему
 * буферу нужны смещения. Перевод выглядит простым (умножить строку на длину?), но
 * ошибиться в нём легко и незаметно: строки разной длины, а перевод строки в
 * `lineText` не входит.
 *
 * Поэтому перевод идёт через сам буфер (`offsetAt`), а не по строке текста: там уже есть
 * индекс начал строк, и он же отвечает на «сколько знаков в этой строке» с учётом
 * разрывов `\n`, `\r`, `\r\n` — второй правды о строках заводить не надо.
 *
 * Заказ правок — по убыванию смещения. Это не мелочь: применяются они подряд, и правка
 * в начале сдвинула бы смещения всех последующих. По убыванию смещения не съезжают —
 * ровно по этой причине так же устроена замена по файлу (`find/replace.ts`).
 *
 * Правка с заданным `oldText` сверяется с буфером и НЕ применяется при расхождении: если
 * позицию посчитал кто-то другой, лучше пропустить правку, чем переписать не то место.
 * Сколько применилось, а сколько пропало — возвращаем числами, а не молчанием.
 */

import type { TextEdit } from '../../../shared/edits';
import type { TextChange } from '../core/history';
import type { TextBuffer } from '../core/text-buffer';

export interface TranslatedEdits {
  /** Правки по убыванию смещения — в порядке применения. */
  readonly changes: TextChange[];
  /** Сколько правок пропущено и почему. */
  readonly skipped: ReadonlyArray<{ edit: TextEdit; reason: string }>;
}

/** Перевести правки в смещения буфера, отбросив неприменимые. */
export function translateEdits(buffer: TextBuffer, edits: readonly TextEdit[]): TranslatedEdits {
  const changes: TextChange[] = [];
  const skipped: Array<{ edit: TextEdit; reason: string }> = [];

  for (const edit of edits) {
    const start = buffer.offsetAt({ line: edit.startLine, column: edit.startColumn });
    const end = buffer.offsetAt({ line: edit.endLine, column: edit.endColumn });
    if (end < start) {
      skipped.push({ edit, reason: 'конец раньше начала' });
      continue;
    }

    const removed = buffer.getText(start, end);
    // `oldText` — договорённость о том, что именно заменяем: расходится — не трогаем.
    if (edit.oldText !== undefined && edit.oldText !== removed) {
      skipped.push({ edit, reason: 'текст под правкой не совпал' });
      continue;
    }
    if (removed === edit.newText) continue; // Менять нечего: правка уже применена.

    changes.push({ start, removed, inserted: edit.newText });
  }

  // По убыванию смещения: применяются подряд, и так они не сдвигают друг друга.
  changes.sort((a, b) => b.start - a.start);
  return { changes, skipped };
}

/** Правка в стиле LSP для участка буфера — обратный перевод, нужен для ответов наружу. */
export function toTextEdit(buffer: TextBuffer, start: number, end: number, newText: string): TextEdit {
  const from = buffer.positionAt(start);
  const to = buffer.positionAt(end);
  return {
    startLine: from.line,
    startColumn: from.column,
    endLine: to.line,
    endColumn: to.column,
    newText,
  };
}
