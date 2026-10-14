import { describe, expect, it } from 'vitest';
import { matchScore } from '../src/renderer/editor/complete/fuzzy';

/** Совпало ли имя с набранным (без разбора оценки). */
const matches = (name: string, pattern: string): boolean => matchScore(name, pattern) !== null;

describe('совпадение с начала', () => {
  it('совпадает без учёта регистра', () => {
    expect(matches('value', 'val')).toBe(true);
    expect(matches('Value', 'val')).toBe(true);
    expect(matches('VALUE', 'val')).toBe(true);
  });

  it('совпадение по началу ценнее, чем по горбам', () => {
    const prefix = matchScore('myChoice', 'my')!;
    const humps = matchScore('modifyYear', 'my')!;
    expect(prefix.score).toBeGreaterThan(humps.score);
  });

  it('короткое имя при равном начале выше длинного', () => {
    expect(matchScore('format', 'form')!.score).toBeGreaterThan(matchScore('formatRow', 'form')!.score);
  });
});

describe('совпадение по «горбам» (camel-humps)', () => {
  it('gT находит getTitle', () => {
    expect(matches('getTitle', 'gT')).toBe(true);
    expect(matchScore('getTitle', 'gT')!.positions).toEqual([0, 3]);
  });

  it('обе заглавные находят MyClass', () => {
    const result = matchScore('MyClass', 'MC');
    expect(result).not.toBeNull();
    expect(result!.positions).toEqual([0, 2]);
  });

  it('строчная в набранном совпадает с заглавной в имени', () => {
    expect(matches('myClass', 'mc')).toBe(true);
  });

  it('граница слова после разделителя тоже считается горбом', () => {
    expect(matches('my_var', 'mv')).toBe(true);
    expect(matchScore('my_var', 'mv')!.positions).toEqual([0, 3]);
  });
});

describe('регистр в набранном', () => {
  it('заглавная требует заглавной ровно там же', () => {
    expect(matches('macOS', 'MC')).toBe(false);
    expect(matches('macOS', 'mO')).toBe(true);
    // Заглавная `C` в набранном ищет заглавную `C` в имени — её там нет.
    expect(matches('macOS', 'mC')).toBe(false);
  });

  it('строчная заглавной не запрещает', () => {
    expect(matches('MyClass', 'Mc')).toBe(true);
    expect(matches('MyClass', 'mc')).toBe(true);
  });
});

describe('отказ в совпадении', () => {
  it('порядок знаков важен: gT не находит Title', () => {
    expect(matches('getTitle', 'Tg')).toBe(false);
  });

  it('набранное длиннее имени не совпадает', () => {
    expect(matches('get', 'getTitle')).toBe(false);
  });

  it('знаки должны идти в том же порядке', () => {
    expect(matches('abc', 'acb')).toBe(false);
  });

  it('пустое набранное совпадает со всем (оценка нулевая)', () => {
    expect(matchScore('anything', '')).toEqual({ score: 0, positions: [] });
  });
});
