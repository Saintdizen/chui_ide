import { describe, expect, it } from 'vitest';
import { cellsOf, monospaceMetrics } from '../src/renderer/editor/view/glyph-metrics';
import { columnForX, layoutLine, lineWidth, xForColumn } from '../src/renderer/editor/view/line-layout';

/** Клетка 10 px, строка 20 px, табуляция 4 столбца (шаг 40 px). */
const metrics = monospaceMetrics(10, 20, 4);

describe('cellsOf', () => {
  it('обычный знак — одна клетка, иероглиф и эмодзи — две', () => {
    expect(cellsOf('a'.codePointAt(0)!)).toBe(1);
    expect(cellsOf('Я'.codePointAt(0)!)).toBe(1);
    expect(cellsOf('中'.codePointAt(0)!)).toBe(2);
    expect(cellsOf('😀'.codePointAt(0)!)).toBe(2);
  });

  it('комбинирующий знак и соединитель нулевой ширины клетки не занимают', () => {
    expect(cellsOf(0x0301)).toBe(0); // знак ударения
    expect(cellsOf(0x200d)).toBe(0); // ZWJ
    expect(cellsOf(0xfe0f)).toBe(0); // селектор начертания эмодзи
  });
});

describe('layoutLine', () => {
  it('обычная строка: x растёт по клетке на знак, ширина — число знаков на клетку', () => {
    const offsets = layoutLine('abc', metrics);
    expect(offsets).toEqual([0, 10, 20, 30]);
    expect(lineWidth(offsets)).toBe(30);
  });

  it('табуляция прыгает к следующему кратному столбцу, а не на одну клетку', () => {
    // «a» доводит x до 10, табуляция — до 40 (следующее кратное шагу 40).
    expect(layoutLine('a\tb', metrics)).toEqual([0, 10, 40, 50]);
    // Два таба подряд: 0→40→80.
    expect(layoutLine('\t\t', metrics)).toEqual([0, 40, 80]);
  });

  it('широкий знак занимает две клетки', () => {
    expect(layoutLine('中a', metrics)).toEqual([0, 20, 30]);
  });

  it('суррогатная пара — одна клетка на двух единицах UTF-16, массив монотонен', () => {
    // «😀» — широкая (две клетки, 20 px), занимает две единицы. Обе половины дают
    // один и тот же x: внутрь пары каретка не встаёт, но массив не должен падать.
    const offsets = layoutLine('😀a', metrics);
    expect(offsets).toEqual([0, 20, 20, 30]);
    for (let index = 1; index < offsets.length; index += 1) {
      expect(offsets[index]).toBeGreaterThanOrEqual(offsets[index - 1]);
    }
  });

  it('комбинирующий знак не расширяет строку', () => {
    // «е́» — буква плюс знак ударения: одна клетка, а не две.
    const offsets = layoutLine('e\u0301', metrics);
    expect(offsets).toEqual([0, 10, 10]);
    expect(lineWidth(offsets)).toBe(10);
  });
});

describe('xForColumn и columnForX', () => {
  const offsets = layoutLine('abc', metrics);

  it('x по столбцу, включая края', () => {
    expect(xForColumn(offsets, -1)).toBe(0);
    expect(xForColumn(offsets, 0)).toBe(0);
    expect(xForColumn(offsets, 2)).toBe(20);
    expect(xForColumn(offsets, 3)).toBe(30);
    expect(xForColumn(offsets, 99)).toBe(30);
  });

  it('столбец по x — ближайшая граница знака', () => {
    expect(columnForX(offsets, -5)).toBe(0);
    expect(columnForX(offsets, 0)).toBe(0);
    expect(columnForX(offsets, 4)).toBe(0); // 4 ближе к 0, чем к 10
    expect(columnForX(offsets, 6)).toBe(1); // 6 ближе к 10
    expect(columnForX(offsets, 10)).toBe(1);
    expect(columnForX(offsets, 100)).toBe(3);
  });

  it('при равном расстоянии к соседним границам выбирается левая', () => {
    // x=15 равноудалён от 10 и 20.
    expect(columnForX(offsets, 15)).toBe(1);
  });
});
