import { describe, expect, it } from 'vitest';
import {
  CURSOR_STYLES,
  CURSOR_STYLE_LABELS,
  MAX_LINE_HEIGHT,
  isCursorStyle,
  normalizeCursorStyle,
  normalizeLineHeight,
} from '../src/shared/cursor-style';

/**
 * Вид каретки и высота строки приходят из формы и из файла, который правят руками.
 * Проверяем приведение к известному: непонятное значение не должно ни ломать вид,
 * ни оставлять его пустым.
 */
describe('вид каретки', () => {
  it('известные виды — как есть, вид по умолчанию — полоска', () => {
    expect(normalizeCursorStyle('line')).toBe('line');
    expect(normalizeCursorStyle('block')).toBe('block');
    expect(normalizeCursorStyle('underline')).toBe('underline');
  });

  it('непонятное значение превращается в полоску, а не остаётся как есть', () => {
    expect(normalizeCursorStyle('жёлтый')).toBe('line');
    expect(normalizeCursorStyle(undefined)).toBe('line');
    expect(normalizeCursorStyle(42)).toBe('line');
    expect(normalizeCursorStyle(null)).toBe('line');
  });

  it('у каждого вида есть подпись, и список начинается с полоски', () => {
    expect(CURSOR_STYLES[0]).toBe('line');
    for (const style of CURSOR_STYLES) expect(CURSOR_STYLE_LABELS[style]).toBeTruthy();
  });

  it('isCursorStyle узнаёт свои значения и отвергает чужие', () => {
    expect(isCursorStyle('block')).toBe(true);
    expect(isCursorStyle('blocky')).toBe(false);
    expect(isCursorStyle(1)).toBe(false);
  });
});

describe('высота строки', () => {
  it('ноль и отрицательное — «по шрифту»', () => {
    expect(normalizeLineHeight(0)).toBe(0);
    expect(normalizeLineHeight(-5)).toBe(0);
    expect(normalizeLineHeight('0')).toBe(0);
  });

  it('число округляется, строка с числом принимается', () => {
    expect(normalizeLineHeight(21.6)).toBe(22);
    expect(normalizeLineHeight('18')).toBe(18);
  });

  it('слишком большая высота прижимается к пределу', () => {
    expect(normalizeLineHeight(10_000)).toBe(MAX_LINE_HEIGHT);
  });

  it('мусор читается как «по шрифту», а не как NaN', () => {
    expect(normalizeLineHeight(undefined)).toBe(0);
    expect(normalizeLineHeight('высоко')).toBe(0);
    expect(normalizeLineHeight({})).toBe(0);
  });
});
