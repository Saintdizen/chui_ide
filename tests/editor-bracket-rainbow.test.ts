import { describe, expect, it } from 'vitest';
import { BracketDepth, bracketMarks } from '../src/renderer/editor/view/bracket-rainbow';
import { COMMENT, STRING, type Token } from '../src/renderer/editor/highlight/tokens';

/**
 * Радужные скобки: уровень вложенности скобок и вложенность строки на выходе.
 * Правило чистое (текст + токены), поэтому проверяется без окна. Главные случаи:
 * вложенность растёт и падает, строки/комментарии не считаются, а вложенность
 * переносится на строку ниже.
 */

const NONE: readonly Token[] = [];

describe('bracketMarks', () => {
  it('уровни растут на открывающих и падают на закрывающих', () => {
    // f(a[b])
    const { marks, endDepth } = bracketMarks('f(a[b])', 0, NONE);
    expect(marks.map((mark) => [mark.start, mark.depth])).toEqual([
      [1, 0], // ( — уровень 0
      [3, 1], // [ — вложен внутрь ( → уровень 1
      [5, 1], // ]
      [6, 0], // )
    ]);
    expect(endDepth).toBe(0);
  });

  it('вложенность в начале строки переносится на её скобки', () => {
    // Строка начинается на уровне 2 и сразу закрывает — уровень падает до 1.
    const { marks, endDepth } = bracketMarks('  )', 2, NONE);
    expect(marks).toEqual([{ start: 2, depth: 1 }]);
    expect(endDepth).toBe(1);
  });

  it('вложенность не уходит ниже нуля на лишних закрывающих', () => {
    const { marks, endDepth } = bracketMarks(')))', 0, NONE);
    expect(marks.map((mark) => mark.depth)).toEqual([0, 0, 0]);
    expect(endDepth).toBe(0);
  });

  it('скобки внутри строк не считаются', () => {
    // x("a)b") — закрывающая внутри строки не должна трогать вложенность.
    const tokens: Token[] = [{ start: 2, end: 7, type: STRING }];
    const { marks, endDepth } = bracketMarks('x("a)b")', 0, tokens);
    expect(marks.map((mark) => [mark.start, mark.depth])).toEqual([
      [1, 0], // ( вне строки
      [7, 0], // ) вне строки
    ]);
    expect(endDepth).toBe(0);
  });

  it('комментарий глушит скобки так же, как строка', () => {
    const tokens: Token[] = [{ start: 0, end: 5, type: COMMENT }];
    const { marks } = bracketMarks('// (a', 0, tokens);
    expect(marks).toEqual([]);
  });
});

describe('BracketDepth', () => {
  it('ведёт вложенность по строкам', () => {
    const lines = ['def f():', '    g(1)', '    return [2]'];
    const depth = new BracketDepth(
      (line) => lines[line] ?? '',
      () => NONE,
    );
    // Ничто не раскрыто через строки — везде уровень 0; в каждой строке по паре скобок.
    expect(depth.marksFor(0).map((mark) => mark.depth)).toEqual([0, 0]);
    expect(depth.marksFor(1).map((mark) => mark.depth)).toEqual([0, 0]);
    expect(depth.marksFor(2).map((mark) => mark.depth)).toEqual([0, 0]);
  });

  it('вложенность из строки продолжается ниже, даже после сдвига строк', () => {
    const src = ['(', 'x', ')'];
    const depth = new BracketDepth(
      (line) => src[line] ?? '',
      () => NONE,
    );
    expect(depth.marksFor(0)).toEqual([{ start: 0, depth: 0 }]);
    // Закрывающая на строке 2 — та же открывающая с строки 0: уровень 0.
    expect(depth.marksFor(2)).toEqual([{ start: 0, depth: 0 }]);

    // Вставили строку между: закрывающая переехала на строку 3, но уровень тот же.
    src.splice(1, 0, 'y');
    depth.invalidate(1, true);
    expect(depth.marksFor(3)).toEqual([{ start: 0, depth: 0 }]);
  });

  it('сброс забывает вложенность (новый документ)', () => {
    const src = ['(', 'x'];
    const depth = new BracketDepth(
      (line) => src[line] ?? '',
      () => NONE,
    );
    expect(depth.marksFor(1)).toEqual([]);
    depth.reset();
    expect(depth.marksFor(0)).toEqual([{ start: 0, depth: 0 }]);
  });
});
