/**
 * Что подсвечивается под курсором: вхождения текущего слова и парная скобка.
 *
 * Это «подсветка контекста», знакомая по всем редакторам: слово под кареткой
 * подсвечивается во всех местах файла (видно, где ещё используется), а у скобки
 * подсвечивается её пара (а если пары нет — она сама красным). Модуль только
 * СЧИТАЕТ диапазоны; как их нарисовать, решает представление.
 *
 * Почему отдельным чистым модулем: обе задачи — это работа с текстом и смещениями,
 * без DOM. Их видно в тестах без окна, а это ровно тот случай, где ошибка тиха:
 * неверная граница слова даёт подсветку середины слова, и заметить её на глаз трудно.
 *
 * Ограничения расставлены намеренно: на файле в мегабайт перебор всех вхождений
 * стоил бы дороже, чем польза от подсветки, поэтому у обоих поисков есть потолок, и
 * за ним подсветка просто не показывается (лучше пусто, чем рывки при движении курсора).
 */

import type { TextBuffer } from '../core/text-buffer';
import { wordAt } from '../core/graphemes';

/** Диапазон в смещениях UTF-16 — то же, что понимают прямоугольники выделения. */
export interface HighlightRange {
  readonly start: number;
  readonly end: number;
}

/** Найденная пара скобок: где открывающая и где закрывающая. */
export interface BracketPair {
  readonly open: HighlightRange;
  readonly close: HighlightRange;
  /** Пары не нашлось (для открывающей нет закрывающей и наоборот) — скобка «сломанная». */
  readonly unmatched: boolean;
}

/** Больше этого числа символов в документе вхождения не ищем: подсветка не стоит рывков. */
const MAX_SCAN = 2_000_000;
/** Потолок числа подсвеченных вхождений — на частом слове их могут быть тысячи. */
const MAX_OCCURRENCES = 1000;

const WORD_CHAR = /[\p{L}\p{N}_$]/u;

const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

/** Знак по смещению (`''` — смещение за пределами текста). */
function charAt(buffer: TextBuffer, offset: number): string {
  if (offset < 0 || offset >= buffer.length) return '';
  return buffer.getText(offset, offset + 1);
}

/** Слово-цель подсветки вхождений. `null` — подсвечивать нечего. */
function targetWord(buffer: TextBuffer, selection: { anchor: number; active: number }): HighlightRange | null {
  const from = Math.min(selection.anchor, selection.active);
  const to = Math.max(selection.anchor, selection.active);

  // Есть выделение без переноса — подсвечиваем вхождения выделенного текста, как есть.
  if (to > from) {
    const text = buffer.getText(from, to);
    if (text.length === 0 || text.length > 100 || text.includes('\n')) return null;
    return { start: from, end: to };
  }

  // Иначе — слово под кареткой или, если каретка сразу за словом, слово слева.
  const line = buffer.lineAt(from);
  const lineStart = buffer.lineStart(line);
  const text = buffer.lineText(line);
  const local = from - lineStart;
  const word = wordAt(text, local) ?? (local > 0 ? wordAt(text, local - 1) : null);
  if (!word) return null;
  return { start: lineStart + word.start, end: lineStart + word.end };
}

/** Слово целиком (все знаки — словные). По нему решаем, подсвечивать ли вхождения. */
function identifierLike(text: string): boolean {
  if (text.length === 0) return false;
  for (const char of text) if (!WORD_CHAR.test(char)) return false;
  return true;
}

/**
 * Все вхождения слова-цели в документе. Только целые слова: стоящий слева и справа
 * знак не должен быть словным, иначе `value` подсветилось бы и внутри `valueCount`.
 */
export function findOccurrences(buffer: TextBuffer, selection: { anchor: number; active: number }): HighlightRange[] {
  const target = targetWord(buffer, selection);
  if (!target) return [];

  if (buffer.length > MAX_SCAN) return [];
  const text = buffer.text;
  const word = text.slice(target.start, target.end);
  if (!identifierLike(word)) return [];

  const out: HighlightRange[] = [];
  let index = text.indexOf(word);
  while (index !== -1) {
    const before = index > 0 ? text[index - 1]! : '';
    const after = index + word.length < text.length ? text[index + word.length]! : '';
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) {
      out.push({ start: index, end: index + word.length });
      if (out.length >= MAX_OCCURRENCES) break;
    }
    index = text.indexOf(word, index + 1);
  }
  return out;
}

/**
 * Парная скобка для знака рядом с курсором. Смотрим сам знак под кареткой, а если его
 * там нет — знак слева: так подсветка видна и когда курсор стоит сразу ЗА скобкой, что
 * и бывает чаще всего. `null` — рядом скобки нет.
 */
export function findBracketPair(buffer: TextBuffer, offset: number): BracketPair | null {
  const under = charAt(buffer, offset);
  if (under in OPENERS || under in CLOSERS) return matchBracket(buffer, offset);
  const left = charAt(buffer, offset - 1);
  if (left in OPENERS || left in CLOSERS) return matchBracket(buffer, offset - 1);
  return null;
}

/** Сопоставить скобку по её смещению: пройти вложенность до парной или не найти её. */
function matchBracket(buffer: TextBuffer, offset: number): BracketPair | null {
  const char = charAt(buffer, offset);
  const opener = OPENERS[char];
  const closer = CLOSERS[char];
  if (!opener && !closer) return null;

  const self = { start: offset, end: offset + 1 };
  if (opener) {
    const found = scanForward(buffer, offset + 1, char, opener);
    return found === null
      ? { open: self, close: self, unmatched: true }
      : { open: self, close: found, unmatched: false };
  }
  const found = scanBackward(buffer, offset - 1, closer!, char);
  return found === null ? { open: self, close: self, unmatched: true } : { open: found, close: self, unmatched: false };
}

/** Идём вперёд от открывающей: вложенность растёт на открывающей, падает на закрывающей. */
function scanForward(buffer: TextBuffer, from: number, open: string, close: string): HighlightRange | null {
  let depth = 0;
  for (let i = from; i < buffer.length; i += 1) {
    const char = charAt(buffer, i);
    if (char === open) depth += 1;
    else if (char === close) {
      if (depth === 0) return { start: i, end: i + 1 };
      depth -= 1;
    }
  }
  return null;
}

/** Идём назад от закрывающей: вложенность растёт на закрывающей, падает на открывающей. */
function scanBackward(buffer: TextBuffer, from: number, open: string, close: string): HighlightRange | null {
  let depth = 0;
  for (let i = from; i >= 0; i -= 1) {
    const char = charAt(buffer, i);
    if (char === close) depth += 1;
    else if (char === open) {
      if (depth === 0) return { start: i, end: i + 1 };
      depth -= 1;
    }
  }
  return null;
}
