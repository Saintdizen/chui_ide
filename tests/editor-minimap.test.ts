import { describe, expect, it } from 'vitest';
import { minimapBar, minimapScale, minimapSlider, rowForMinimapY } from '../src/renderer/editor/view/minimap';

/**
 * Арифметика миникарты: как строки файла ложатся на пиксели карты, где ползунок
 * видимой части и куда ведёт клик. Проверяется без DOM — этим функциям холст не нужен.
 */
describe('minimapScale', () => {
  it('мало строк — строка файла выше пикселя, берём каждую', () => {
    expect(minimapScale(10, 100)).toEqual({ rowHeight: 10, step: 1 });
  });

  it('ровно по пикселю на строку', () => {
    expect(minimapScale(100, 100)).toEqual({ rowHeight: 1, step: 1 });
  });

  it('много строк — строку тоньше пикселя не рисуем: берём каждую десятую', () => {
    expect(minimapScale(1000, 100)).toEqual({ rowHeight: 0.1, step: 10 });
  });

  it('пустой файл и нулевая высота — нули', () => {
    expect(minimapScale(0, 100)).toEqual({ rowHeight: 0, step: 1 });
    expect(minimapScale(100, 0)).toEqual({ rowHeight: 0, step: 1 });
  });
});

describe('minimapSlider', () => {
  it('видимая часть — пропорциональна и сдвинута на первую строку', () => {
    expect(minimapSlider(20, 5, 100, 1000)).toEqual({ top: 200, height: 50 });
  });

  it('у начала файла верх нулевой', () => {
    expect(minimapSlider(0, 10, 100, 1000)).toEqual({ top: 0, height: 100 });
  });

  it('слишком короткая видимая часть упирается в минимум', () => {
    expect(minimapSlider(0, 0.5, 100, 1000)?.height).toBe(16);
  });

  it('в конце файла ползунок не выходит за низ', () => {
    const slider = minimapSlider(100, 10, 100, 1000);
    expect(slider?.top).toBe(1000);
    expect(slider?.height).toBe(16);
  });

  it('пустой файл — ползунка нет', () => {
    expect(minimapSlider(0, 10, 0, 1000)).toBeNull();
  });
});

describe('rowForMinimapY', () => {
  it('середина карты — середина файла', () => {
    expect(rowForMinimapY(500, 100, 1000)).toBe(50);
  });

  it('края зажаты в границы файла', () => {
    expect(rowForMinimapY(-5, 100, 1000)).toBe(0);
    expect(rowForMinimapY(5000, 100, 1000)).toBe(99);
  });
});

describe('minimapBar', () => {
  it('черта идёт по видимой части строки, со сдвигом по отступу', () => {
    expect(minimapBar('  abc', 120)).toEqual({ x: 2, width: 3 });
  });

  it('строка без отступа начинается у левого края', () => {
    expect(minimapBar('abc', 120)).toEqual({ x: 0, width: 3 });
  });

  it('пустая строка и одни пробелы — черты нет', () => {
    expect(minimapBar('', 120)).toBeNull();
    expect(minimapBar('   ', 120)).toBeNull();
  });

  it('хвостовые пробелы в длину не входят', () => {
    expect(minimapBar('ab   ', 120)).toEqual({ x: 0, width: 2 });
  });
});
