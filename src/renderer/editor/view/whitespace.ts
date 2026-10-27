/**
 * Визуализация пробелов: где и какие невидимые знаки показывать.
 *
 * Это чистая арифметика над строкой — без DOM. Она отвечает только на вопрос «где
 * стоят пробелы и табуляции, которые надо нарисовать», а как именно их рисовать,
 * решает представление (`editor-view.ts`): пробелы — точками по центру клетки,
 * табуляции — стрелкой слева.
 *
 * Смещения — UTF-16, как везде в редакторе (см. `core/text-buffer.ts`).
 */

import type { WhitespaceMode } from '../../../shared/whitespace';

export { normalizeWhitespaceMode, WHITESPACE_MODES } from '../../../shared/whitespace';
export type { WhitespaceMode } from '../../../shared/whitespace';

/** Отрезок невидимого знака: что и где нарисовать. */
export interface WhitespaceMark {
  readonly start: number;
  readonly end: number;
  readonly kind: 'space' | 'tab';
}

/** Пробел или табуляция — знак, который сам по себе не видно. */
function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t';
}

function kindOf(ch: string): 'space' | 'tab' {
  return ch === '\t' ? 'tab' : 'space';
}

/**
 * Отрезки невидимых знаков строки. Идём слева направо и собираем подряд идущие знаки
 * одного вида в один отрезок: так на строке с длинным отступом получается один узел
 * на отступ, а не десяток. Для `trailing` берём только хвост — от последнего видимого
 * знака до конца строки.
 */
export function whitespaceMarks(text: string, mode: WhitespaceMode): WhitespaceMark[] {
  if (mode === 'none' || text.length === 0) return [];

  let from = 0;
  if (mode === 'trailing') {
    // Хвост — всё после последнего видимого знака. Строка из одних пробелов: хвост весь.
    let last = text.length;
    while (last > 0 && isWhitespace(text[last - 1]!)) last -= 1;
    from = last;
  }

  const marks: WhitespaceMark[] = [];
  let at = from;
  while (at < text.length) {
    if (!isWhitespace(text[at]!)) {
      at += 1;
      continue;
    }
    const kind = kindOf(text[at]!);
    const start = at;
    while (at < text.length && isWhitespace(text[at]!) && kindOf(text[at]!) === kind) at += 1;
    marks.push({ start, end: at, kind });
  }
  return marks;
}
