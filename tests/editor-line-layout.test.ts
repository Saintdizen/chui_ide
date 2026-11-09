import { describe, expect, it } from 'vitest';
import { cellsOf } from '../src/shared/text-width';
import { monospaceMetrics } from '../src/renderer/editor/view/glyph-metrics';
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

describe('вставки в строку (подсказки-вставки)', () => {
  it('вставка сдвигает всё, что за ней, и не трогает то, что до', () => {
    // Вставка шириной 50 на границе 1 (после «a») — знаки «bc» уезжают вправо.
    const offsets = layoutLine('abc', metrics, [{ column: 1, width: 50 }]);
    expect(offsets).toEqual([0, 10, 70, 80]);
    expect(lineWidth(offsets)).toBe(80);
  });

  it('вставка в конце строки растягивает её правый край', () => {
    const offsets = layoutLine('ab', metrics, [{ column: 2, width: 30 }]);
    // Граница конца строки — уже с хвостовой вставкой (каретка в конце встанет за ней).
    expect(offsets).toEqual([0, 10, 50]);
    // Правый край — уже с хвостовой вставкой.
    expect(lineWidth(offsets)).toBe(50);
  });

  it('табуляция после вставки прыгает с учётом её ширины', () => {
    // «a», вставка 15 px, затем «\t»: прыжок идёт от x=10+15=25 к кратному 40 — к 40.
    const offsets = layoutLine('a\tb', metrics, [{ column: 1, width: 15 }]);
    // offsets[1] — граница после «a» (10), вставка идёт до знака «\t».
    expect(offsets[1]).toBe(10);
    // После табуляции (x=40) и «b» — 50; суммарный правый край.
    expect(lineWidth(offsets)).toBe(50);
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
      expect(offsets[index]!).toBeGreaterThanOrEqual(offsets[index - 1]!);
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

  it('пустая строка: одна граница, попадание — столбец 0', () => {
    // Пустая строка — вырожденный случай: искать «ближайшую» границу не из чего.
    const empty = layoutLine('', metrics);
    expect(empty).toEqual([0]);
    expect(xForColumn(empty, 0)).toBe(0);
    expect(xForColumn(empty, 5)).toBe(0);
    expect(columnForX(empty, 0)).toBe(0);
    expect(columnForX(empty, 100)).toBe(0);
  });

  it('без вставок раскладка та же, что с пустым списком', () => {
    expect(layoutLine('abc', metrics, [])).toEqual(layoutLine('abc', metrics));
  });

  it('вставка в начале строки сдвигает первый же знак', () => {
    const offsets = layoutLine('ab', metrics, [{ column: 0, width: 25 }]);
    expect(offsets).toEqual([0, 35, 45]);
    expect(xForColumn(offsets, 1)).toBe(35);
  });

  it('две вставки на одной границе не складываются: на границе одна, вторая — после знака', () => {
    // Граница 1 — только ПЕРЕД знаком, вставки из неё не суммируются.
    const offsets = layoutLine('ab', metrics, [
      { column: 1, width: 20 },
      { column: 1, width: 15 },
    ]);
    expect(offsets).toEqual([0, 10, 55]);
  });

  it('широкий знак после вставки: вставка считается один раз, столбец — на две клетки', () => {
    const offsets = layoutLine('中a', metrics, [{ column: 0, width: 10 }]);
    expect(offsets).toEqual([0, 30, 40]);
  });

  it('комбинирующий знак не сдвигает следующую границу, но и не теряет её', () => {
    // Каретка внутри «е́» (между буквой и знаком) — та же позиция, что и до знака.
    const offsets = layoutLine('e\u0301x', metrics);
    expect(offsets).toEqual([0, 10, 10, 20]);
    expect(columnForX(offsets, 10)).toBe(2);
  });

  it('вставка на границе за концом строки не растягивает её', () => {
    // Сервер вправе прислать подсказку за последним знаком (column = 5 у строки из двух).
    // Ставить её некуда — но и уронить раскладку она не должна: строка остаётся прежней.
    const offsets = layoutLine('ab', metrics, [{ column: 5, width: 30 }]);
    expect(offsets).toEqual([0, 10, 20]);
  });

  it('отрицательный столбец вставки не ломает раскладку', () => {
    // Вставка «до начала» по смыслу равна вставке в начале: табулятор выходит из неё.
    const offsets = layoutLine('ab', metrics, [{ column: -1, width: 25 }]);
    expect(offsets).toEqual([0, 10, 20]);
  });
});
