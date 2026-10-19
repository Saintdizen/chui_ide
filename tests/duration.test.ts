import { describe, expect, it } from 'vitest';
import { formatCallTime } from '../src/shared/duration';

/**
 * Время вызова инструмента в карточке.
 *
 * Число нужно, чтобы отличать «прочитал файл» от «собрал проект». Дробные доли
 * секунды на глаз — шум, а долгие вызовы должны читаться минутами: «5 мин 24 с»
 * понятнее, чем «324,3 с».
 */

describe('formatCallTime', () => {
  it('до секунды — миллисекунды', () => {
    expect(formatCallTime(34)).toBe('34 мс');
    expect(formatCallTime(999)).toBe('999 мс');
  });

  it('до минуты — секунды с одной десятой', () => {
    expect(formatCallTime(1000)).toBe('1.0 с');
    expect(formatCallTime(1240)).toBe('1.2 с');
    expect(formatCallTime(59_400)).toBe('59.4 с');
  });

  it('дольше минуты — минуты и секунды', () => {
    expect(formatCallTime(60_000)).toBe('1 мин');
    expect(formatCallTime(324_000)).toBe('5 мин 24 с');
    // Округление секунд до 60 не должно давать «1 мин 60 с».
    expect(formatCallTime(119_700)).toBe('2 мин');
  });

  it('вырожденные значения не превращаются в текст', () => {
    expect(formatCallTime(0)).toBe('0 мс');
    expect(formatCallTime(-5)).toBe('');
    expect(formatCallTime(Number.NaN)).toBe('');
  });
});
