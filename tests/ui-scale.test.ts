import { describe, expect, it } from 'vitest';
import { sanitizeUiScale, UI_SCALE_MAX, UI_SCALE_MIN, uiScaleOptions } from '../src/shared/ui-scale';

describe('sanitizeUiScale', () => {
  it('число в границах остаётся как есть', () => {
    expect(sanitizeUiScale(1)).toBe(1);
    expect(sanitizeUiScale(1.2)).toBe(1.2);
  });

  it('мусор и пустое дают единицу', () => {
    expect(sanitizeUiScale(undefined)).toBe(1);
    expect(sanitizeUiScale('abc')).toBe(1);
    expect(sanitizeUiScale(Number.NaN)).toBe(1);
    expect(sanitizeUiScale(0)).toBe(1);
    expect(sanitizeUiScale(-2)).toBe(1);
  });

  it('значения за границами поджимаются к ближайшей', () => {
    expect(sanitizeUiScale(5)).toBe(UI_SCALE_MAX);
    expect(sanitizeUiScale(0.1)).toBe(UI_SCALE_MIN);
  });

  it('строку из настроек тоже принимает', () => {
    expect(sanitizeUiScale('1.1')).toBe(1.1);
  });

  it('округляет до шага ступеней', () => {
    expect(sanitizeUiScale(1.07)).toBe(1.1);
    expect(sanitizeUiScale(1.04)).toBe(1);
  });
});

describe('uiScaleOptions', () => {
  it('идёт от минимума к максимуму с шагом', () => {
    const options = uiScaleOptions();
    const values = options.map((option) => Number(option.value));

    expect(values[0]).toBe(UI_SCALE_MIN);
    expect(values.at(-1)).toBe(UI_SCALE_MAX);
    expect(options).toHaveLength(Math.round((UI_SCALE_MAX - UI_SCALE_MIN) / 0.1) + 1);
  });

  it('подписи — проценты', () => {
    expect(uiScaleOptions().find((option) => option.value === '1')?.label).toBe('100 %');
  });
});
