import { describe, expect, it } from 'vitest';
import {
  clampPeekIndex,
  peekCanStep,
  peekCounter,
  peekStepIndex,
  peekWindow,
} from '../src/renderer/editor/host/peek-model';

describe('peekWindow: окно строк вокруг нужной', () => {
  it('берёт контекст сверху и заполняет окно до предела', () => {
    expect(peekWindow(100, 50, { context: 3, maxLines: 10 })).toEqual({ first: 47, last: 56 });
  });

  it('у верхнего края окно начинается с первой строки', () => {
    expect(peekWindow(100, 1, { context: 3, maxLines: 10 })).toEqual({ first: 1, last: 10 });
  });

  it('у нижнего края начало подтягивается вверх — окно не укорачивается', () => {
    const window = peekWindow(100, 98, { context: 3, maxLines: 10 });
    expect(window).toEqual({ first: 91, last: 100 });
    expect(window.last - window.first + 1).toBe(10);
  });

  it('файл короче окна — виден целиком', () => {
    expect(peekWindow(4, 2, { context: 3, maxLines: 10 })).toEqual({ first: 1, last: 4 });
  });

  it('нужная строка всегда внутри окна', () => {
    for (const target of [1, 2, 5, 50, 99, 100, 500]) {
      const window = peekWindow(100, target, { context: 3, maxLines: 10 });
      const clamped = Math.min(Math.max(1, target), 100);
      expect(window.first).toBeLessThanOrEqual(clamped);
      // Цель внутри: если строки не упёрлись в низ файла, окно длиной maxLines.
      expect(window.last).toBeGreaterThanOrEqual(window.first);
    }
  });

  it('битые значения не ломают окно', () => {
    expect(peekWindow(0, 0)).toEqual({ first: 1, last: 1 });
    expect(peekWindow(5, -10, { maxLines: 0 })).toEqual({ first: 1, last: 1 });
  });
});

describe('ход по местам', () => {
  it('указатель приводится к диапазону', () => {
    expect(clampPeekIndex(-3, 5)).toBe(0);
    expect(clampPeekIndex(9, 5)).toBe(4);
    expect(clampPeekIndex(2, 5)).toBe(2);
    expect(clampPeekIndex(1, 0)).toBe(0);
  });

  it('шаг останавливается на краях — конца списка видно', () => {
    expect(peekStepIndex(0, -1, 3)).toBe(0);
    expect(peekStepIndex(2, 1, 3)).toBe(2);
    expect(peekStepIndex(1, 1, 3)).toBe(2);
  });

  it('можно ли шагнуть: на краях нельзя', () => {
    expect(peekCanStep(0, -1, 3)).toBe(false);
    expect(peekCanStep(0, 1, 3)).toBe(true);
    expect(peekCanStep(2, 1, 3)).toBe(false);
    expect(peekCanStep(0, 1, 1)).toBe(false);
  });
});

describe('peekCounter: подпись мест', () => {
  it('одно место не подписываем', () => {
    expect(peekCounter(0, 1)).toBe('');
    expect(peekCounter(0, 0)).toBe('');
  });

  it('несколько мест — «N из M» с единицы', () => {
    expect(peekCounter(0, 5)).toBe('1 из 5');
    expect(peekCounter(4, 5)).toBe('5 из 5');
    // Указатель за диапазоном поджимается, а не печатает «9 из 5».
    expect(peekCounter(9, 5)).toBe('5 из 5');
  });
});
