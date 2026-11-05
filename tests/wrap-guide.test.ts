import { describe, expect, it } from 'vitest';
import { indentColumnsOf, wrapGuideX } from '../src/renderer/editor/view/wrap-guide';

/**
 * «Мягкая» линейка переноса (TASKS 49).
 *
 * Перенос строк был, а отличить продолжение строки от новой строки того же блока
 * было нечем. Линейка ставится в колонке отступа, общей для всех отрезков строки.
 */

const OPTIONS = { charWidth: 8, tabSize: 4 };

describe('отступ строки в знаках', () => {
  it('пробелы считаются по одному', () => {
    expect(indentColumnsOf('    x', 4)).toBe(4);
  });

  it('табуляция идёт до следующей ступени, а не на один знак', () => {
    expect(indentColumnsOf('\tx', 4)).toBe(4);
    expect(indentColumnsOf('\t\tx', 4)).toBe(8);
  });

  it('табуляция после пробелов добивает до ступени', () => {
    // 2 пробела + таб при tabSize=4 — это 4, а не 2+4: иначе линейка уехала бы.
    expect(indentColumnsOf('  \tx', 4)).toBe(4);
    expect(indentColumnsOf('   \tx', 4)).toBe(4);
  });

  it('строка без отступа даёт нуль', () => {
    expect(indentColumnsOf('x', 4)).toBe(0);
    // Табуляция в служебной роли не считается отступом, только ведущая.
    expect(indentColumnsOf('x  y', 4)).toBe(0);
  });

  it('пустая строка и строка из одних пробелов — весь текст отступ', () => {
    expect(indentColumnsOf('', 4)).toBe(0);
    expect(indentColumnsOf('   ', 4)).toBe(3);
  });

  it('вырожденный tabSize не делит на ноль', () => {
    expect(indentColumnsOf('\tx', 0)).toBe(1);
    expect(indentColumnsOf('\tx', -3)).toBe(1);
  });
});

describe('место линейки', () => {
  it('стоит после отступа — на границе отступа и текста', () => {
    // 4 знака отступа по 8 px — линейка на 32.
    expect(wrapGuideX('    long text', 2, OPTIONS)).toBe(32);
  });

  it('у всех отрезков одной строки координата одна', () => {
    // Именно поэтому штрихи встают в одну колонку и видно, что ряды — одна строка.
    const text = '\tvalue';
    expect(wrapGuideX(text, 2, OPTIONS)).toBe(wrapGuideX(text, 3, OPTIONS));
  });

  it('без переноса линейки нет', () => {
    expect(wrapGuideX('    long text', 1, OPTIONS)).toBeNull();
    expect(wrapGuideX('    long text', 0, OPTIONS)).toBeNull();
  });

  it('без отступа линейки нет — иначе штрих лёг бы на первый знак', () => {
    expect(wrapGuideX('long text', 2, OPTIONS)).toBeNull();
  });

  it('пустая строка и одни пробелы линейки не получают', () => {
    expect(wrapGuideX('   ', 2, OPTIONS)).toBeNull();
    expect(wrapGuideX('', 2, OPTIONS)).toBeNull();
  });

  it('вырожденная ширина знака не даёт NaN в стиле', () => {
    // С NaN координата не применилась бы вовсе — штрих молча пропал бы.
    expect(wrapGuideX('    x', 2, { charWidth: 0, tabSize: 4 })).toBeNull();
    expect(wrapGuideX('    x', 2, { charWidth: Number.NaN, tabSize: 4 })).toBeNull();
    expect(wrapGuideX('    x', 2, { charWidth: -8, tabSize: 4 })).toBeNull();
  });
});
