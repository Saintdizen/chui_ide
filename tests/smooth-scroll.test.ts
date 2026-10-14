import { describe, expect, it } from 'vitest';
import { SMOOTH_SCROLL_MS, easeOutCubic, scrollFinished, scrollStep } from '../src/renderer/editor/view/smooth-scroll';

/**
 * Плавная прокрутка — чистая кривая разгона. Время и кадры подаёт вид, поэтому
 * здесь проверяются только свойства: концы доходят ровно, движение монотонно и
 * всегда в сторону цели.
 */
describe('кривая разгона', () => {
  it('на концах — ровно 0 и 1', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it('за пределами отрезка прижимается к концам', () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });

  it('идёт вперёд: чем больше времени, тем дальше', () => {
    const samples = [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => easeOutCubic(t));
    for (let i = 1; i < samples.length; i += 1) expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
  });

  it('в начале быстрее, чем в конце (это и есть «мягкий конец»)', () => {
    // Первая половина пути проходится быстрее второй.
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});

describe('шаг прокрутки', () => {
  it('в начале — на месте, в конце — ровно в цели', () => {
    expect(scrollStep(0, 1000, 0)).toBe(0);
    expect(scrollStep(0, 1000, SMOOTH_SCROLL_MS)).toBe(1000);
    expect(scrollStep(0, 1000, SMOOTH_SCROLL_MS + 500)).toBe(1000);
  });

  it('движется в сторону цели и не перескакивает её', () => {
    const samples = [0, 20, 40, 60, 80, 100, 120].map((elapsed) => scrollStep(0, 1000, elapsed));
    for (const value of samples) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1000);
    }
    for (let i = 1; i < samples.length; i += 1) expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
  });

  it('прокрутка вверх — тот же ход', () => {
    expect(scrollStep(1000, 0, 0)).toBe(1000);
    expect(scrollStep(1000, 0, SMOOTH_SCROLL_MS)).toBe(0);
    expect(scrollStep(1000, 0, 60)).toBeLessThan(1000);
    expect(scrollStep(1000, 0, 60)).toBeGreaterThan(0);
  });

  it('нулевая длительность — мгновенно', () => {
    expect(scrollStep(0, 500, 0, 0)).toBe(500);
    expect(scrollStep(0, 500, 10, 0)).toBe(500);
  });
});

describe('окончание анимации', () => {
  it('заканчивается по времени, а не по месту', () => {
    expect(scrollFinished(SMOOTH_SCROLL_MS - 1)).toBe(false);
    expect(scrollFinished(SMOOTH_SCROLL_MS)).toBe(true);
    expect(scrollFinished(0, 0)).toBe(true);
  });
});
