import { describe, expect, it } from 'vitest';
import { LOGO_BASELINE, LOGO_HEIGHT, LOGO_RECTS, LOGO_STROKE, LOGO_WIDTH } from '../src/shared/logo';

/**
 * Геометрия знака общая для интерфейса (SVG) и значка окна (PNG). Тест держит
 * инварианты, от которых зависит и то, и другое: если прямоугольник вылезет за
 * решётку или получит нулевой размер, знак поедет — а заметить это глазами на
 * 25×16 единицах трудно.
 */
describe('логотип: геометрия знака', () => {
  it('размеры решётки заданы положительными', () => {
    expect(LOGO_WIDTH).toBeGreaterThan(0);
    expect(LOGO_HEIGHT).toBeGreaterThan(0);
    expect(LOGO_STROKE).toBeGreaterThan(0);
  });

  it('знак состоит из нескольких прямоугольников', () => {
    // Две буквы «i», подчёркивание и две скобки. Точное число — 15, но проверяем
    // «есть что рисовать», чтобы тест не падал от косметической правки формы.
    expect(LOGO_RECTS.length).toBeGreaterThanOrEqual(10);
  });

  it('у каждого прямоугольника конечные координаты и положительные размеры', () => {
    for (const rect of LOGO_RECTS) {
      expect(Number.isFinite(rect.x)).toBe(true);
      expect(Number.isFinite(rect.y)).toBe(true);
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
    }
  });

  it('ни один прямоугольник не выходит за решётку', () => {
    for (const rect of LOGO_RECTS) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(LOGO_WIDTH);
      expect(rect.y + rect.height).toBeLessThanOrEqual(LOGO_HEIGHT);
    }
  });

  it('скругление, если задано, не больше половины меньшей стороны', () => {
    for (const rect of LOGO_RECTS) {
      if (rect.rx === undefined) continue;
      expect(rect.rx).toBeGreaterThan(0);
      expect(rect.rx).toBeLessThanOrEqual(Math.min(rect.width, rect.height) / 2 + 1e-9);
    }
  });

  it('базовая линия лежит внутри высоты знака', () => {
    expect(LOGO_BASELINE).toBeGreaterThan(0);
    expect(LOGO_BASELINE).toBeLessThan(LOGO_HEIGHT);
  });
});
