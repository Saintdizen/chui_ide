/**
 * Правки текста: ввод, удаление, перевод строки.
 *
 * Каждая функция берёт буфер и текущее выделение и возвращает готовый результат:
 * новый текст в буфере (правится на месте — буфер сам держит индекс строк) плюс
 * описание правки и новое выделение. Описание правки — то, что кладётся в историю
 * (`core/history.ts`): там кусочек «было — стало», из которого обратной правкой
 * делается отмена.
 *
 * Модуль не знает ни про DOM, ни про историю: он только меняет текст. История и
 * уведомление представления — дело контроллера.
 *
 * Главное правило, как и у движений: правка не режет то, что человек считает одним
 * символом. Backspace от эмодзи снимает его целиком, а не половину суррогатной пары.
 * Границы даёт `core/graphemes.ts` (буферные правки выравниваются по кодовым точкам,
 * а тут — по клавиатуре складываются ещё и составные кластеры).
 */

import { nextGraphemeBoundary, previousGraphemeBoundary } from '../core/graphemes';
import type { TextChange } from '../core/history';
import type { TextBuffer } from '../core/text-buffer';
import { moveWordLeft, moveWordRight } from './motions';
import { isEmpty, selectionEnd, selectionStart, type Selection } from '../view/selection';

/** Что получилось после правки: описание для истории и куда встал курсор. */
export interface EditResult {
  /** Новое выделение (обычно — каретка в месте правки). */
  readonly selection: Selection;
  /** Что изменилось — для истории правок. */
  readonly change: TextChange;
}

/** Заменить участок буфера и описать это как правку. */
function replaceRange(buffer: TextBuffer, start: number, length: number, inserted: string): TextChange {
  const removed = buffer.replace(start, length, inserted);
  return { start, removed, inserted };
}

/** Каретка в одном месте — так заканчивается почти любая правка. */
function caretAt(offset: number): Selection {
  return { anchor: offset, active: offset };
}

/** Удалить выделенное, если оно непустое. `null` — удалять нечего. */
function deleteSelection(buffer: TextBuffer, selection: Selection): EditResult | null {
  const start = selectionStart(selection);
  const end = selectionEnd(selection);
  if (start === end) return null;
  const change = replaceRange(buffer, start, end - start, '');
  return { selection: caretAt(start), change };
}

/** Вставить текст: он заменяет выделенное, если оно есть. */
export function insertText(buffer: TextBuffer, selection: Selection, text: string): EditResult | null {
  if (text.length === 0) return null;
  const start = selectionStart(selection);
  const end = selectionEnd(selection);
  const change = replaceRange(buffer, start, end - start, text);
  return { selection: caretAt(start + text.length), change };
}

/** Backspace: снять выделенное, иначе — один символ слева (или перевод строки в начале). */
export function deleteBackward(buffer: TextBuffer, selection: Selection): EditResult | null {
  if (!isEmpty(selection)) return deleteSelection(buffer, selection);
  const offset = selection.active;
  if (offset <= 0) return null;

  const line = buffer.lineAt(offset);
  const start = buffer.lineStart(line);
  let from: number;
  if (offset === start) {
    // В начале строки Backspace снимает перевод строки: участок от конца
    // предыдущей строки до текущей позиции — это и есть разрыв.
    if (line <= 1) return null;
    const previous = buffer.lineText(line - 1);
    from = buffer.lineStart(line - 1) + previous.length;
  } else {
    from = start + previousGraphemeBoundary(buffer.lineText(line), offset - start);
  }

  const change = replaceRange(buffer, from, offset - from, '');
  return { selection: caretAt(from), change };
}

/** Delete: снять выделенное, иначе — один символ справа (или перевод строки в конце). */
export function deleteForward(buffer: TextBuffer, selection: Selection): EditResult | null {
  if (!isEmpty(selection)) return deleteSelection(buffer, selection);
  const offset = selection.active;
  if (offset >= buffer.length) return null;

  const line = buffer.lineAt(offset);
  const start = buffer.lineStart(line);
  const text = buffer.lineText(line);
  const local = offset - start;
  let to: number;
  if (local >= text.length) {
    if (line >= buffer.lineCount) return null;
    to = buffer.lineStart(line + 1); // вместе с переводом строки
  } else {
    to = start + nextGraphemeBoundary(text, local);
  }

  const change = replaceRange(buffer, offset, to - offset, '');
  return { selection: caretAt(offset), change };
}

/** Ctrl+Backspace: снять слово слева (или выделенное). */
export function deleteWordBackward(buffer: TextBuffer, selection: Selection): EditResult | null {
  if (!isEmpty(selection)) return deleteSelection(buffer, selection);
  const offset = selection.active;
  if (offset <= 0) return null;
  const from = moveWordLeft(buffer, offset);
  if (from === offset) return null;
  const change = replaceRange(buffer, from, offset - from, '');
  return { selection: caretAt(from), change };
}

/** Ctrl+Delete: снять слово справа (или выделенное). */
export function deleteWordForward(buffer: TextBuffer, selection: Selection): EditResult | null {
  if (!isEmpty(selection)) return deleteSelection(buffer, selection);
  const offset = selection.active;
  if (offset >= buffer.length) return null;
  const to = moveWordRight(buffer, offset);
  if (to === offset) return null;
  const change = replaceRange(buffer, offset, to - offset, '');
  return { selection: caretAt(offset), change };
}

/**
 * Enter: перевод строки с сохранением отступа текущей строки. Отступ — ведущие табы и
 * пробелы; так код продолжается на той же глубине, и это то, чего ждут от Enter в
 * редакторе кода.
 */
export function insertNewline(buffer: TextBuffer, selection: Selection): EditResult | null {
  const start = selectionStart(selection);
  const end = selectionEnd(selection);
  const line = buffer.lineAt(start);
  const indent = /^[\t ]*/.exec(buffer.lineText(line))?.[0] ?? '';
  const change = replaceRange(buffer, start, end - start, `\n${indent}`);
  return { selection: caretAt(start + 1 + indent.length), change };
}

/**
 * Снять отступ у строки, в которой стоит курсор: до `tabSize` ведущих пробелов или
 * один таб. Возвращает `null`, если отступа нет и снимать нечего.
 */
export function outdentLine(buffer: TextBuffer, offset: number, tabSize: number): EditResult | null {
  const line = buffer.lineAt(offset);
  const start = buffer.lineStart(line);
  const text = buffer.lineText(line);
  const indent = /^[\t ]*/.exec(text)?.[0] ?? '';
  if (indent.length === 0) return null;
  const spaces = indent.startsWith('\t') ? 1 : Math.min(indent.length, tabSize);
  const change = replaceRange(buffer, start, spaces, '');
  // Курсор оставляем на месте в пределах строки: сдвиг влево не больше снятого отступа.
  const caret = Math.max(start, offset - spaces);
  return { selection: caretAt(caret), change };
}

/**
 * Сдвинуть текст всей строки (или всех строк выделения) — не используется сейчас,
 * но форма вызова та же, что у остальных правок: пригодится для Tab по выделению.
 */
export function indentLine(buffer: TextBuffer, offset: number, tabSize: number): EditResult | null {
  const line = buffer.lineAt(offset);
  const start = buffer.lineStart(line);
  const change = replaceRange(buffer, start, 0, ' '.repeat(tabSize));
  return { selection: caretAt(offset + tabSize), change };
}
