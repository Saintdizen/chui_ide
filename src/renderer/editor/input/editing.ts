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

/* ── парные символы ──────────────────────────────────────────────────── */

/** Открывающий знак → закрывающий. По нему ввод знает, что дописать за человеком. */
const PAIRS: Readonly<Record<string, string>> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
  '`': '`',
};

/** Закрывающий знак для открытого, иначе `null`. */
export function closerFor(char: string): string | null {
  return PAIRS[char] ?? null;
}

/** Открывающий ли это знак (за него редактор дописывает пару). */
export function isOpener(char: string): boolean {
  return char in PAIRS;
}

/** Обёртки выделения: круглые, квадратные и фигурные. Кавычки — только текст. */
function wrapsSelection(char: string): boolean {
  return char === '(' || char === '[' || char === '{';
}

/**
 * Ввести открывающий знак. Выделение есть — оборачиваем его в пару (как `(текст)`);
 * пусто — вставляем пару и ставим каретку между знаками, чтобы сразу писать внутри.
 */
export function insertPair(buffer: TextBuffer, selection: Selection, open: string, close: string): EditResult | null {
  const start = selectionStart(selection);
  const end = selectionEnd(selection);
  if (wrapsSelection(open) && start !== end) {
    const selected = buffer.getText(start, end);
    const change = replaceRange(buffer, start, end - start, `${open}${selected}${close}`);
    return { selection: caretAt(start + open.length + selected.length + close.length), change };
  }
  const change = replaceRange(buffer, start, end - start, `${open}${close}`);
  return { selection: caretAt(start + open.length), change };
}

/**
 * Ввести закрывающий знак, когда такой же уже стоит справа: не вставляем второй, а
 * просто перешагиваем через него. `null` — перешагивать некуда, ввод обычный.
 */
export function skipClosing(buffer: TextBuffer, selection: Selection, closer: string): Selection | null {
  if (!isEmpty(selection)) return null;
  const offset = selection.active;
  if (buffer.getText(offset, offset + closer.length) !== closer) return null;
  return caretAt(offset + closer.length);
}

/**
 * Backspace между пустой парой: снять оба знака разом, а не по одному. `null` —
 * по обе стороны от каретки не пара, удаление обычное.
 */
export function deletePairBackward(buffer: TextBuffer, selection: Selection): EditResult | null {
  if (!isEmpty(selection)) return null;
  const offset = selection.active;
  if (offset <= 0 || offset >= buffer.length) return null;

  const line = buffer.lineAt(offset);
  const start = buffer.lineStart(line);
  const local = offset - start;
  const text = buffer.lineText(line);
  const open = text.slice(local - 1, local);
  const close = PAIRS[open];
  if (!close || text.slice(local, local + close.length) !== close) return null;

  const change = replaceRange(buffer, offset - 1, 1 + close.length, '');
  return { selection: caretAt(offset - 1), change };
}

/* ── строки ──────────────────────────────────────────────────────────── */

/**
 * Сдвинуть строку (или строки выделения) выше или ниже. `direction` — `-1` вверх,
 * `1` вниз; за край документа не выходим — тогда `null`.
 */
export function moveLines(buffer: TextBuffer, selection: Selection, direction: -1 | 1): EditResult | null {
  const first = buffer.lineAt(selectionStart(selection));
  const last = buffer.lineAt(selectionEnd(selection));
  if (direction === -1 && first <= 1) return null;
  if (direction === 1 && last >= buffer.lineCount) return null;

  const blockStart = buffer.lineStart(first);
  const blockEnd = buffer.lineStart(last) + buffer.lineText(last).length;
  const blockText = buffer.getText(blockStart, blockEnd);

  if (direction === -1) {
    const aboveStart = buffer.lineStart(first - 1);
    const above = buffer.lineText(first - 1);
    const change = replaceRange(buffer, aboveStart, blockEnd - aboveStart, `${blockText}\n${above}`);
    return { selection: shiftSelection(selection, -(above.length + 1)), change };
  }

  const below = buffer.lineText(last + 1);
  const belowEnd = buffer.lineStart(last + 1) + below.length;
  const change = replaceRange(buffer, blockStart, belowEnd - blockStart, `${below}\n${blockText}`);
  return { selection: shiftSelection(selection, below.length + 1), change };
}

/** Скопировать строку (или строки выделения) ниже себя, оставив выделение на копиях. */
export function copyLinesDown(buffer: TextBuffer, selection: Selection): EditResult | null {
  const first = buffer.lineAt(selectionStart(selection));
  const last = buffer.lineAt(selectionEnd(selection));
  const blockStart = buffer.lineStart(first);
  const blockEnd = buffer.lineStart(last) + buffer.lineText(last).length;
  const blockText = buffer.getText(blockStart, blockEnd);

  const change = replaceRange(buffer, blockEnd, 0, `\n${blockText}`);
  return { selection: shiftSelection(selection, blockText.length + 1), change };
}

/** Сдвинуть оба конца выделения на одно и то же — после переноса строки. */
function shiftSelection(selection: Selection, delta: number): Selection {
  return { anchor: selection.anchor + delta, active: selection.active + delta };
}
