import { describe, expect, it } from 'vitest';
import { stepUiScale, uiScaleLabel } from '../src/shared/ui-scale';

/**
 * Найдено разбором: масштаб оболочки менялся ТОЛЬКО списком в настройках.
 * Ни клавиш, ни подписи — а `Ctrl+=` в редакторе и настройках привычка мышечная,
 * и человека, у которого «буквы мелкие», такое отправляет искать окно настроек.
 */
describe('stepUiScale', () => {
  it('шаг вверх и вниз', () => {
    expect(stepUiScale(1, 1)).toBeGreaterThan(1);
    expect(stepUiScale(1, -1)).toBeLessThan(1);
  });

  it('сброс — всегда ровно 1', () => {
    // «Вернуть как было» — одно известное состояние, а не «примерно то, что
    // было при первом запуске».
    expect(stepUiScale(1.37, 0)).toBe(1);
  });

  it('на верхнем краю не меняется', () => {
    // Иначе Ctrl+= на максимуме молча переставлял бы значение на то же самое,
    // и человек считал бы, что клавиша сломалась.
    const top = stepUiScale(9.9, 1);
    expect(top).toBe(stepUiScale(top, 1));
  });

  it('на нижнем краю не меняется', () => {
    const bottom = stepUiScale(0.1, -1);
    expect(bottom).toBe(stepUiScale(bottom, -1));
  });

  it('мусор в значении не ломает шаг', () => {
    expect(Number.isFinite(stepUiScale(Number.NaN, 1))).toBe(true);
    expect(stepUiScale(Number.NaN, 0)).toBe(1);
  });

  it('шаг вверх и обратно возвращает к исходному', () => {
    const start = 1;
    const up = stepUiScale(start, 1);
    expect(stepUiScale(up, -1)).toBeCloseTo(start, 10);
  });
});

describe('uiScaleLabel', () => {
  it('доли — проценты', () => {
    expect(uiScaleLabel(1)).toBe('100 %');
    expect(uiScaleLabel(1.1)).toBe('110 %');
    expect(uiScaleLabel(0.8)).toBe('80 %');
  });

  it('значение вне ступеней приводится к ступени, а не рисуется как есть', () => {
    // `sanitizeUiScale` округляет до шага 0.1: иначе подпись показывала бы
    // «113 %», а применялось бы 110 % — окно настроек и клавиша разошлись бы.
    expect(uiScaleLabel(1.125)).toBe('110 %');
    expect(uiScaleLabel(1.16)).toBe('120 %');
  });
});
