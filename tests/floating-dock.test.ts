import { describe, expect, it } from 'vitest';
import {
  FLOATING_MARGIN,
  FLOATING_MIN_HEIGHT,
  FLOATING_MIN_WIDTH,
  centeredFloating,
  clampFloating,
  dragFloating,
  resizeFloating,
} from '../src/shared/floating-dock';

/**
 * Геометрия плавающей панели. Главное: панель не уезжает за край окна и не
 * сжимается меньше полезного — иначе её нечем вернуть, кроме сброса.
 */
const viewport = { width: 1200, height: 800 };
const rect = { left: 100, top: 100, width: 500, height: 300 };

describe('centeredFloating', () => {
  it('ставит по центру окна', () => {
    const centered = centeredFloating(viewport);
    expect(centered.left).toBe(Math.round((1200 - centered.width) / 2));
    expect(centered.top).toBe(Math.round((800 - centered.height) / 2));
  });

  it('на маленьком окне не уезжает за край', () => {
    const centered = centeredFloating({ width: 400, height: 300 });
    expect(centered.left).toBeGreaterThanOrEqual(0);
    expect(centered.top).toBeGreaterThanOrEqual(0);
  });
});

describe('clampFloating', () => {
  it('не выпускает за правый и нижний край', () => {
    const clamped = clampFloating({ ...rect, left: 5000, top: 5000 }, viewport);
    expect(clamped.left).toBeLessThanOrEqual(1200 - FLOATING_MIN_WIDTH);
    expect(clamped.top).toBeLessThanOrEqual(800 - FLOATING_MIN_HEIGHT);
  });

  it('не даёт уйти в минус — ни левым, ни правым краем', () => {
    const clamped = clampFloating({ ...rect, left: -500, top: -500 }, viewport);
    expect(clamped.left).toBeGreaterThanOrEqual(0);
    expect(clamped.top).toBeGreaterThanOrEqual(0);
  });

  it('не сжимает меньше предела', () => {
    const clamped = clampFloating({ ...rect, width: 10, height: 10 }, viewport);
    expect(clamped.width).toBeGreaterThanOrEqual(FLOATING_MIN_WIDTH);
    expect(clamped.height).toBeGreaterThanOrEqual(FLOATING_MIN_HEIGHT);
  });

  it('годную панель не трогает', () => {
    expect(clampFloating(rect, viewport)).toEqual(rect);
  });
});

describe('dragFloating', () => {
  it('двигает на смещение', () => {
    expect(dragFloating(rect, { dx: 50, dy: -30 }, viewport)).toEqual({
      ...rect,
      left: 150,
      top: 70,
    });
  });

  it('размер не меняется — это перенос, а не растяжение', () => {
    const moved = dragFloating(rect, { dx: 9999, dy: 9999 }, viewport);
    expect(moved.width).toBe(rect.width);
    expect(moved.height).toBe(rect.height);
  });

  it('за краем прижимается, а не пропадает', () => {
    const moved = dragFloating(rect, { dx: -9999, dy: -9999 }, viewport);
    // Не вплотную к нулю: зазор в 8px, иначе окно, прижатое к краю, не
    // отличить от разделителя — за него и не взяться.
    expect(moved.left).toBe(FLOATING_MARGIN);
    expect(moved.top).toBe(FLOATING_MARGIN);
  });
});

describe('resizeFloating', () => {
  it('растёт на смещение', () => {
    const grown = resizeFloating(rect, { dx: 40, dy: 20 }, viewport);
    expect(grown.width).toBe(540);
    expect(grown.height).toBe(320);
  });

  it('не сжимается меньше предела — иначе ручки не найти', () => {
    const shrunk = resizeFloating(rect, { dx: -9999, dy: -9999 }, viewport);
    expect(shrunk.width).toBe(FLOATING_MIN_WIDTH);
    expect(shrunk.height).toBe(FLOATING_MIN_HEIGHT);
  });

  it('не вылезает за окно вправо и вниз', () => {
    const huge = resizeFloating(rect, { dx: 9999, dy: 9999 }, viewport);
    expect(huge.left + huge.width).toBeLessThanOrEqual(1200 - FLOATING_MARGIN + 0.5);
    expect(huge.top + huge.height).toBeLessThanOrEqual(800 - FLOATING_MARGIN + 0.5);
  });
});
