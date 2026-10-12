import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import {
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  deleteWordForward,
  insertNewline,
  insertText,
  outdentLine,
} from '../src/renderer/editor/input/editing';
import { caret } from '../src/renderer/editor/view/selection';

/** Применить результат правки и вернуть буфер с полученным выделением. */
function apply(_buffer: TextBuffer, result: ReturnType<typeof insertText>) {
  expect(result).not.toBeNull();
  return result!;
}

describe('ввод текста', () => {
  it('вставляет символ и ставит курсор за ним', () => {
    const buffer = new TextBuffer('ac');
    const result = apply(buffer, insertText(buffer, caret(1), 'b'));
    expect(buffer.text).toBe('abc');
    expect(result.selection).toEqual({ anchor: 2, active: 2 });
    expect(result.change).toEqual({ start: 1, removed: '', inserted: 'b' });
  });

  it('заменяет выделенное', () => {
    const buffer = new TextBuffer('hello world');
    const result = apply(buffer, insertText(buffer, { anchor: 0, active: 5 }, 'bye'));
    expect(buffer.text).toBe('bye world');
    expect(result.selection).toEqual({ anchor: 3, active: 3 });
  });

  it('пустой ввод ничего не меняет', () => {
    const buffer = new TextBuffer('x');
    expect(insertText(buffer, caret(0), '')).toBeNull();
    expect(buffer.text).toBe('x');
  });
});

describe('Backspace', () => {
  it('снимает один символ слева', () => {
    const buffer = new TextBuffer('abc');
    const result = apply(buffer, deleteBackward(buffer, caret(3)));
    expect(buffer.text).toBe('ab');
    expect(result.selection).toEqual({ anchor: 2, active: 2 });
  });

  it('в начале строки снимает перевод строки — строки сливаются', () => {
    const buffer = new TextBuffer('ab\ncd');
    const result = apply(buffer, deleteBackward(buffer, caret(3)));
    expect(buffer.text).toBe('abcd');
    expect(result.selection).toEqual({ anchor: 2, active: 2 });
  });

  it('удаляет составной эмодзи целиком, а не половину', () => {
    const buffer = new TextBuffer('a👨‍👩‍👧b');
    // Курсор за составным эмодзи (он занимает 8 единиц UTF-16: 3 эмодзи + 2 ZWJ).
    const after = buffer.lineText(1).indexOf('b');
    deleteBackward(buffer, caret(after));
    expect(buffer.text).toBe('ab');
  });

  it('в самом начале документа ничего не делает', () => {
    const buffer = new TextBuffer('abc');
    expect(deleteBackward(buffer, caret(0))).toBeNull();
  });
});

describe('Delete', () => {
  it('снимает символ справа', () => {
    const buffer = new TextBuffer('abc');
    apply(buffer, deleteForward(buffer, caret(0)));
    expect(buffer.text).toBe('bc');
  });

  it('в конце строки снимает перевод строки', () => {
    const buffer = new TextBuffer('ab\ncd');
    apply(buffer, deleteForward(buffer, caret(2)));
    expect(buffer.text).toBe('abcd');
  });

  it('в самом конце документа ничего не делает', () => {
    const buffer = new TextBuffer('abc');
    expect(deleteForward(buffer, caret(3))).toBeNull();
  });
});

describe('удаление слов', () => {
  it('Ctrl+Backspace снимает слово слева вместе с пробелами', () => {
    const buffer = new TextBuffer('one two three');
    apply(buffer, deleteWordBackward(buffer, caret(13)));
    expect(buffer.text).toBe('one two ');
  });

  it('Ctrl+Delete снимает слово справа', () => {
    const buffer = new TextBuffer('one two three');
    apply(buffer, deleteWordForward(buffer, caret(0)));
    expect(buffer.text).toBe(' two three');
  });
});

describe('Enter и отступы', () => {
  it('Enter сохраняет отступ текущей строки', () => {
    const buffer = new TextBuffer('    indented');
    const result = apply(buffer, insertNewline(buffer, caret(13)));
    expect(buffer.text).toBe('    indented\n    ');
    expect(result.selection).toEqual({ anchor: 18, active: 18 });
  });

  it('Enter без отступа просто делит строку', () => {
    const buffer = new TextBuffer('ab');
    apply(buffer, insertNewline(buffer, caret(1)));
    expect(buffer.text).toBe('a\nb');
  });

  it('Shift+Tab снимает до tabSize пробелов', () => {
    const buffer = new TextBuffer('      x');
    apply(buffer, outdentLine(buffer, 6, 4));
    expect(buffer.text).toBe('  x');
  });

  it('Shift+Tab снимает таб целиком', () => {
    const buffer = new TextBuffer('\tx');
    apply(buffer, outdentLine(buffer, 1, 4));
    expect(buffer.text).toBe('x');
  });

  it('Shift+Tab в строке без отступа ничего не делает', () => {
    const buffer = new TextBuffer('x');
    expect(outdentLine(buffer, 0, 4)).toBeNull();
  });
});
