import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { findBracketPair, findOccurrences } from '../src/renderer/editor/view/context-highlight';
import { caret } from '../src/renderer/editor/view/selection';

/** Тексты найденных вхождений — по ним видно, что подсветилось именно слово. */
function words(buffer: TextBuffer, selection: { anchor: number; active: number }): string[] {
  return findOccurrences(buffer, selection).map((range) => buffer.getText(range.start, range.end));
}

describe('вхождения слова под курсором', () => {
  it('находит целые слова и пропускает подстроки', () => {
    const buffer = new TextBuffer('value = value + valueCount');
    // `valueCount` не считается: справа от `value` там словный знак.
    expect(words(buffer, caret(1))).toEqual(['value', 'value']);
  });

  it('слово-подстрока не подхватывает вхождения соседа', () => {
    const buffer = new TextBuffer('const valueCount = 1;\nconst value = 2;');
    expect(words(buffer, caret(7))).toEqual(['valueCount']); // каретка внутри `valueCount`
  });

  it('подсвечивает вхождения выделенного текста', () => {
    const buffer = new TextBuffer('aa bb aa cc aa');
    expect(words(buffer, { anchor: 0, active: 2 })).toEqual(['aa', 'aa', 'aa']);
  });

  it('каретка сразу за словом берёт слово слева', () => {
    const buffer = new TextBuffer('total = total + 1');
    expect(words(buffer, caret(5))).toHaveLength(2); // каретка за первым `total`
  });

  it('на знаке без слова вхождений нет', () => {
    const buffer = new TextBuffer('a + b');
    expect(findOccurrences(buffer, caret(2))).toEqual([]);
  });

  it('длинное выделение вхождениями не подсвечивается', () => {
    const buffer = new TextBuffer('x'.repeat(200));
    expect(findOccurrences(buffer, { anchor: 0, active: 150 })).toEqual([]);
  });

  it('кириллица считается словом целиком', () => {
    const buffer = new TextBuffer('значение = значение + 1');
    expect(words(buffer, caret(1))).toEqual(['значение', 'значение']);
  });
});

describe('парные скобки', () => {
  it('находит пару для открывающей скобки под курсором', () => {
    const buffer = new TextBuffer('call(a, b)');
    const pair = findBracketPair(buffer, 4)!; // на `(`
    expect(pair.unmatched).toBe(false);
    expect(buffer.getText(pair.close.start, pair.close.end)).toBe(')');
  });

  it('каретка сразу за скобкой видит её слева', () => {
    const buffer = new TextBuffer('call(a, b)');
    const pair = findBracketPair(buffer, 5)!; // сразу за `(`
    expect(pair.unmatched).toBe(false);
    expect(pair.open.start).toBe(4);
  });

  it('учитывает вложенность', () => {
    const buffer = new TextBuffer('f(g(x), h(y))');
    const pair = findBracketPair(buffer, 1)!; // внешняя `(`
    expect(pair.close.start).toBe(12); // внешняя `)`
  });

  it('для закрывающей скобки ведёт назад к открывающей', () => {
    const buffer = new TextBuffer('f(g(x))');
    const pair = findBracketPair(buffer, 5)!; // внутренняя `)`
    expect(buffer.getText(pair.open.start, pair.open.end)).toBe('(');
    expect(pair.open.start).toBe(3);
  });

  it('фигурные и квадратные скобки тоже в паре', () => {
    expect(findBracketPair(new TextBuffer('{a: [b]}'), 0)!.unmatched).toBe(false);
    expect(findBracketPair(new TextBuffer('a = []'), 4)!.unmatched).toBe(false);
  });

  it('скобка без пары помечается сломанной', () => {
    const pair = findBracketPair(new TextBuffer('f(a, b'), 1)!;
    expect(pair.unmatched).toBe(true);
  });

  it('не скобка рядом — пары нет', () => {
    expect(findBracketPair(new TextBuffer('plain text'), 3)).toBeNull();
  });
});
