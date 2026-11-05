import { describe, expect, it } from 'vitest';
import { EDITOR_FONT_MAX, EDITOR_FONT_MIN } from '../src/shared/editor-font-scale';
import { parseFieldNumber } from '../src/renderer/ui/number-field';

describe('parseFieldNumber', () => {
  it('пустое поле — не ноль, а повод сказать', () => {
    expect(parseFieldNumber('', 1, 100)).toEqual({ ok: false, hint: 'Ожидалось число' });
    expect(parseFieldNumber('   ', 1, 100).ok).toBe(false);
  });

  it('мусор не превращается в минимум', () => {
    expect(parseFieldNumber('12abc', 1, 100).ok).toBe(false);
    expect(parseFieldNumber('--', 0, 100).ok).toBe(false);
    expect(parseFieldNumber('NaN', 0, 100).ok).toBe(false);
  });

  it('обычное число, с пробелами и запятой', () => {
    expect(parseFieldNumber(' 12 ', 1, 100)).toEqual({ ok: true, value: 12 });
    expect(parseFieldNumber('2,5', 0, 10)).toEqual({ ok: true, value: 2.5 });
  });

  it('вне границ — подсказка с границами', () => {
    expect(parseFieldNumber('5', 10, 100)).toEqual({
      ok: false,
      hint: 'Ожидалось число от 10 до 100',
    });
    expect(parseFieldNumber('500', 10, 100).ok).toBe(false);
  });
});

describe('пределы кегля в поле формы (TASKS 51)', () => {
  /**
   * Поле «Размер шрифта» держало зашитые 8..32, а `Ctrl+=`/`Ctrl+-` и колесо —
   * общие 6..72 из `shared/editor-font-scale.ts`. Одна настройка, два предела:
   * клавишами кегль доходил до 72, а поле отказывалось его показать.
   */
  it('границы для кегля — общие, из editor-font-scale', () => {
    // Те же числа, что у клавиш: проверяем, что импорт даёт то же правило,
    // а не копию, которая разойдётся при следующей правке.
    expect(EDITOR_FONT_MIN).toBe(6);
    expect(EDITOR_FONT_MAX).toBe(72);
  });

  it('поле принимает верхнюю границу клавиш', () => {
    // Было `{ ok: false, hint: 'Ожидалось число от 8 до 32' }` для 72 — то есть
    // значение, которое сама IDE только что поставила клавишей.
    expect(parseFieldNumber('72', EDITOR_FONT_MIN, EDITOR_FONT_MAX)).toEqual({ ok: true, value: 72 });
  });

  it('поле принимает нижнюю границу клавиш', () => {
    expect(parseFieldNumber('6', EDITOR_FONT_MIN, EDITOR_FONT_MAX)).toEqual({ ok: true, value: 6 });
  });

  it('прежние границы 8..32 больше не предел', () => {
    expect(parseFieldNumber('33', EDITOR_FONT_MIN, EDITOR_FONT_MAX).ok).toBe(true);
    expect(parseFieldNumber('7', EDITOR_FONT_MIN, EDITOR_FONT_MAX).ok).toBe(true);
  });

  it('за границей клавиш поле всё ещё отказывает', () => {
    expect(parseFieldNumber('73', EDITOR_FONT_MIN, EDITOR_FONT_MAX)).toEqual({
      ok: false,
      hint: 'Ожидалось число от 6 до 72',
    });
    expect(parseFieldNumber('5', EDITOR_FONT_MIN, EDITOR_FONT_MAX).ok).toBe(false);
  });
});
