import { describe, expect, it } from 'vitest';
import {
  segmentIndexForColumn,
  segmentsCover,
  splitsSurrogate,
  wrapCount,
  wrapSegments,
} from '../src/renderer/editor/view/wrap-model';
import { RowMap } from '../src/renderer/editor/view/row-map';

/** Раскладка моноширинной строки: каждый знак — клетка `charWidth`. */
function mono(text: string, charWidth = 10): number[] {
  return Array.from({ length: text.length + 1 }, (_, index) => index * charWidth);
}

describe('разбиение строки на отрезки переноса', () => {
  it('строка уже ширины — один отрезок', () => {
    const text = 'abc';
    const segments = wrapSegments(text, mono(text), 100);
    expect(segments).toEqual([{ startColumn: 0, endColumn: 3 }]);
    expect(wrapCount(text, mono(text), 100)).toBe(1);
  });

  it('выключенный перенос (ширина <= 0) — один отрезок на всю строку', () => {
    const text = 'abcdefgh';
    expect(wrapSegments(text, mono(text), 0)).toEqual([{ startColumn: 0, endColumn: 8 }]);
  });

  it('длинное слово режется по знакам, покрывая строку подряд', () => {
    const text = 'abcdefgh';
    const segments = wrapSegments(text, mono(text), 30);
    expect(segments).toEqual([
      { startColumn: 0, endColumn: 3 },
      { startColumn: 3, endColumn: 6 },
      { startColumn: 6, endColumn: 8 },
    ]);
    expect(segmentsCover(segments, text.length)).toBe(true);
  });

  it('перенос мягкий — по последнему пробелу внутри ширины', () => {
    const text = 'foo bar baz';
    const segments = wrapSegments(text, mono(text), 50);
    // «foo » (пробел в конце), «bar », «baz».
    expect(segments).toEqual([
      { startColumn: 0, endColumn: 4 },
      { startColumn: 4, endColumn: 8 },
      { startColumn: 8, endColumn: 11 },
    ]);
    expect(segmentsCover(segments, text.length)).toBe(true);
  });

  it('одно слово шире экрана — жёсткий перенос по знаку', () => {
    const text = 'a'.repeat(10);
    const segments = wrapSegments(text, mono(text), 30);
    expect(segments).toEqual([
      { startColumn: 0, endColumn: 3 },
      { startColumn: 3, endColumn: 6 },
      { startColumn: 6, endColumn: 9 },
      { startColumn: 9, endColumn: 10 },
    ]);
  });

  it('отрезки всегда покрывают строку целиком', () => {
    for (const width of [10, 25, 33, 100]) {
      const text = 'the quick brown fox jumps over the lazy dog';
      const segments = wrapSegments(text, mono(text), width);
      expect(segmentsCover(segments, text.length)).toBe(true);
      for (const segment of segments) expect(segment.endColumn).toBeGreaterThan(segment.startColumn);
    }
  });

  it('суррогатная пара не разрывается между половинами', () => {
    const text = 'a\u{1F600}b'; // «a», эмодзи (2 единицы UTF-16), «b»
    // Раскладка: эмодзи — широкая клетка; обе половины получают один x.
    const offsets = [0, 10, 30, 30, 40];
    for (const width of [10, 20, 30, 35, 40]) {
      const segments = wrapSegments(text, offsets, width);
      expect(splitsSurrogate(text, segments)).toBe(false);
      expect(segmentsCover(segments, text.length)).toBe(true);
    }
  });
});

describe('отрезок по столбцу', () => {
  const segments = [
    { startColumn: 0, endColumn: 3 },
    { startColumn: 3, endColumn: 6 },
    { startColumn: 6, endColumn: 8 },
  ];

  it('столбец внутри отрезка принадлежит ему', () => {
    expect(segmentIndexForColumn(segments, 0)).toBe(0);
    expect(segmentIndexForColumn(segments, 2)).toBe(0);
    expect(segmentIndexForColumn(segments, 3)).toBe(1);
    expect(segmentIndexForColumn(segments, 5)).toBe(1);
    expect(segmentIndexForColumn(segments, 7)).toBe(2);
  });

  it('столбец на конце строки — последний отрезок', () => {
    expect(segmentIndexForColumn(segments, 8)).toBe(2);
  });
});

describe('таблица визуальных рядов', () => {
  it('ряд строки — сумма рядов предыдущих строк', () => {
    const map = new RowMap();
    map.rebuild([3, 1, 2]);
    expect(map.rowTotal).toBe(6);
    expect(map.rowOf(1)).toBe(0);
    expect(map.rowOf(2)).toBe(3);
    expect(map.rowOf(3)).toBe(4);
    expect(map.countOf(1)).toBe(3);
  });

  it('строка и её ряд по номеру ряда', () => {
    const map = new RowMap();
    map.rebuild([3, 1, 2]);
    expect(map.lineAtRow(0)).toEqual({ line: 1, segment: 0 });
    expect(map.lineAtRow(2)).toEqual({ line: 1, segment: 2 });
    expect(map.lineAtRow(3)).toEqual({ line: 2, segment: 0 });
    expect(map.lineAtRow(4)).toEqual({ line: 3, segment: 0 });
    expect(map.lineAtRow(5)).toEqual({ line: 3, segment: 1 });
  });

  it('строка со счётчиком 0 (скрытая) пропускается', () => {
    const map = new RowMap();
    map.rebuild([1, 0, 1]);
    expect(map.rowTotal).toBe(2);
    expect(map.rowOf(3)).toBe(1);
    expect(map.lineAtRow(1)).toEqual({ line: 3, segment: 0 });
  });

  it('ряд за концами прижимается к ближайшему краю', () => {
    const map = new RowMap();
    map.rebuild([2, 2]);
    expect(map.lineAtRow(-5)).toEqual({ line: 1, segment: 0 });
    expect(map.lineAtRow(99)).toEqual({ line: 2, segment: 1 });
  });

  it('пустая таблица не падает', () => {
    const map = new RowMap();
    map.rebuild([]);
    expect(map.rowTotal).toBe(0);
    expect(map.lineAtRow(0)).toEqual({ line: 1, segment: 0 });
  });
});
