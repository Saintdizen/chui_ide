import { describe, expect, it } from 'vitest';
import {
  isEmptySelection,
  normalizeSelection,
  selectionContains,
  selectionText,
} from '../src/renderer/terminal/core/selection';

/**
 * Выделение терминала: порядок точек, попадание клетки и сборка текста. Правило чистое,
 * проверяется без DOM. Главные случаи: тянуть можно в любую сторону, широкий знак держит
 * две клетки (по одной на столбец) и хвостовые пробелы/пустые строки не копируются.
 */

/** Столбцы строк: по записи на клетку, вторая половина широкого знака — пустая. */
const lines: Record<number, string[]> = {
  0: ['h', 'e', 'l', 'l', 'o'],
  1: ['w', 'o', 'r', 'l', 'd'],
  2: ['п', '', 'р', '', 'и'], // два широких знака — по две клетки каждый
};

const columnsAt = (row: number) => lines[row];

describe('normalizeSelection', () => {
  it('порядок точек не важен', () => {
    const forward = normalizeSelection({ row: 0, col: 1 }, { row: 1, col: 3 });
    const backward = normalizeSelection({ row: 1, col: 3 }, { row: 0, col: 1 });
    expect(forward).toEqual(backward);
    expect(forward.start).toEqual({ row: 0, col: 1 });
    expect(forward.end).toEqual({ row: 1, col: 3 });
  });

  it('в одной строке точки упорядочиваются по столбцу', () => {
    const range = normalizeSelection({ row: 0, col: 4 }, { row: 0, col: 1 });
    expect(range.start.col).toBe(1);
    expect(range.end.col).toBe(4);
  });
});

describe('isEmptySelection', () => {
  it('одна клетка — пусто', () => {
    expect(isEmptySelection(normalizeSelection({ row: 0, col: 2 }, { row: 0, col: 2 }))).toBe(true);
  });

  it('разные клетки — не пусто', () => {
    expect(isEmptySelection(normalizeSelection({ row: 0, col: 2 }, { row: 0, col: 3 }))).toBe(false);
  });
});

describe('selectionContains', () => {
  const range = normalizeSelection({ row: 0, col: 2 }, { row: 2, col: 1 });

  it('средняя строка выделена целиком', () => {
    expect(selectionContains(range, 0, 1)).toBe(true);
    expect(selectionContains(range, 4, 1)).toBe(true);
  });

  it('крайние строки — только от своей колонки', () => {
    expect(selectionContains(range, 1, 0)).toBe(false);
    expect(selectionContains(range, 2, 0)).toBe(true);
    expect(selectionContains(range, 1, 2)).toBe(true);
    expect(selectionContains(range, 2, 2)).toBe(false);
  });

  it('вне строк — нет', () => {
    expect(selectionContains(range, 0, 5)).toBe(false);
  });
});

describe('selectionText', () => {
  it('текст в пределах одной строки', () => {
    const range = normalizeSelection({ row: 1, col: 0 }, { row: 1, col: 2 });
    expect(selectionText(range, columnsAt)).toBe('wor');
  });

  it('несколько строк сшиваются переводом строки', () => {
    const range = normalizeSelection({ row: 0, col: 3 }, { row: 1, col: 2 });
    expect(selectionText(range, columnsAt)).toBe('lo\nwor');
  });

  it('широкий знак выделяется по клеткам целиком', () => {
    const range = normalizeSelection({ row: 2, col: 0 }, { row: 2, col: 3 });
    expect(selectionText(range, columnsAt)).toBe('пр');
  });

  it('половина широкого знака своей клетки не добавляет', () => {
    const range = normalizeSelection({ row: 2, col: 0 }, { row: 2, col: 1 });
    expect(selectionText(range, columnsAt)).toBe('п');
  });

  it('пустое выделение ничего не копирует', () => {
    expect(selectionText(normalizeSelection({ row: 0, col: 1 }, { row: 0, col: 1 }), columnsAt)).toBe('');
  });
});
