/**
 * Правки строк и выделения: сортировка, объединение, удаление и вставка строк,
 * дублирование, перестановка знаков, смена регистра.
 *
 * Две части в одном модуле, но с чёткой границей:
 *
 *   • ЧИСТЫЕ функции (`sortLineTexts`, `joinLineTexts`) работают со списком строк и
 *     ничего не знают о буфере — их проверяют тестами напрямую, как обычную арифметику;
 *   • обёртки над буфером (`sortLines`, `joinLines`, …) берут буфер и выделение и
 *     возвращают готовый `EditResult`: новый текст уже в буфере плюс описание правки
 *     для истории. Так же устроены остальные правки (`editing.ts`).
 *
 * Ни DOM, ни истории здесь нет: что записать в историю и когда уведомить представление,
 * решает контроллер.
 */

import { nextGraphemeBoundary, previousGraphemeBoundary, wordAt } from '../core/graphemes';
import type { TextChange } from '../core/history';
import type { TextBuffer } from '../core/text-buffer';
import { isEmpty, selectionEnd, selectionStart, type Selection } from '../view/selection';
import { convertCase, type CaseStyle } from './case-convert';
import type { EditResult } from './editing';

/** Как сортировать строки. */
export interface SortOptions {
  /** Учитывать регистр при сравнении (иначе `A` и `a` равны). */
  readonly caseSensitive?: boolean;
  /** По убыванию. */
  readonly reverse?: boolean;
  /** Убрать повторяющиеся строки (соседние после сортировки). */
  readonly unique?: boolean;
}

/* ── чистые функции: список строк → список строк ───────────────────────── */

/**
 * Отсортировать строки. Сравнение — числовое и без учёта регистра (если не просили
 * обратного): так `line2` идёт перед `line10`, а `Apple` и `apple` стоят рядом, а не
 * разъезжаются по разные концы списка.
 */
export function sortLineTexts(lines: readonly string[], options: SortOptions = {}): string[] {
  const collator = new Intl.Collator(undefined, {
    sensitivity: options.caseSensitive === true ? 'variant' : 'base',
    numeric: true,
  });
  const sorted = [...lines].sort((a, b) => collator.compare(a, b));
  if (options.reverse === true) sorted.reverse();
  return options.unique === true ? dedupe(sorted) : sorted;
}

/** Убрать соседние повторы (список уже отсортирован — значит, все повторы рядом). */
function dedupe(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (out.length > 0 && out[out.length - 1] === line) continue;
    out.push(line);
  }
  return out;
}

/**
 * Объединить строки в одну: с каждой снимаем краевые пробелы и склеиваем пробелом.
 * Пустые строки не оставляют двойных пробелов — «одна строка» выходит читаемой, а не
 * с дырами посреди.
 */
export function joinLineTexts(lines: readonly string[]): string {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ');
}

/* ── обёртки над буфером ───────────────────────────────────────────────── */

/** Ведущие пробелы и табы строки. */
function indentOf(text: string): string {
  return /^[\t ]*/.exec(text)?.[0] ?? '';
}

/** Первая и последняя строка выделения плюс смещения их содержимого. */
function lineBounds(
  buffer: TextBuffer,
  selection: Selection,
): { first: number; last: number; start: number; end: number } {
  const first = buffer.lineAt(selectionStart(selection));
  const last = buffer.lineAt(selectionEnd(selection));
  const start = buffer.lineStart(first);
  const end = buffer.lineStart(last) + buffer.lineText(last).length;
  return { first, last, start, end };
}

/** Заменить участок буфера и описать это правкой. */
function replace(buffer: TextBuffer, start: number, length: number, inserted: string): TextChange {
  const removed = buffer.replace(start, length, inserted);
  return { start, removed, inserted };
}

/** Заменить строки выделения на новый список строк, сохранив краевые переводы. */
function replaceLines(buffer: TextBuffer, first: number, last: number, lines: readonly string[]): EditResult {
  const start = buffer.lineStart(first);
  const lastText = buffer.lineText(last);
  const end = buffer.lineStart(last) + lastText.length;
  const change = replace(buffer, start, end - start, lines.join('\n'));
  const caret = start + change.inserted.length;
  return { selection: { anchor: caret, active: caret }, change };
}

/** Отсортировать строки выделения. `null` — строка одна, сортировать нечего. */
export function sortLines(buffer: TextBuffer, selection: Selection, options: SortOptions = {}): EditResult | null {
  const { first, last } = lineBounds(buffer, selection);
  if (last <= first) return null;
  const lines: string[] = [];
  for (let line = first; line <= last; line += 1) lines.push(buffer.lineText(line));
  const sorted = sortLineTexts(lines, options);
  return replaceLines(buffer, first, last, sorted);
}

/** Объединить строки выделения в одну. `null` — строка одна. */
export function joinLines(buffer: TextBuffer, selection: Selection): EditResult | null {
  const { first, last } = lineBounds(buffer, selection);
  if (last <= first) return null;
  const lines: string[] = [];
  for (let line = first; line <= last; line += 1) lines.push(buffer.lineText(line));
  const indent = indentOf(lines[0] ?? '');
  const joined = joinLineTexts(lines);
  return replaceLines(buffer, first, last, [joined.length > 0 ? indent + joined : indent]);
}

/**
 * Удалить строки выделения целиком — вместе с переводом строки. У последней строки
 * без завершающего перевода забираем перевод ПРЕДЫДУЩЕЙ: иначе от файла осталась бы
 * пустая строка там, где ничего не было.
 */
export function deleteLines(buffer: TextBuffer, selection: Selection): EditResult | null {
  const first = buffer.lineAt(selectionStart(selection));
  const last = buffer.lineAt(selectionEnd(selection));
  const start = buffer.lineStart(first);

  if (last < buffer.lineCount) {
    const end = buffer.lineStart(last + 1); // до начала следующей — с переводом строки
    const change = replace(buffer, start, end - start, '');
    const caret = Math.min(start, buffer.length);
    return { selection: { anchor: caret, active: caret }, change };
  }

  // Последняя строка (или строки) файла: забираем перевод ПЕРЕД первой из них.
  const from = first > 1 ? start - 1 : start;
  const end = buffer.lineStart(last) + buffer.lineText(last).length;
  const change = replace(buffer, from, end - from, '');
  const caret = Math.min(from, buffer.length);
  return { selection: { anchor: caret, active: caret }, change };
}

/** Вставить пустую строку НИЖЕ текущей, с тем же отступом; каретка — на новой строке. */
export function insertLineBelow(buffer: TextBuffer, selection: Selection): EditResult {
  const line = buffer.lineAt(selectionEnd(selection));
  const text = buffer.lineText(line);
  const indent = indentOf(text);
  const at = buffer.lineStart(line) + text.length;
  const change = replace(buffer, at, 0, `\n${indent}`);
  const caret = at + 1 + indent.length;
  return { selection: { anchor: caret, active: caret }, change };
}

/** Вставить пустую строку ВЫШЕ текущей, с тем же отступом; каретка — на новой строке. */
export function insertLineAbove(buffer: TextBuffer, selection: Selection): EditResult {
  const line = buffer.lineAt(selectionStart(selection));
  const indent = indentOf(buffer.lineText(line));
  const at = buffer.lineStart(line);
  const change = replace(buffer, at, 0, `${indent}\n`);
  const caret = at + indent.length;
  return { selection: { anchor: caret, active: caret }, change };
}

/**
 * Дублировать выделение или строку. Выделено — копия встаёт сразу за выделением (и
 * выделяется, чтобы её было видно); пусто — дублируется строка целиком вниз.
 */
export function duplicateSelection(buffer: TextBuffer, selection: Selection): EditResult | null {
  const start = selectionStart(selection);
  const end = selectionEnd(selection);
  if (start === end) {
    // Строку дублируем вниз, оставив каретку на копии.
    const line = buffer.lineAt(start);
    const lineStart = buffer.lineStart(line);
    const text = buffer.lineText(line);
    const blockEnd = lineStart + text.length;
    const change = replace(buffer, blockEnd, 0, `\n${text}`);
    const delta = text.length + 1;
    return { selection: { anchor: start + delta, active: end + delta }, change };
  }
  const text = buffer.getText(start, end);
  const change = replace(buffer, end, 0, text);
  return { selection: { anchor: end, active: end + text.length }, change };
}

/**
 * Переставить знак слева от каретки с тем, что справа (Transpose). В конце строки
 * меняются два последних знака — так привычнее, чем «ничего не делать». Работаем по
 * ГРАФЕМАМ: перестановка не должна разорвать эмодзи или составной знак.
 */
export function transposeAtCaret(buffer: TextBuffer, selection: Selection): EditResult | null {
  if (!isEmpty(selection)) return null;
  const line = buffer.lineAt(selection.active);
  const lineStart = buffer.lineStart(line);
  const text = buffer.lineText(line);
  let local = selection.active - lineStart;

  if (local >= text.length) {
    if (text.length === 0) return null;
    local = previousGraphemeBoundary(text, text.length);
  }
  const leftStart = previousGraphemeBoundary(text, local);
  const rightEnd = nextGraphemeBoundary(text, local);
  if (leftStart === local || rightEnd === local) return null;

  const left = text.slice(leftStart, local);
  const right = text.slice(local, rightEnd);
  const change = replace(buffer, lineStart + leftStart, rightEnd - leftStart, `${right}${left}`);
  const caret = lineStart + rightEnd;
  return { selection: { anchor: caret, active: caret }, change };
}

/**
 * Сменить регистр выделения (или слова под кареткой). `null` — менять нечего: нечего
 * выделять или текст уже в этом стиле.
 */
export function convertSelectionCase(buffer: TextBuffer, selection: Selection, style: CaseStyle): EditResult | null {
  let start = selectionStart(selection);
  let end = selectionEnd(selection);

  if (start === end) {
    const line = buffer.lineAt(start);
    const lineStart = buffer.lineStart(line);
    const word = wordAt(buffer.lineText(line), start - lineStart);
    if (!word) return null;
    start = lineStart + word.start;
    end = lineStart + word.end;
  }

  const original = buffer.getText(start, end);
  const converted = convertCase(original, style);
  if (converted === original) return null;

  const change = replace(buffer, start, original.length, converted);
  return { selection: { anchor: start, active: start + converted.length }, change };
}
