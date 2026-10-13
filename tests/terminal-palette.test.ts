import { describe, expect, it } from 'vitest';
import { color256, colorToCss } from '../src/renderer/terminal/view/palette';

/**
 * Перевод цвета ячейки в значение CSS. Правило чистое (цвет → строка), проверяется без
 * экрана. Главные случаи: цвет по умолчанию не задаётся (его берут у корня), базовые
 * 16 номеров идут ссылкой на переменную темы, а 256-палитра и RGB — точным значением.
 */

describe('colorToCss', () => {
  it('цвет по умолчанию не задаётся — его берут у корня', () => {
    expect(colorToCss({ kind: 'default' })).toBeNull();
  });

  it('базовые 16 цветов идут переменной темы', () => {
    expect(colorToCss({ kind: 'palette', index: 0 })).toBe('var(--own-term-c0)');
    expect(colorToCss({ kind: 'palette', index: 15 })).toBe('var(--own-term-c15)');
  });

  it('цвета 256-палитры и RGB — точным значением', () => {
    expect(colorToCss({ kind: 'palette', index: 196 })).toMatch(/^#[0-9a-f]{6}$/);
    expect(colorToCss({ kind: 'rgb', r: 10, g: 20, b: 30 })).toBe('#0a141e');
  });
});

describe('color256', () => {
  it('начало куба 6×6×6 — чёрный, конец — белый', () => {
    expect(color256(16)).toBe('#000000');
    expect(color256(231)).toBe('#ffffff');
  });

  it('чистый красный в кубе', () => {
    expect(color256(196)).toBe('#ff0000');
  });

  it('серая шкала растёт от 232 к 255', () => {
    expect(color256(232)).toBe('#080808');
    expect(color256(255)).toBe('#eeeeee');
  });
});
