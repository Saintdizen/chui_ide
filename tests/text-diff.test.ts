/**
 * П.35: место правки — чтобы открыть файл там, где она стоит.
 *
 * Карточка согласования уже открывала файл по клику, но ставила его на
 * прежнюю позицию курсора. Человек только что читал строки — и не находил их.
 */
import { describe, expect, it } from 'vitest';
import { changedSpan, firstChangedLine } from '../src/renderer/core/text-diff';

describe('место правки: первая изменённая строка', () => {
  it('замена посреди файла — та же строка, с которой разошлись', () => {
    expect(firstChangedLine(['a', 'b', 'c'], ['a', 'B', 'c'])).toBe(2);
  });

  it('вставка перед строкой — открываем эту строку, а не следующую', () => {
    expect(firstChangedLine(['a', 'b'], ['a', 'new', 'b'])).toBe(2);
  });

  it('дописать в конец — строка сразу за последней старой', () => {
    expect(firstChangedLine(['a'], ['a', 'b'])).toBe(2);
  });

  it('удалить голову файла — правка начинается с первой строки', () => {
    expect(firstChangedLine(['a', 'b'], ['b'])).toBe(1);
  });

  it('ничего не изменилось — ноль, а не первая строка', () => {
    expect(firstChangedLine([], [])).toBe(0);
    expect(firstChangedLine(['a'], ['a'])).toBe(0);
  });

  it('пустой файл → появился текст: первая строка', () => {
    expect(firstChangedLine([], ['a'])).toBe(1);
  });
});

describe('место правки: сколько строк затронуто', () => {
  it('общий префикс и хвост не считаются изменением', () => {
    expect(changedSpan(['a', 'b', 'c', 'd'], ['a', 'X', 'c', 'd'])).toEqual({
      from: 2,
      removedLines: 1,
      addedLines: 1,
    });
  });

  it('вставка без удаления: removedLines — ноль', () => {
    expect(changedSpan(['a'], ['a', 'b', 'c'])).toEqual({ from: 2, removedLines: 0, addedLines: 2 });
  });

  it('удаление без вставки: addedLines — ноль', () => {
    expect(changedSpan(['a', 'b', 'c'], ['a'])).toEqual({ from: 2, removedLines: 2, addedLines: 0 });
  });

  it('повторяющиеся строки в хвосте срезаются целиком', () => {
    expect(changedSpan(['a', 'x', 'a', 'a'], ['a', 'y', 'a', 'a'])).toEqual({
      from: 2,
      removedLines: 1,
      addedLines: 1,
    });
  });

  it('перестановка блоков без общих строк не выдумывает префикс', () => {
    expect(changedSpan(['a', 'b'], ['b', 'a'])).toEqual({ from: 1, removedLines: 2, addedLines: 2 });
  });
});
