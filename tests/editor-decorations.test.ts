import { describe, expect, it } from 'vitest';
import { monospaceMetrics } from '../src/renderer/editor/view/glyph-metrics';
import { layoutLine } from '../src/renderer/editor/view/line-layout';
import { FileDecorations, squigglyRect, type SquigglyDecoration } from '../src/renderer/editor/view/decorations';

/** Клетка 10 px, строка 20 px, табуляция 4 столбца. */
const metrics = monospaceMetrics(10, 20, 4);

describe('хранилище украшений', () => {
  it('находит украшение по строке', () => {
    const decorations = new FileDecorations();
    decorations.setGlyphs([{ line: 3, className: 'breakpoint-glyph' }]);
    decorations.setStrips([{ line: 5, className: 'change-gutter is-added' }]);
    decorations.setLineBackgrounds([{ line: 2, className: 'coverage-line' }]);
    decorations.setAfterContents([{ line: 1, content: '  Иван', className: 'blame-inline' }]);

    expect(decorations.glyphFor(3)?.className).toBe('breakpoint-glyph');
    expect(decorations.glyphFor(4)).toBeUndefined();
    expect(decorations.stripFor(5)?.className).toBe('change-gutter is-added');
    expect(decorations.backgroundFor(2)?.className).toBe('coverage-line');
    expect(decorations.afterFor(1)?.content).toBe('  Иван');
  });

  it('одно украшение на строку: последнее в наборе затирает прежнее', () => {
    const decorations = new FileDecorations();
    decorations.setGlyphs([
      { line: 7, className: 'breakpoint-glyph' },
      { line: 7, className: 'run-glyph' },
    ]);
    expect(decorations.glyphFor(7)?.className).toBe('run-glyph');
  });

  it('подчёркивания хранятся списком: под строкой их бывает несколько', () => {
    const decorations = new FileDecorations();
    const items: SquigglyDecoration[] = [
      { line: 2, startColumn: 1, endColumn: 3, className: 'is-error' },
      { line: 2, startColumn: 6, endColumn: 8, className: 'is-warning' },
    ];
    decorations.setSquiggles(items);
    expect(decorations.squigglesFor(2)).toHaveLength(2);
    expect(decorations.squigglesFor(3)).toEqual([]);
  });

  it('пустой набор — пусто', () => {
    const decorations = new FileDecorations();
    expect(decorations.isEmpty).toBe(true);
    decorations.setGlyphs([{ line: 1, className: 'run-glyph' }]);
    expect(decorations.isEmpty).toBe(false);
  });
});

describe('геометрия волнистого подчёркивания', () => {
  // Строка "abcdef" — шесть клеток по 10 px.
  const offsets = layoutLine('abcdef', metrics);

  it('одна буква — ширина клетки', () => {
    // Столбцы с единицы, конец исключительный: 5..6 — буква на 5-м месте.
    expect(squigglyRect(offsets, 1, 5, 6, metrics)).toEqual({ left: 40, top: 0, width: 10, height: 20 });
  });

  it('строка ниже — со сдвигом по вертикали', () => {
    expect(squigglyRect(offsets, 3, 1, 3, metrics)).toEqual({ left: 0, top: 40, width: 20, height: 20 });
  });

  it('конец за концом строки прижимается к её краю', () => {
    // Многострочная пометка приходит с огромным концом — подчёркиваем до конца строки.
    const rect = squigglyRect(offsets, 1, 3, Number.MAX_SAFE_INTEGER, metrics);
    expect(rect.left).toBe(20);
    expect(rect.width).toBe(40);
  });

  it('пустой участок — нулевая ширина', () => {
    expect(squigglyRect(offsets, 1, 3, 3, metrics).width).toBe(0);
  });
});
