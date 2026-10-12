import { describe, expect, it } from 'vitest';
import { booleanArg, describeValue, integerArg, isAbsent, numericArg } from '../src/shared/tool-args';

/**
 * Разбор аргументов инструментов: модель присылает их не всегда так, как их
 * описывает схема.
 *
 * Поводом была живая ошибка: `read_file` с `startLine: "2"` не читал вторую
 * строку — аргумент отбрасывался как «не число», и инструмент отдавал файл
 * ЦЕЛИКОМ. Молчаливый промах хуже громкого отказа, поэтому здесь и проверяется
 * граница: что принимаем терпимо, а что обязаны назвать ошибкой.
 */
describe('numericArg', () => {
  it('число проходит как есть', () => {
    expect(numericArg(2)).toBe(2);
    expect(numericArg(0)).toBe(0);
    expect(numericArg(-3)).toBe(-3);
    expect(numericArg(2.5)).toBe(2.5);
  });

  it('строка с числом — тоже число', () => {
    expect(numericArg('2')).toBe(2);
    expect(numericArg(' 12 ')).toBe(12);
    expect(numericArg('2.5')).toBe(2.5);
  });

  it('мусор и пустое — undefined', () => {
    expect(numericArg('abc')).toBeUndefined();
    expect(numericArg('')).toBeUndefined();
    expect(numericArg('   ')).toBeUndefined();
    expect(numericArg(undefined)).toBeUndefined();
    expect(numericArg(null)).toBeUndefined();
    expect(numericArg(true)).toBeUndefined();
    expect(numericArg({})).toBeUndefined();
  });

  it('бесконечность и NaN — не число', () => {
    expect(numericArg(Number.NaN)).toBeUndefined();
    expect(numericArg(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe('integerArg', () => {
  it('целое из числа и из строки', () => {
    expect(integerArg(2)).toBe(2);
    expect(integerArg('2')).toBe(2);
  });

  it('дробное — не номер строки', () => {
    // 2.5 как «начало диапазона» — бессмыслица; лучше отказ, чем чтение с первой строки.
    expect(integerArg(2.5)).toBeUndefined();
    expect(integerArg('2.5')).toBeUndefined();
  });
});

describe('booleanArg', () => {
  it('принимает и слово, и строку, и единицу', () => {
    expect(booleanArg(true)).toBe(true);
    expect(booleanArg('true')).toBe(true);
    expect(booleanArg(' TRUE ')).toBe(true);
    expect(booleanArg(1)).toBe(true);
    expect(booleanArg('1')).toBe(true);
  });

  it('«нет» тоже распознаётся', () => {
    expect(booleanArg(false)).toBe(false);
    expect(booleanArg('false')).toBe(false);
    expect(booleanArg(0)).toBe(false);
    expect(booleanArg('0')).toBe(false);
  });

  it('прочее — undefined, а не «ложь»: вызывающий сам решает', () => {
    expect(booleanArg('да')).toBeUndefined();
    expect(booleanArg(undefined)).toBeUndefined();
    expect(booleanArg({})).toBeUndefined();
  });
});

describe('isAbsent', () => {
  it('отсутствие — это undefined, null и пустая строка', () => {
    expect(isAbsent(undefined)).toBe(true);
    expect(isAbsent(null)).toBe(true);
    expect(isAbsent('  ')).toBe(true);
  });

  it('значение отличимо от отсутствия', () => {
    expect(isAbsent(0)).toBe(false);
    expect(isAbsent(false)).toBe(false);
    expect(isAbsent('2')).toBe(false);
    expect(isAbsent([])).toBe(false);
  });
});

describe('describeValue', () => {
  it('строку показывает в кавычках и подрезает', () => {
    expect(describeValue('abc')).toBe('«abc»');
    expect(describeValue('  мно го  ')).toBe('«мно го»');
    expect(describeValue('x'.repeat(100)).length).toBeLessThanOrEqual(42);
  });

  it('остальное называет по виду', () => {
    expect(describeValue(2.5)).toBe('2.5');
    expect(describeValue(undefined)).toBe('ничего');
    expect(describeValue(null)).toBe('null');
    expect(describeValue([])).toBe('массив');
    expect(describeValue({})).toBe('объект');
  });
});
