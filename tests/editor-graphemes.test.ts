import { describe, expect, it } from 'vitest';
import {
  graphemeAt,
  graphemeBoundaries,
  hasSegmentation,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
  wordAt,
  wordSegments,
} from '../src/renderer/editor/core/graphemes';

const segmentation = hasSegmentation();

describe('Graphemes', () => {
  it('обычные символы — по одному на букву', () => {
    expect(graphemeBoundaries('abc')).toEqual([0, 1, 2, 3]);
    expect(previousGraphemeBoundary('abc', 2)).toBe(1);
    expect(nextGraphemeBoundary('abc', 2)).toBe(3);
  });

  it('суррогатная пара — один символ, а не два', () => {
    // «😀» — две единицы UTF-16.
    expect('😀'.length).toBe(2);
    expect(graphemeBoundaries('a😀b')).toEqual([0, 1, 3, 4]);
    expect(graphemeAt('a😀b', 1)).toEqual({ start: 1, end: 3 });
    expect(nextGraphemeBoundary('a😀b', 1)).toBe(3);
    expect(previousGraphemeBoundary('a😀b', 3)).toBe(1);
  });

  it.runIf(segmentation)('составной эмодзи с соединителями — один символ', () => {
    const family = '👨\u200d👩\u200d👧';
    expect(family.length).toBeGreaterThan(2);
    expect(graphemeBoundaries(`x${family}y`)).toEqual([0, 1, 1 + family.length, 2 + family.length]);
    expect(nextGraphemeBoundary(`x${family}y`, 1)).toBe(1 + family.length);
  });

  it.runIf(segmentation)('буква с комбинирующим знаком — один символ', () => {
    const composed = 'e\u0301';
    expect(composed.length).toBe(2);
    expect(graphemeBoundaries(composed)).toEqual([0, 2]);
    expect(previousGraphemeBoundary(composed, 2)).toBe(0);
  });

  it.runIf(segmentation)('флаг страны — один символ', () => {
    const flag = '🇷🇺';
    expect(flag.length).toBe(4);
    expect(graphemeBoundaries(flag)).toEqual([0, 4]);
  });

  it.runIf(segmentation)('эмодзи с тоном кожи — один символ', () => {
    const thumb = '👍🏽';
    expect(graphemeBoundaries(`a${thumb}`)).toEqual([0, 1, 1 + thumb.length]);
  });

  it('границы на концах текста не выходят за пределы', () => {
    expect(previousGraphemeBoundary('abc', 0)).toBe(0);
    expect(nextGraphemeBoundary('abc', 3)).toBe(3);
    expect(previousGraphemeBoundary('', 0)).toBe(0);
    expect(nextGraphemeBoundary('', 0)).toBe(0);
    // Смещение за пределами текста прижимается к концу.
    expect(nextGraphemeBoundary('abc', 99)).toBe(3);
  });

  it('слова и промежутки между ними', () => {
    const segments = wordSegments('привет, мир test2');
    const words = segments.filter((part) => part.isWordLike).map((part) => part.start);
    expect(words).toEqual([0, 8, 12]);
    expect(segments[0]).toMatchObject({ start: 0, end: 6, isWordLike: true });
  });

  it('слово под курсором и вне слова', () => {
    const text = 'hello world';
    expect(wordAt(text, 1)).toMatchObject({ start: 0, end: 5 });
    expect(wordAt(text, 7)).toMatchObject({ start: 6, end: 11 });
    // Пробел — не слово.
    expect(wordAt(text, 5)).toBeNull();
    expect(wordAt('', 0)).toBeNull();
  });

  it.runIf(segmentation)('кириллица распознаётся словом', () => {
    expect(wordAt('функция вызова', 2)).toMatchObject({ start: 0, end: 7 });
  });
});
