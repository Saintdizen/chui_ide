import { beforeEach, describe, expect, it } from 'vitest';
import { indentGuides, indentLevels, isBlank } from '../src/renderer/editor/view/indent-guides';
import { EditorView } from '../src/renderer/editor/view/editor-view';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { installMiniDom } from './helpers/mini-dom';

beforeEach(() => {
  installMiniDom();
});

/**
 * Направляющие отступов (TASKS 50).
 *
 * Было: ни одной линии отступа — отступ читался только по пробелам. Парные скобки
 * при этом уже были и безусловны, их проверять нечего.
 */

const opts = { indentSize: 4 };
// Раскладка идеальной монопсреды: каждый столбец — `charWidth`.
const flat = (columns: number): number[] => Array.from({ length: columns + 1 }, (_, i) => i * 8);

function xs(text: string, previous: string | null = null): number[] {
  return indentGuides(text, opts, flat(text.length), 8, previous).map((g) => g.x);
}

describe('глубина отступа', () => {
  it('пробелы по шагу, табуляция за шаг', () => {
    expect(indentLevels('x', opts)).toBe(0);
    expect(indentLevels('    x', opts)).toBe(1);
    expect(indentLevels('        x', opts)).toBe(2);
    expect(indentLevels('\tx', opts)).toBe(1);
    expect(indentLevels('\t\tx', opts)).toBe(2);
  });

  it('неполная ступень не считается', () => {
    expect(indentLevels('  x', opts)).toBe(0);
    expect(indentLevels('      x', opts)).toBe(1);
  });

  it('пустая строка — пустая', () => {
    expect(isBlank('      ')).toBe(true);
    expect(isBlank('  x')).toBe(false);
  });
});

describe('линии в строке', () => {
  it('без отступа линий нет', () => {
    expect(xs('const a = 1;')).toEqual([]);
  });

  it('одна ступень — одна линия в начале, две — две', () => {
    expect(xs('    a')).toEqual([0]);
    expect(xs('        a')).toEqual([0, 32]);
  });

  it('линия не встаёт в значащий текст', () => {
    // Отступ 8 пробелов, но текст кончается на 5-м столбце — линия второго уровня
    // перечёркнула бы код, её нет.
    expect(xs('     a')).toEqual([0]);
  });

  it('закрывающая скобка без своего отступа тянется к глубине предыдущей строки', () => {
    expect(xs('}', '        a')).toEqual([0, 32]);
    // Пустая строка внутри блока — линии на её глубине, а не по предыдущей строке.
    expect(xs('', '        a')).toEqual([0, 32]);
  });

  it('табуляция шире знака: линия берёт ширину столбца из раскладки', () => {
    // Таб разворачивается в ширину символа, если tabSize = 1.
    const offsets = flat(4);
    const guides = indentGuides('\ta', { indentSize: 1 }, offsets, 8, null);
    expect(guides).toEqual([{ x: 0 }]);
  });
});

describe('линии в отрисовке строки', () => {
  const METRICS = {
    charWidth: 8,
    lineHeight: 20,
    tabSize: 4,
    widthOf: () => 8,
  };

  function render(text: string) {
    const host = document.createElement('div') as unknown as HTMLElement;
    const view = new EditorView(host, new TextBuffer(text), { metrics: METRICS });
    const root = (host as unknown as { querySelector(s: string): any }).querySelector('.own-editor');
    const guidesIn = (row: number): { style: { left: string } }[] => {
      const line = root.querySelectorAll('.own-editor-line')[row];
      return line.querySelectorAll('.own-editor-indent-guide');
    };
    return { view, guidesIn };
  }

  it('глубина строки видна линиями на её уровне', () => {
    const { guidesIn } = render('if (a) {\n        b();\n}');
    expect(guidesIn(0).length).toBe(0);
    expect(guidesIn(1).length).toBe(2);
    expect(guidesIn(1).map((g: { style: { left: string } }) => g.style.left)).toEqual(['0px', '32px']);
  });

  it('закрывающая скобка держит глубину блока', () => {
    const { guidesIn } = render('if (a) {\n        b();\n}\nx = 1;');
    // `}` без отступа — линия второго уровня всё равно ведёт взгляд к блоку.
    expect(guidesIn(2).length).toBe(2);
  });
});
