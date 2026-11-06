/**
 * П.29: свёртка знает о языке — недостающие куски.
 *
 * Свёртка по уровню и по блокам сервера уже была. Не было свёртки по выделению
 * и счётчика скрытых строк в заголовке свёрнутого блока.
 */
import { describe, expect, it } from 'vitest';
import { foldLabel, hiddenLineCount, selectionRegion } from '../src/renderer/core/fold-selection';

describe('свёртка по выделению', () => {
  it('выделение вниз — регион от начала до конца', () => {
    expect(selectionRegion(3, 10)).toEqual({ startLine: 3, endLine: 10 });
  });

  it('выделение вверх — тот же регион: порядок мыши не важен', () => {
    expect(selectionRegion(10, 3)).toEqual({ startLine: 3, endLine: 10 });
  });

  it('одна строка — не регион: скрылась бы целиком', () => {
    expect(selectionRegion(4, 4)).toBeNull();
  });

  it('не сворачиваем регион, который язык уже знает', () => {
    const known = [{ startLine: 3, endLine: 10 }];
    expect(selectionRegion(3, 10, known)).toBeNull();
    // Другой конец — это уже другой регион, его сложить можно.
    expect(selectionRegion(3, 12, known)).toEqual({ startLine: 3, endLine: 12 });
  });
});

describe('счётчик скрытых строк', () => {
  it('строка начала остаётся видимой, поэтому 10..20 — это 10 скрытых', () => {
    expect(hiddenLineCount({ startLine: 10, endLine: 20 })).toBe(10);
  });

  it('вырожденный регион ничего не прячет', () => {
    expect(hiddenLineCount({ startLine: 5, endLine: 5 })).toBe(0);
  });

  it('по-русски, а не «1 строк»', () => {
    expect(foldLabel(1)).toBe('⋯ 1 строка');
    expect(foldLabel(2)).toBe('⋯ 2 строки');
    expect(foldLabel(5)).toBe('⋯ 5 строк');
    expect(foldLabel(11)).toBe('⋯ 11 строк');
    expect(foldLabel(21)).toBe('⋯ 21 строка');
    expect(foldLabel(22)).toBe('⋯ 22 строки');
    expect(foldLabel(0)).toBe('');
  });
});
