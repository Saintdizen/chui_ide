/**
 * Движения курсора: куда он уезжает от стрелки, Home или Ctrl+стрелка.
 *
 * Все движения — чистые функции «смещение → смещение». Они ничего не двигают и не
 * рисуют: контроллер (`editor-controller.ts`) берёт результат и применяет. Так
 * поведение курсора проверяется в Node, без окна.
 *
 * Общее правило: единица движения — то, что человек считает одним символом, а не
 * единица UTF-16. Границы таких единиц даёт `core/graphemes.ts`: стрелка вправо
 * перешагивает эмодзи целиком, а не половину суррогатной пары. Ходьба по словам идёт
 * по границам слов оттуда же.
 *
 * Особый случай — края строк. Стрелка вправо в конце строки переходит в начало
 * следующей (через перевод строки), влево в начале строки — в конец предыдущей.
 * Авторы текстовых редакторов делают именно так, и человек этого ждёт.
 *
 * Вертикальные движения держат «желаемый столбец»: проехав короткую строку, курсор
 * возвращается на прежний столбец в длинной. Столбец тут — в единицах UTF-16 от
 * начала строки; хранит его контроллер, потому что это состояние между нажатиями.
 */

import { nextGraphemeBoundary, previousGraphemeBoundary, wordSegments } from '../core/graphemes';
import type { TextBuffer } from '../core/text-buffer';

/** Начало, текст и конец строки (без перевода строки) — самое частое, что нужно движению. */
interface LineInfo {
  readonly start: number;
  readonly text: string;
  readonly end: number;
}

function lineInfo(buffer: TextBuffer, line: number): LineInfo {
  const start = buffer.lineStart(line);
  const text = buffer.lineText(line);
  return { start, text, end: start + text.length };
}

/**
 * Прижать смещение к границе кодовой точки: столбец может угодить ровно в середину
 * суррогатной пары (например, при переезде по вертикали в строку, где на этом месте
 * стоит эмодзи). Внутрь символа курсор вставать не должен.
 */
function alignToCodepoint(text: string, column: number): number {
  const at = Math.max(0, Math.min(column, text.length));
  if (at > 0 && at < text.length) {
    const code = text.charCodeAt(at);
    if (code >= 0xdc00 && code <= 0xdfff) return at - 1;
  }
  return at;
}

/** Столбец, на котором стоит смещение (в единицах UTF-16 от начала строки). */
export function columnAt(buffer: TextBuffer, offset: number): number {
  const line = buffer.lineAt(offset);
  return offset - buffer.lineStart(line);
}

/** Стрелка вправо: следующий символ или начало следующей строки. */
export function moveRight(buffer: TextBuffer, offset: number): number {
  const line = buffer.lineAt(offset);
  const info = lineInfo(buffer, line);
  if (offset >= info.end) {
    if (line < buffer.lineCount) return buffer.lineStart(line + 1);
    return offset;
  }
  return info.start + nextGraphemeBoundary(info.text, offset - info.start);
}

/** Стрелка влево: предыдущий символ или конец предыдущей строки. */
export function moveLeft(buffer: TextBuffer, offset: number): number {
  const line = buffer.lineAt(offset);
  const info = lineInfo(buffer, line);
  if (offset <= info.start) {
    if (line > 1) return lineInfo(buffer, line - 1).end;
    return offset;
  }
  return info.start + previousGraphemeBoundary(info.text, offset - info.start);
}

/**
 * Ctrl+вправо: к концу текущего слова, а если курсор уже за его концом — к концу
 * следующего. Это привычное `cursorWordEndRight`: перемещение останавливается НА
 * границе слова, а не уносит к его началу.
 */
export function moveWordRight(buffer: TextBuffer, offset: number): number {
  const line = buffer.lineAt(offset);
  const info = lineInfo(buffer, line);
  const local = offset - info.start;
  if (local >= info.text.length) {
    if (line < buffer.lineCount) return buffer.lineStart(line + 1);
    return offset;
  }

  const parts = wordSegments(info.text);
  // Стоим внутри слова — его конец.
  const current = parts.find((part) => local >= part.start && local < part.end);
  if (current?.isWordLike) return info.start + current.end;
  // Иначе — конец ближайшего слова справа (промежутки пропускаем).
  const next = parts.find((part) => part.isWordLike && part.start >= local);
  if (next) return info.start + next.end;

  // Слов правее нет: за конец строки — в начало следующей.
  if (line < buffer.lineCount) return buffer.lineStart(line + 1);
  return info.end;
}

/** Ctrl+влево: к началу текущего слова, а от него — к началу предыдущего. */
export function moveWordLeft(buffer: TextBuffer, offset: number): number {
  const line = buffer.lineAt(offset);
  const info = lineInfo(buffer, line);
  const local = offset - info.start;
  if (local <= 0) {
    if (line > 1) return lineInfo(buffer, line - 1).end;
    return offset;
  }

  const parts = wordSegments(info.text);
  let position = local;
  const left = parts.find((part) => local > part.start && local <= part.end);
  if (left?.isWordLike) {
    position = left.start;
  } else {
    // Стоим в промежутке: идём влево до начала ближайшего слова.
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index]!;
      if (part.end > position) continue;
      position = part.start;
      if (part.isWordLike) break;
    }
  }
  return info.start + position;
}

/** Home: начало текста строки без ведущих пробелов (при повторном нажатии — начало строки). */
export function moveSmartLineStart(buffer: TextBuffer, offset: number): number {
  const line = buffer.lineAt(offset);
  const info = lineInfo(buffer, line);
  const firstText = /[^\t ]/.exec(info.text)?.index ?? -1;
  const textStart = firstText > 0 ? info.start + firstText : info.start;
  return offset > textStart ? textStart : info.start;
}

/** End: конец строки (без перевода строки). */
export function moveLineEnd(buffer: TextBuffer, offset: number): number {
  const line = buffer.lineAt(offset);
  return lineInfo(buffer, line).end;
}

/** Начало строки по её номеру — для кликов и стрелок Home. */
export function moveLineStart(buffer: TextBuffer, offset: number): number {
  const line = buffer.lineAt(offset);
  return buffer.lineStart(line);
}

/** Ctrl+Home: начало документа. */
export function moveDocStart(): number {
  return 0;
}

/** Ctrl+End: конец документа. */
export function moveDocEnd(buffer: TextBuffer): number {
  return buffer.length;
}

/**
 * Вертикальное движение с сохранением желаемого столбца. Проехав короткую строку,
 * курсор вернётся на прежний столбец в длинной — за это и отвечает `goalColumn`.
 */
export function moveVertical(buffer: TextBuffer, offset: number, delta: number, goalColumn: number): number {
  const line = buffer.lineAt(offset);
  const target = Math.max(1, Math.min(line + delta, buffer.lineCount));
  const info = lineInfo(buffer, target);
  return info.start + alignToCodepoint(info.text, goalColumn);
}

/** Постраничное движение: та же вертикаль, но шаг — на высоту экрана. */
export function movePage(buffer: TextBuffer, offset: number, deltaLines: number, goalColumn: number): number {
  return moveVertical(buffer, offset, deltaLines, goalColumn);
}
