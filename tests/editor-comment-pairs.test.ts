import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import {
  copyLinesDown,
  deletePairBackward,
  insertPair,
  isOpener,
  moveLines,
  skipClosing,
} from '../src/renderer/editor/input/editing';
import { lineCommentFor, toggleLineComment } from '../src/renderer/editor/input/comments';
import { caret } from '../src/renderer/editor/view/selection';
import type { TextChange } from '../src/renderer/editor/core/history';

/** Применить набор правок в том порядке, в каком их отдаёт переключение комментария. */
function applyChanges(buffer: TextBuffer, changes: readonly TextChange[]): void {
  for (const change of changes) buffer.replace(change.start, change.removed.length, change.inserted);
}

describe('парные символы', () => {
  it('дописывает пару и ставит каретку между знаками', () => {
    const buffer = new TextBuffer('');
    const result = insertPair(buffer, caret(0), '(', ')')!;
    expect(buffer.text).toBe('()');
    expect(result.selection).toEqual({ anchor: 1, active: 1 });
  });

  it('оборачивает выделение в круглые скобки', () => {
    const buffer = new TextBuffer('value');
    const result = insertPair(buffer, { anchor: 0, active: 5 }, '(', ')')!;
    expect(buffer.text).toBe('(value)');
    expect(result.selection).toEqual({ anchor: 7, active: 7 });
  });

  it('кавычка не оборачивает выделение, а вставляется парой', () => {
    const buffer = new TextBuffer('value');
    const result = insertPair(buffer, { anchor: 0, active: 5 }, '"', '"')!;
    expect(buffer.text).toBe('""');
    expect(result.selection).toEqual({ anchor: 1, active: 1 });
  });

  it('перешагивает через уже стоящий закрывающий знак', () => {
    const buffer = new TextBuffer('()');
    expect(skipClosing(buffer, caret(1), ')')).toEqual({ anchor: 2, active: 2 });
  });

  it('не перешагивает, если справа другой знак', () => {
    const buffer = new TextBuffer('(x');
    expect(skipClosing(buffer, caret(1), ')')).toBeNull();
  });

  it('Backspace между пустой парой снимает оба знака', () => {
    const buffer = new TextBuffer('()');
    const result = deletePairBackward(buffer, caret(1))!;
    expect(buffer.text).toBe('');
    expect(result.selection).toEqual({ anchor: 0, active: 0 });
  });

  it('Backspace не трогает пару, если внутри уже текст', () => {
    const buffer = new TextBuffer('(x)');
    expect(deletePairBackward(buffer, caret(2))).toBeNull();
  });

  it('открывающими считаются только скобки и кавычки', () => {
    expect(isOpener('(')).toBe(true);
    expect(isOpener('"')).toBe(true);
    expect(isOpener('x')).toBe(false);
  });
});

describe('перенос и копирование строк', () => {
  it('Alt+↑ меняет строку с предыдущей', () => {
    const buffer = new TextBuffer('one\ntwo\nthree');
    const result = moveLines(buffer, caret(5), -1)!;
    expect(buffer.text).toBe('two\none\nthree');
    expect(result.selection).toEqual({ anchor: 1, active: 1 });
  });

  it('Alt+↓ меняет строку со следующей', () => {
    const buffer = new TextBuffer('one\ntwo\nthree');
    moveLines(buffer, caret(1), 1);
    expect(buffer.text).toBe('two\none\nthree');
  });

  it('первая строка вверх не переносится', () => {
    const buffer = new TextBuffer('one\ntwo');
    expect(moveLines(buffer, caret(0), -1)).toBeNull();
  });

  it('последняя строка вниз не переносится', () => {
    const buffer = new TextBuffer('one\ntwo');
    expect(moveLines(buffer, caret(5), 1)).toBeNull();
  });

  it('Shift+Alt+↓ копирует строку ниже и оставляет выделение на копии', () => {
    const buffer = new TextBuffer('one\ntwo');
    const result = copyLinesDown(buffer, caret(1))!;
    expect(buffer.text).toBe('one\none\ntwo');
    expect(result.selection).toEqual({ anchor: 5, active: 5 });
  });
});

describe('Ctrl+/ — комментарий строки', () => {
  it('знак комментария зависит от языка', () => {
    expect(lineCommentFor('typescript')).toBe('//');
    expect(lineCommentFor('python')).toBe('#');
    expect(lineCommentFor('sql')).toBe('--');
    expect(lineCommentFor('markdown')).toBeNull();
  });

  it('ставит знак в начале строки, после отступа', () => {
    const buffer = new TextBuffer('  const a = 1;');
    applyChanges(buffer, toggleLineComment(buffer, caret(3), '//')!.changes);
    expect(buffer.text).toBe('  // const a = 1;');
  });

  it('снимает знак вместе с пробелом после него', () => {
    const buffer = new TextBuffer('// const a = 1;');
    applyChanges(buffer, toggleLineComment(buffer, caret(2), '//')!.changes);
    expect(buffer.text).toBe('const a = 1;');
  });

  it('комментирует все строки выделения', () => {
    const buffer = new TextBuffer('one\ntwo');
    applyChanges(buffer, toggleLineComment(buffer, { anchor: 0, active: 7 }, '#')!.changes);
    expect(buffer.text).toBe('# one\n# two');
  });

  it('пустые строки не комментируются и не мешают снятию', () => {
    const buffer = new TextBuffer('# one\n\n# two');
    applyChanges(buffer, toggleLineComment(buffer, { anchor: 0, active: 13 }, '#')!.changes);
    expect(buffer.text).toBe('one\n\ntwo');
  });

  it('смешанный диапазон — ставим знак у всех непустых строк', () => {
    const buffer = new TextBuffer('# one\ntwo');
    applyChanges(buffer, toggleLineComment(buffer, { anchor: 0, active: 9 }, '#')!.changes);
    expect(buffer.text).toBe('# # one\n# two');
  });

  it('из одних пустых строк переключать нечего', () => {
    const buffer = new TextBuffer('\n\n');
    expect(toggleLineComment(buffer, { anchor: 0, active: 2 }, '#')).toBeNull();
  });
});
