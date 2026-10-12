import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { toTextEdit, translateEdits } from '../src/renderer/editor/host/document-edits';
import type { TextEdit } from '../src/shared/edits';

/** Правка позициями в стиле LSP: строка и столбец с единицы. */
function edit(
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
  newText: string,
  oldText?: string,
): TextEdit {
  return { startLine, startColumn, endLine, endColumn, newText, oldText };
}

/** Применить правки к тексту — как это сделает хозяин редактора. */
function apply(text: string, edits: readonly TextEdit[]): string {
  const buffer = new TextBuffer(text);
  const { changes } = translateEdits(buffer, edits);
  for (const change of changes) buffer.replace(change.start, change.removed.length, change.inserted);
  return buffer.text;
}

describe('перевод правок в смещения', () => {
  it('правка внутри строки', () => {
    const buffer = new TextBuffer('const value = 1;');
    const { changes, skipped } = translateEdits(buffer, [edit(1, 7, 1, 12, 'total')]);
    expect(skipped).toHaveLength(0);
    expect(changes).toEqual([{ start: 6, removed: 'value', inserted: 'total' }]);
  });

  it('правка во второй строке учитывает перевод строки', () => {
    const buffer = new TextBuffer('первая\nвторая\nтретья');
    const { changes } = translateEdits(buffer, [edit(2, 1, 2, 7, 'ВТОРАЯ')]);
    // Первая строка «первая» (6 знаков) плюс перевод строки — 7.
    expect(changes[0]?.start).toBe(7);
    expect(changes[0]?.removed).toBe('вторая');
  });

  it('правка на несколько строк — с их переводом', () => {
    const text = 'начало\nсередина\nконец';
    // Заменяем всю вторую строку вместе с её переводом на «одна».
    const result = apply(text, [edit(2, 1, 3, 1, 'одна\n')]);
    expect(result).toBe('начало\nодна\nконец');
  });

  it('вставка без удаления', () => {
    const buffer = new TextBuffer('ab');
    const { changes } = translateEdits(buffer, [edit(1, 2, 1, 2, 'X')]);
    expect(changes).toEqual([{ start: 1, removed: '', inserted: 'X' }]);
  });

  it('правки идут по убыванию смещения, чтобы не сдвигать друг друга', () => {
    const buffer = new TextBuffer('один два три');
    // «один» — столбцы 1..5, «три» — 10..13 (столбец с единицы, то есть смещение на один меньше).
    const { changes } = translateEdits(buffer, [edit(1, 1, 1, 5, '1'), edit(1, 10, 1, 13, '3')]);
    // Вторая правка (правее) должна идти первой.
    expect(changes.map((change) => change.start)).toEqual([9, 0]);
  });

  it('несколько правок применяются верно, хотя смещения сдвигаются', () => {
    const text = 'один два три';
    expect(apply(text, [edit(1, 1, 1, 5, '1'), edit(1, 10, 1, 13, '3')])).toBe('1 два 3');
  });

  it('правка, которая ничего не меняет, пропускается', () => {
    const buffer = new TextBuffer('value');
    const { changes } = translateEdits(buffer, [edit(1, 1, 1, 6, 'value')]);
    expect(changes).toHaveLength(0);
  });
});

describe('сверка текста под правкой', () => {
  it('совпавший текст — правка применяется', () => {
    const buffer = new TextBuffer('const value = 1;');
    const { changes } = translateEdits(buffer, [edit(1, 7, 1, 12, 'total', 'value')]);
    expect(changes).toHaveLength(1);
  });

  it('разошедшийся текст — правка пропускается с причиной', () => {
    const buffer = new TextBuffer('const other = 1;');
    const { changes, skipped } = translateEdits(buffer, [edit(1, 7, 1, 12, 'total', 'value')]);
    expect(changes).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toBe('текст под правкой не совпал');
  });

  it('пропущенная правка не мешает остальным', () => {
    const buffer = new TextBuffer('один два');
    const { changes, skipped } = translateEdits(buffer, [edit(1, 1, 1, 4, 'раз', 'нетакого'), edit(1, 6, 1, 9, '2')]);
    expect(skipped).toHaveLength(1);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.inserted).toBe('2');
  });

  it('конец раньше начала — правка отброшена', () => {
    const buffer = new TextBuffer('строка');
    const { changes, skipped } = translateEdits(buffer, [edit(1, 5, 1, 2, 'X')]);
    expect(changes).toHaveLength(0);
    expect(skipped[0]?.reason).toBe('конец раньше начала');
  });
});

describe('обратный перевод', () => {
  it('участок буфера превращается в правку позициями', () => {
    const buffer = new TextBuffer('первая\nвторая');
    expect(toTextEdit(buffer, 7, 13, 'X')).toEqual({
      startLine: 2,
      startColumn: 1,
      endLine: 2,
      endColumn: 7,
      newText: 'X',
    });
  });

  it('правка, полученная из участка, меняет именно его', () => {
    const text = 'первая\nвторая';
    const buffer = new TextBuffer(text);
    const reverse = toTextEdit(buffer, 7, 13, 'X');
    expect(apply(text, [reverse])).toBe('первая\nX');
  });
});
