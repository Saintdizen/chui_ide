import { describe, expect, it } from 'vitest';
import { normalizeRulers, rulersToText } from '../src/shared/rulers';

/**
 * Приведение настройки направляющих к списку столбцов. Одна и та же настройка
 * приходит и массивом (из JSON), и строкой (из поля формы) — обе формы должны дать
 * один результат, иначе поведение зависело бы от того, как её задали.
 */
describe('normalizeRulers', () => {
  it('массив чисел проходит как есть, по возрастанию', () => {
    expect(normalizeRulers([120, 80])).toEqual([80, 120]);
  });

  it('строку «80, 120» разбирает так же, как массив', () => {
    expect(normalizeRulers('80, 120')).toEqual([80, 120]);
    expect(normalizeRulers('80 120')).toEqual([80, 120]);
    expect(normalizeRulers('  80 ,120 ')).toEqual([80, 120]);
  });

  it('повторы, дробные и мусор убираются', () => {
    expect(normalizeRulers([80, 80, 80.9, -5, 0, 'x', null])).toEqual([80]);
  });

  it('не-число и не строка — пустой список', () => {
    expect(normalizeRulers(undefined)).toEqual([]);
    expect(normalizeRulers(null)).toEqual([]);
    expect(normalizeRulers({})).toEqual([]);
  });

  it('пустая строка — пустой список', () => {
    expect(normalizeRulers('')).toEqual([]);
    expect(normalizeRulers('   ')).toEqual([]);
  });
});

describe('rulersToText', () => {
  it('обратен разбору строки', () => {
    expect(rulersToText([80, 120])).toBe('80, 120');
    expect(normalizeRulers(rulersToText([80, 120]))).toEqual([80, 120]);
  });
});
