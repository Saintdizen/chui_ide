import { describe, expect, it } from 'vitest';
import { loosePositions, looseScore, matchScore } from '../src/shared/fuzzy';

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

/**
 * Вольный поиск — второй, для текста без регистра.
 *
 * Строгое правило требует горба после разрыва (`gT` → `getTitle`). Свёрнутое в
 * нижний регистр название горбов не имеет вовсе, поэтому к палитре и подсветке
 * дерева применяется оно: иначе `свн` в «свернуть все» не нашлось бы.
 */
describe('вольный поиск (без горбов)', () => {
  it('строгий отвергает, вольный находит', () => {
    expect(matchScore('свернуть все', 'свн')).toBeNull();
    // Позиции — жадно слева направо: `в` берётся в самом слове «свернуть».
    expect(loosePositions('свернуть все', 'свн')).toEqual([0, 1, 4]);
  });

  it('порядок знаков обязателен и здесь', () => {
    expect(loosePositions('свернуть', 'нрс')).toBeNull();
  });

  it('набранное длиннее имени не совпадает', () => {
    expect(loosePositions('да', 'дальше')).toBeNull();
  });

  it('оценка вольного: начало лучше, чем середина', () => {
    expect(looseScore('свернуть все', 'све')).toBeGreaterThan(looseScore('свернуть все', 'все'));
  });

  it('несовпадение — оценка минус бесконечность', () => {
    expect(looseScore('свернуть', 'ззз')).toBe(Number.NEGATIVE_INFINITY);
  });

  it('пустое набранное совпадает со всем', () => {
    expect(loosePositions('что угодно', '')).toEqual([]);
  });
});
