/**
 * Выделение: что закрашено и как это превратить в прямоугольники.
 *
 * Выделение у человека — это не «от» и «до», а ДВА КОНЦА: якорь (где нажали) и
 * активный конец (где сейчас). Важно, какой из них двигался: потянув выделение влево
 * за начало, человек ждёт, что начало поедет, а конец останется. Поэтому храним якорь
 * и активный конец, а не упорядоченную пару — порядок восстанавливаем на месте.
 * Пустое выделение (якорь совпал с активным) — это просто каретка.
 *
 * Рисует выделение не браузер, а представление: закрашивать текст фоном по знакам
 * заставило бы перерисовывать всю строку, а заливка поверх — дорога на каждый символ.
 * Поэтому выделение раскладывается на прямоугольники по строкам, и их немного: по
 * одному на строку, которую выделение задело. Строки за кадром прямоугольников не
 * получают.
 *
 * Смещения — те же единицы UTF-16, что и в модели текста. Модуль чистый: он только
 * читает строки из буфера и арифметику метрик, ничего не трогая.
 */

import type { TextBuffer } from '../core/text-buffer';
import type { GlyphMetrics } from './glyph-metrics';
import { layoutLine, xForColumn } from './line-layout';

/** Два конца выделения: где нажали (якорь) и где сейчас тянут (активный конец). */
export interface Selection {
  readonly anchor: number;
  readonly active: number;
}

/** Прямоугольник выделения в координатах полотна: слева и сверху — от начала документа. */
export interface SelectionRect {
  /** Индекс строки с нуля — по нему видно, к какой строке относится прямоугольник. */
  readonly line: number;
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** Выделение из одного смещения — точка. Так ставится каретка. */
export function caret(offset: number): Selection {
  return { anchor: offset, active: offset };
}

/** Меньший конец выделения — его начало. */
export function selectionStart(selection: Selection): number {
  return Math.min(selection.anchor, selection.active);
}

/** Больший конец выделения — его конец. */
export function selectionEnd(selection: Selection): number {
  return Math.max(selection.anchor, selection.active);
}

/** Выделена ли хоть одна позиция. Пустое — это каретка без заливки. */
export function isEmpty(selection: Selection): boolean {
  return selection.anchor === selection.active;
}

/**
 * Прямоугольники выделения по строкам. Прокрутка тут не учтена: координаты — от
 * начала документа, сдвиг на экран делает представление. Так функцию можно проверить
 * без окна и переиспользовать, когда появится миникарта или обзор файла.
 */
export function selectionRects(buffer: TextBuffer, selection: Selection, metrics: GlyphMetrics): SelectionRect[] {
  const start = selectionStart(selection);
  const end = selectionEnd(selection);
  if (start === end) return [];
  return rangesRects(buffer, [{ start, end }], metrics);
}

/**
 * Прямоугольники для набора диапазонов — тем же способом, что и выделение. Нужны
 * подсветке совпадений поиска: их рисуется сразу много, и правила раскладки должны
 * быть ровно те же, иначе совпадение на конце строки выглядело бы иначе, чем
 * выделение той же длины.
 */
export function rangesRects(
  buffer: TextBuffer,
  ranges: readonly { start: number; end: number }[],
  metrics: GlyphMetrics,
): SelectionRect[] {
  const rects: SelectionRect[] = [];
  for (const range of ranges) {
    if (range.end <= range.start) continue;
    const first = buffer.lineAt(range.start);
    const last = buffer.lineAt(range.end);
    for (let line = first; line <= last; line += 1) {
      const lineStart = buffer.lineStart(line);
      const text = buffer.lineText(line);
      const lineEnd = lineStart + text.length;
      const from = Math.max(range.start, lineStart);
      const to = Math.min(range.end, lineEnd);
      rects.push(...rangeRects(buffer, line, from, to, metrics, line < last));
    }
  }
  return rects;
}

/**
 * Прямоугольники одного участка внутри одной строки. `swallowBreak` — участок доходит
 * до конца строки и продолжается дальше: тогда к ширине добавляется полоска шириной в
 * знак, иначе выделение на конце строки выглядело бы обрезанным ровно по последнему знаку.
 */
function rangeRects(
  buffer: TextBuffer,
  line: number,
  from: number,
  to: number,
  metrics: GlyphMetrics,
  swallowBreak: boolean,
): SelectionRect[] {
  const lineStart = buffer.lineStart(line);
  const text = buffer.lineText(line);
  const offsets = layoutLine(text, metrics);
  const left = xForColumn(offsets, from - lineStart);
  let right = xForColumn(offsets, to - lineStart);
  if (swallowBreak) right += metrics.charWidth;

  const width = Math.max(right - left, 0);
  if (width <= 0) return [];
  return [{ line, top: (line - 1) * metrics.lineHeight, left, width, height: metrics.lineHeight }];
}
