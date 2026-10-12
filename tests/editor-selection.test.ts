import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { monospaceMetrics } from '../src/renderer/editor/view/glyph-metrics';
import {
  caret,
  columnSelections,
  isEmpty,
  selectionEnd,
  selectionRects,
  selectionStart,
} from '../src/renderer/editor/view/selection';

/** Клетка 10 px, строка 20 px, табуляция 4 столбца. */
const metrics = monospaceMetrics(10, 20, 4);

/**
 * Документ для проверок:
 *   1: "abc"    (смещения 0..3)
 *   2: "defgh"  (смещения 4..9)
 *   3: "ij"     (смещения 10..12)
 */
const buffer = new TextBuffer('abc\ndefgh\nij');

describe('концы выделения', () => {
  it('начало и конец не зависят от того, какой конец двигался', () => {
    expect(selectionStart({ anchor: 8, active: 1 })).toBe(1);
    expect(selectionEnd({ anchor: 8, active: 1 })).toBe(8);
    expect(selectionStart({ anchor: 1, active: 8 })).toBe(1);
    expect(selectionEnd({ anchor: 1, active: 8 })).toBe(8);
  });

  it('совпавшие концы — пустое выделение (каретка)', () => {
    expect(isEmpty(caret(5))).toBe(true);
    expect(isEmpty({ anchor: 5, active: 6 })).toBe(false);
  });
});

describe('прямоугольники выделения', () => {
  it('пустое выделение прямоугольников не даёт — каретка не залита', () => {
    expect(selectionRects(buffer, caret(2), metrics)).toEqual([]);
  });

  it('выделение внутри одной строки — один прямоугольник', () => {
    const rects = selectionRects(buffer, { anchor: 0, active: 2 }, metrics);
    expect(rects).toEqual([{ line: 1, top: 0, left: 0, width: 20, height: 20 }]);
  });

  it('выделение по двум строкам — по прямоугольнику на строку', () => {
    // От столбца 2 первой строки до столбца 5 второй.
    const rects = selectionRects(buffer, { anchor: 1, active: 8 }, metrics);
    expect(rects).toHaveLength(2);
    // Первая строка: от x=10 до конца текста (x=30) плюс полоска перевода строки.
    expect(rects[0]).toEqual({ line: 1, top: 0, left: 10, width: 30, height: 20 });
    // Вторая строка: от начала до столбца 4 (x=40).
    expect(rects[1]).toEqual({ line: 2, top: 20, left: 0, width: 40, height: 20 });
  });

  it('выделенный перевод строки показан полоской в ширину знака', () => {
    // Смещения 3 и 4 — сам разрыв между первой и второй строками.
    const rects = selectionRects(buffer, { anchor: 3, active: 4 }, metrics);
    expect(rects).toEqual([{ line: 1, top: 0, left: 30, width: 10, height: 20 }]);
  });

  it('порядок концов не влияет на прямоугольники', () => {
    const forward = selectionRects(buffer, { anchor: 1, active: 8 }, metrics);
    const reversed = selectionRects(buffer, { anchor: 8, active: 1 }, metrics);
    expect(reversed).toEqual(forward);
  });

  it('строки за концом выделения прямоугольников не получают', () => {
    const rects = selectionRects(buffer, { anchor: 0, active: 3 }, metrics);
    expect(rects.map((rect) => rect.line)).toEqual([1]);
  });
});

describe('блочное выделение по столбцу', () => {
  it('берёт по выделению на каждой строке между концами', () => {
    // От столбца 1 первой строки до столбца 3 третьей: строки 1..3.
    const selections = columnSelections(buffer, 1, 12);
    expect(selections).toEqual([
      { anchor: 1, active: 2 },
      { anchor: 5, active: 6 },
      { anchor: 11, active: 12 },
    ]);
  });

  it('короткая строка прижимается к своему концу', () => {
    // Якорь на второй строке в столбце 5, курсор на третьей в столбце 2.
    // Столбец 5 не влезает в третью строку «ij» (длина 2) — там берём её конец.
    const selections = columnSelections(buffer, 9, 12);
    expect(selections[1]).toEqual({ anchor: 12, active: 12 });
  });

  it('обратный порядок концов даёт те же строки', () => {
    const forward = columnSelections(buffer, 1, 12);
    const reversed = columnSelections(buffer, 12, 1);
    expect(reversed).toHaveLength(forward.length);
    expect(reversed.map((sel) => selectionStart(sel))).toEqual(forward.map((sel) => selectionStart(sel)));
  });

  it('выделение в одной строке — обычное', () => {
    expect(columnSelections(buffer, 0, 3)).toEqual([{ anchor: 0, active: 3 }]);
  });
});
