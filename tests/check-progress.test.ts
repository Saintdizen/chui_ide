import { describe, expect, it } from 'vitest';
import { checkProgress } from '../src/renderer/ui/check-progress';

/**
 * Полоса проверки проекта в строке состояния.
 *
 * Главное правило — доля на полосе считается по шагам прохода, а не по «работе»:
 * середину шага не знает никто. Где шагов нет, чисел нет совсем — бежит штрих.
 */

describe('checkProgress: шаги вместо выдуманных процентов', () => {
  it('прохода нет — полосы нет', () => {
    expect(checkProgress(null).hidden).toBe(true);
  });

  it('все шаги впереди — полоса пуста, но идёт', () => {
    const view = checkProgress({ done: 0, total: 3, running: ['code', 'deps', 'python-deps'] });

    expect(view.hidden).toBe(false);
    expect(view.fill).toBe(0);
    expect(view.busy).toBe(true);
    expect(view.indeterminate).toBe(false);
    expect(view.label).toBe('проверяю: 0 из 3');
  });

  it('остался один шаг — называем его, а не считаем в уме', () => {
    const view = checkProgress({ done: 2, total: 3, running: ['code'] });

    expect(view.fill).toBeCloseTo(2 / 3);
    expect(view.label).toBe('проверяю: линтер');
    expect(view.title).toContain('2 из 3');
    expect(view.busy).toBe(true);
  });

  it('шагов нет (tsc неделим) — цифр нет нигде', () => {
    const view = checkProgress({ done: 0, total: 0, running: [] });

    expect(view.label).toBe('проверяю…');
    expect(view.indeterminate).toBe(true);
    expect(view.busy).toBe(true);
    expect(view.title).not.toMatch(/\d/);
  });

  it('все шаги позади — полоса полная, пульсации нет', () => {
    const view = checkProgress({ done: 3, total: 3, running: [] });

    expect(view.fill).toBe(1);
    expect(view.busy).toBe(false);
    expect(view.label).toBe('проверяю: 3 из 3');
  });

  it('сделанного больше, чем всего, — не врём больше ста процентов', () => {
    expect(checkProgress({ done: 9, total: 3, running: [] }).fill).toBe(1);
  });
});
