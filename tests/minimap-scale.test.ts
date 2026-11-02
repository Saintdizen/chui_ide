import { describe, expect, it } from 'vitest';
import { minimapBar, minimapScale, minimapSlider, rowForMinimapY } from '../src/renderer/editor/view/minimap';

/**
 * Арифметика миникарты (`editor/view/minimap.ts`).
 *
 * Рисование — дело холста, но опасная часть здесь численная: сколько черт брать на
 * большом файле, какой высоты ползунок, в какую строку попадает клик. Ошибка тут
 * выглядит как «клик по карте отправляет не туда» и ловится только руками, поэтому
 * чистые функции проверяются отдельно от DOM.
 */

describe('соотношение строк и высоты карты', () => {
  it('файл короче высоты — строка выше пикселя, берём каждую', () => {
    const scale = minimapScale(10, 100);

    expect(scale.rowHeight).toBe(10);
    expect(scale.step).toBe(1);
  });

  it('файл в высоту — пиксель на строку', () => {
    expect(minimapScale(100, 100)).toEqual({ rowHeight: 1, step: 1 });
  });

  it('огромный файл — берём каждую n-ю строку', () => {
    // 100000 строк на 400px: строка файла — 1/250 пикселя.
    const scale = minimapScale(100_000, 400);

    expect(scale.step).toBe(250);
    // Черт порядка высоты карты: больше точек, чем пикселей, не рисуем.
    expect(Math.ceil(100_000 / scale.step)).toBeCloseTo(400, 0);
  });

  it('пустой файл и нулевая высота — нули, а не деление на ноль', () => {
    expect(minimapScale(0, 100)).toEqual({ rowHeight: 0, step: 1 });
    expect(minimapScale(100, 0)).toEqual({ rowHeight: 0, step: 1 });
    expect(Number.isFinite(minimapScale(0, 0).rowHeight)).toBe(true);
  });
});

describe('ползунок видимой части', () => {
  it('ползунок стоит там, где прокрутка', () => {
    expect(minimapSlider(50, 10, 100, 200)).toEqual({ top: 100, height: 20 });
  });

  it('у верха карты ползунок начинается с нуля', () => {
    expect(minimapSlider(0, 25, 100, 200)?.top).toBe(0);
  });

  it('слишком тонкий ползунок не бывает: мышью не поймать', () => {
    expect(minimapSlider(0, 10, 100_000, 400)?.height).toBeGreaterThanOrEqual(16);
  });

  it('у конца файла ползунок не вылезает за карту', () => {
    const slider = minimapSlider(99, 10, 100, 200);

    expect(slider?.top).toBeLessThanOrEqual(200);
    expect((slider?.top ?? 0) + (slider?.height ?? 0)).toBeLessThanOrEqual(200);
  });

  it('видимых строк больше, чем всего — ползунок во всю карту', () => {
    expect(minimapSlider(0, 50, 10, 200)).toEqual({ top: 0, height: 200 });
  });

  it('пустой файл и нулевая высота — ползунка нет', () => {
    expect(minimapSlider(0, 10, 0, 200)).toBeNull();
    expect(minimapSlider(0, 10, 100, 0)).toBeNull();
  });
});

describe('строка под точкой карты', () => {
  it('верх карты — первая строка', () => {
    expect(rowForMinimapY(0, 100, 200)).toBe(0);
  });

  it('середина — середина файла', () => {
    expect(rowForMinimapY(100, 100, 200)).toBe(50);
  });

  it('низ карты — последняя строка, а не строка за концом', () => {
    // Клик у самого низа не должен уводить в несуществующую строку.
    expect(rowForMinimapY(200, 100, 200)).toBe(99);
    expect(rowForMinimapY(500, 100, 200)).toBe(99);
  });

  it('отрицательное смещение — первая строка', () => {
    expect(rowForMinimapY(-10, 100, 200)).toBe(0);
  });

  it('пустой файл — строка 0', () => {
    expect(rowForMinimapY(50, 0, 200)).toBe(0);
  });
});

describe('черта строки на карте', () => {
  it('обычная строка идёт от нуля', () => {
    const bar = minimapBar('const a = 1;', 120);

    expect(bar?.x).toBe(0);
    expect(bar?.width).toBeCloseTo(12, 1);
  });

  it('отступ сдвигает черту вправо, а не растягивает', () => {
    const flat = minimapBar('x = 1', 120);
    const indented = minimapBar('        x = 1', 120);

    expect(indented?.x).toBeCloseTo(8, 1);
    expect(indented?.width).toBeCloseTo(flat?.width ?? 0, 1);
  });

  it('пробелы в конце не удлиняют черту', () => {
    const trailing = minimapBar('x = 1      ', 120);
    const plain = minimapBar('x = 1', 120);

    expect(trailing?.width).toBeCloseTo(plain?.width ?? 0, 5);
  });

  it('пустая строка и только пробелы — черты нет', () => {
    expect(minimapBar('', 120)).toBeNull();
    expect(minimapBar('     ', 120)).toBeNull();
  });

  it('строка длиннее карты обрезается по краю', () => {
    const bar = minimapBar('x'.repeat(500), 120);

    expect(bar?.x).toBe(0);
    expect(bar?.width).toBe(120);
  });

  it('отступ длиннее карты — черты нет', () => {
    // Рисовать нечего: видимая часть строки целиком за краем карты. Нулевая по
    // ширине черта была бы мусором в разметке на каждую такую строку.
    expect(minimapBar(`${' '.repeat(300)}x`, 120)).toBeNull();
  });
});
