import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import {
  convertSelectionCase,
  deleteLines,
  duplicateSelection,
  insertLineAbove,
  insertLineBelow,
  joinLines,
  joinLineTexts,
  sortLines,
  sortLineTexts,
  transposeAtCaret,
} from '../src/renderer/editor/input/line-ops';
import { blockCommentFor, toggleBlockComment, toggleLineComment } from '../src/renderer/editor/input/comments';
import { convertCase, splitWords } from '../src/renderer/editor/input/case-convert';
import { caret } from '../src/renderer/editor/view/selection';
import type { TextChange } from '../src/renderer/editor/core/history';

/** Применить набор правок в том порядке, в каком их отдаёт переключение комментария. */
function applyChanges(buffer: TextBuffer, changes: readonly TextChange[]): void {
  for (const change of changes) buffer.replace(change.start, change.removed.length, change.inserted);
}

describe('сортировка строк (чистая функция)', () => {
  it('числа идут по величине, а не по алфавиту', () => {
    expect(sortLineTexts(['line10', 'line2', 'line1'])).toEqual(['line1', 'line2', 'line10']);
  });

  it('регистр не влияет на порядок по умолчанию', () => {
    expect(sortLineTexts(['Banana', 'apple'])).toEqual(['apple', 'Banana']);
  });

  it('учёт регистра меняет набор строк только порядком', () => {
    // Точный порядок зависит от локали, поэтому проверяем состав, а не позиции.
    expect([...sortLineTexts(['b', 'a', 'B'], { caseSensitive: true })].sort()).toEqual(['B', 'a', 'b']);
  });

  it('reverse переворачивает, unique убирает соседние повторы', () => {
    expect(sortLineTexts(['a', 'b'], { reverse: true })).toEqual(['b', 'a']);
    expect(sortLineTexts(['a', 'a', 'b', 'b'], { unique: true })).toEqual(['a', 'b']);
  });
});

describe('соединение строк (чистая функция)', () => {
  it('склеивает пробелом и снимает краевые пробелы', () => {
    expect(joinLineTexts(['  a  ', '  b'])).toBe('a b');
  });

  it('пустые строки не оставляют двойных пробелов', () => {
    expect(joinLineTexts(['a', '', '  ', 'b'])).toBe('a b');
  });
});

describe('смена регистра (чистая функция)', () => {
  it('разбивает по границам camelCase и подчёркиваниям', () => {
    expect(splitWords('getUserName')).toEqual(['get', 'User', 'Name']);
    expect(splitWords('get_user_name')).toEqual(['get', 'user', 'name']);
  });

  it('аббревиатура не разваливается посреди слова', () => {
    expect(splitWords('HTTPServer')).toEqual(['HTTP', 'Server']);
  });

  it('цифры остаются при своём слове', () => {
    expect(splitWords('base64')).toEqual(['base64']);
  });

  it('переводит в camelCase, snake_case и CONSTANT_CASE', () => {
    expect(convertCase('get_user_name', 'camel')).toBe('getUserName');
    expect(convertCase('getUserName', 'snake')).toBe('get_user_name');
    expect(convertCase('getUserName', 'constant')).toBe('GET_USER_NAME');
    expect(convertCase('get-user-name', 'pascal')).toBe('GetUserName');
  });

  it('нет слов — возвращаем исходный текст, а не пустоту', () => {
    expect(convertCase('---', 'snake')).toBe('---');
  });
});

describe('сортировка, соединение и удаление строк в буфере', () => {
  it('сортирует строки выделения', () => {
    const buffer = new TextBuffer('b\na');
    const result = sortLines(buffer, { anchor: 0, active: 3 })!;
    expect(buffer.text).toBe('a\nb');
    expect(result.selection).toEqual({ anchor: 3, active: 3 });
  });

  it('одна строка — сортировать нечего', () => {
    const buffer = new TextBuffer('only');
    expect(sortLines(buffer, caret(0))).toBeNull();
  });

  it('соединяет строки, сохраняя отступ первой', () => {
    const buffer = new TextBuffer('  one\n  two');
    joinLines(buffer, { anchor: 0, active: 11 });
    expect(buffer.text).toBe('  one two');
  });

  it('удаляет среднюю строку вместе с переводом', () => {
    const buffer = new TextBuffer('one\ntwo\nthree');
    deleteLines(buffer, caret(5));
    expect(buffer.text).toBe('one\nthree');
  });

  it('у последней строки забирает перевод предыдущей', () => {
    const buffer = new TextBuffer('one\ntwo');
    deleteLines(buffer, caret(5));
    expect(buffer.text).toBe('one');
  });
});

describe('вставка строк рядом', () => {
  it('строка ниже наследует отступ, каретка на новой строке', () => {
    const buffer = new TextBuffer('  x');
    const result = insertLineBelow(buffer, caret(3));
    expect(buffer.text).toBe('  x\n  ');
    expect(result.selection).toEqual({ anchor: 6, active: 6 });
  });

  it('строка выше наследует отступ', () => {
    const buffer = new TextBuffer('  x');
    insertLineAbove(buffer, caret(3));
    expect(buffer.text).toBe('  \n  x');
  });
});

describe('дублирование и перестановка', () => {
  it('дублирует выделение сразу за ним', () => {
    const buffer = new TextBuffer('abc');
    const result = duplicateSelection(buffer, { anchor: 0, active: 3 })!;
    expect(buffer.text).toBe('abcabc');
    expect(result.selection).toEqual({ anchor: 3, active: 6 });
  });

  it('без выделения дублирует строку вниз', () => {
    const buffer = new TextBuffer('abc');
    duplicateSelection(buffer, caret(1));
    expect(buffer.text).toBe('abc\nabc');
  });

  it('переставляет два знака вокруг каретки', () => {
    const buffer = new TextBuffer('ab');
    transposeAtCaret(buffer, caret(1));
    expect(buffer.text).toBe('ba');
  });

  it('эмодзи не разрывается: меняются целые кластеры', () => {
    const buffer = new TextBuffer('a👍');
    transposeAtCaret(buffer, caret(1));
    expect(buffer.text).toBe('👍a');
  });
});

describe('регистр у выделения и слова под кареткой', () => {
  it('переводит выделение в camelCase', () => {
    const buffer = new TextBuffer('get_user_name');
    const result = convertSelectionCase(buffer, { anchor: 0, active: 13 }, 'camel')!;
    expect(buffer.text).toBe('getUserName');
    expect(result.selection).toEqual({ anchor: 0, active: 11 });
  });

  it('без выделения берёт слово под кареткой', () => {
    const buffer = new TextBuffer('get_user_name');
    convertSelectionCase(buffer, caret(2), 'pascal');
    expect(buffer.text).toBe('GetUserName');
  });

  it('уже в этом стиле — менять нечего', () => {
    const buffer = new TextBuffer('user');
    expect(convertSelectionCase(buffer, { anchor: 0, active: 4 }, 'lower')).toBeNull();
  });
});

describe('Shift+Alt+A — блочный комментарий', () => {
  it('знаки зависят от языка', () => {
    expect(blockCommentFor('typescript')).toEqual(['/*', '*/']);
    expect(blockCommentFor('python')).toEqual(['"""', '"""']);
    expect(blockCommentFor('markdown')).toEqual(['<!--', '-->']);
    // Язык без записи блочно не комментируется — и это честно видно по null.
    expect(blockCommentFor('ini')).toBeNull();
    expect(blockCommentFor(null)).toBeNull();
  });

  it('оборачивает выделение', () => {
    const buffer = new TextBuffer('code');
    const result = toggleBlockComment(buffer, { anchor: 0, active: 4 }, '/*', '*/')!;
    applyChanges(buffer, result.changes);
    expect(buffer.text).toBe('/*code*/');
    expect(result.selection).toEqual({ anchor: 0, active: 8 });
  });

  it('снимает обёртку, если выделено вместе с ней', () => {
    const buffer = new TextBuffer('/*code*/');
    const result = toggleBlockComment(buffer, { anchor: 0, active: 8 }, '/*', '*/')!;
    applyChanges(buffer, result.changes);
    expect(buffer.text).toBe('code');
    expect(result.selection).toEqual({ anchor: 0, active: 4 });
  });

  it('пустое выделение берёт строку целиком', () => {
    const buffer = new TextBuffer('x = 1');
    const result = toggleBlockComment(buffer, caret(2), '/*', '*/')!;
    applyChanges(buffer, result.changes);
    expect(buffer.text).toBe('/*x = 1*/');
  });
});

describe('строчный и блочный комментарий — разные знаки', () => {
  it('строчный не трогает границы строк, блочный оборачивает как есть', () => {
    const line = new TextBuffer('one\ntwo');
    applyChanges(line, toggleLineComment(line, { anchor: 0, active: 7 }, '//')!.changes);
    expect(line.text).toBe('// one\n// two');

    const block = new TextBuffer('one\ntwo');
    applyChanges(block, toggleBlockComment(block, { anchor: 0, active: 7 }, '/*', '*/')!.changes);
    expect(block.text).toBe('/*one\ntwo*/');
  });
});
