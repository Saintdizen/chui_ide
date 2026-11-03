import { describe, expect, it } from 'vitest';
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
