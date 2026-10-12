import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { EditorController } from '../src/renderer/editor/input/editor-controller';

function make(text: string): { controller: EditorController; buffer: TextBuffer } {
  const buffer = new TextBuffer(text);
  return { controller: new EditorController(buffer), buffer };
}

describe('правка на нескольких каретках', () => {
  it('ввод идёт во все каретки и отменяется одним шагом', () => {
    const { controller, buffer } = make('one\ntwo');
    controller.setSelections([
      { anchor: 1, active: 1 },
      { anchor: 5, active: 5 },
    ]);
    controller.type('X');
    expect(buffer.text).toBe('oXne\ntXwo');
    // Вторая каретка стоит ПРАВЕЕ первой, и её место сдвинулось на вставку слева.
    expect(controller.selections).toEqual([
      { anchor: 2, active: 2 },
      { anchor: 7, active: 7 },
    ]);
    controller.undo();
    expect(buffer.text).toBe('one\ntwo');
    // Оба ввода — один шаг истории.
    expect(controller.canUndo).toBe(false);
  });

  it('набор подряд схлопывается в один шаг и при нескольких каретках', () => {
    const { controller, buffer } = make('aa\nbb');
    controller.setSelections([
      { anchor: 1, active: 1 },
      { anchor: 4, active: 4 },
    ]);
    controller.type('1');
    controller.type('2');
    expect(buffer.text).toBe('a12a\nb12b');
    controller.undo();
    // Обе каретки, оба нажатия — один шаг отмены.
    expect(buffer.text).toBe('aa\nbb');
  });

  it('Backspace снимает символ у каждой каретки', () => {
    const { controller, buffer } = make('abc\ndef');
    controller.setSelections([
      { anchor: 2, active: 2 },
      { anchor: 6, active: 6 },
    ]);
    controller.backspace();
    expect(buffer.text).toBe('ac\ndf');
  });

  it('ввод заменяет выделенное в каждом месте', () => {
    const { controller, buffer } = make('foo bar foo');
    controller.setSelections([
      { anchor: 0, active: 3 },
      { anchor: 8, active: 11 },
    ]);
    controller.type('baz');
    expect(buffer.text).toBe('baz bar baz');
  });

  it('правки в одном месте не съезжают от правок в другом', () => {
    const { controller, buffer } = make('aa\nbb\ncc');
    controller.setSelections([
      { anchor: 0, active: 0 },
      { anchor: 6, active: 6 },
    ]);
    controller.type('XYZ');
    expect(buffer.text).toBe('XYZaa\nbb\nXYZcc');
  });
});

describe('движение нескольких кареток', () => {
  it('стрелка двигает обе каретки', () => {
    const { controller } = make('abcdef\nghijkl');
    controller.setSelections([
      { anchor: 1, active: 1 },
      { anchor: 8, active: 8 },
    ]);
    controller.moveRight();
    expect(controller.selections).toEqual([
      { anchor: 2, active: 2 },
      { anchor: 9, active: 9 },
    ]);
  });

  it('вертикальное движение держит столбец каждой каретки', () => {
    const { controller } = make('long line here\nhi\nanother long');
    controller.setSelections([
      { anchor: 10, active: 10 },
      { anchor: 15, active: 15 },
    ]);
    controller.moveVertical(1);
    const lines = controller.selections.map((sel) => sel.active);
    // Первая каретка упёрлась в короткую строку (её начало 15, длина 2) — на конце.
    expect(lines[0]).toBe(17);
    // Вторая сдвинулась на строку вниз, столбец 0 → начало третьей строки (18).
    expect(lines[1]).toBe(18);
  });

  it('слипшиеся каретки объединяются в одну', () => {
    const { controller } = make('ab');
    controller.setSelections([
      { anchor: 0, active: 0 },
      { anchor: 1, active: 1 },
    ]);
    controller.moveLeft();
    // Обе пришли в одно место (0 и 0) — остаётся одна каретка.
    expect(controller.selections).toEqual([{ anchor: 0, active: 0 }]);
  });
});

describe('добавление кареток', () => {
  it('Ctrl+Alt+↓ добавляет каретку ниже по тому же столбцу', () => {
    const { controller } = make('abc\ndef\nghi');
    controller.setSelection({ anchor: 2, active: 2 }, false);
    controller.addCursorBelow();
    expect(controller.selections).toEqual([
      { anchor: 2, active: 2 },
      { anchor: 6, active: 6 },
    ]);
    controller.addCursorBelow();
    expect(controller.selections.map((sel) => sel.active)).toEqual([2, 6, 10]);
  });

  it('Ctrl+Alt+↑ за краем документа каретку не добавляет', () => {
    const { controller } = make('abc');
    controller.setSelection({ anchor: 1, active: 1 }, false);
    controller.addCursorAbove();
    expect(controller.selections).toHaveLength(1);
  });

  it('добавленный курсор становится главным', () => {
    const { controller } = make('abc\ndef');
    controller.setSelection({ anchor: 1, active: 1 }, false);
    controller.addCursorBelow();
    expect(controller.caret).toBe(5);
  });
});

describe('выделение вхождений', () => {
  it('Ctrl+D: первое нажатие выделяет слово, дальше добавляет вхождения', () => {
    const { controller } = make('value = value + valueCount');
    controller.setSelection({ anchor: 1, active: 1 }, false);
    controller.selectNextOccurrence();
    expect(controller.selections).toEqual([{ anchor: 0, active: 5 }]);
    controller.selectNextOccurrence();
    expect(controller.selections).toEqual([
      { anchor: 0, active: 5 },
      { anchor: 8, active: 13 },
    ]);
    // `valueCount` не считается: справа от `value` там словный знак.
    controller.selectNextOccurrence();
    expect(controller.selections).toHaveLength(2);
  });

  it('Ctrl+Shift+L выделяет все вхождения разом', () => {
    const { controller } = make('aa bb aa cc aa');
    controller.setSelection({ anchor: 0, active: 2 }, false);
    controller.selectAllOccurrences();
    expect(controller.selections).toEqual([
      { anchor: 0, active: 2 },
      { anchor: 6, active: 8 },
      { anchor: 12, active: 14 },
    ]);
  });

  it('печать при выделении всех вхождений меняет их разом', () => {
    const { controller, buffer } = make('aa bb aa');
    controller.setSelection({ anchor: 0, active: 2 }, false);
    controller.selectAllOccurrences();
    controller.type('Z');
    expect(buffer.text).toBe('Z bb Z');
  });

  it('слова нет — добавлять нечего', () => {
    const { controller } = make('   ');
    controller.setSelection({ anchor: 1, active: 1 }, false);
    expect(controller.selectNextOccurrence()).toBe(false);
    expect(controller.selectAllOccurrences()).toBe(false);
  });
});

describe('сброс мультикурсора', () => {
  it('Escape оставляет только главный курсор', () => {
    const { controller } = make('abcdef');
    controller.setSelections([
      { anchor: 1, active: 1 },
      { anchor: 4, active: 4 },
    ]);
    controller.collapseToPrimary();
    expect(controller.selections).toEqual([{ anchor: 4, active: 4 }]);
  });

  it('смена документа забывает лишние каретки', () => {
    const { controller } = make('abc');
    controller.setSelections([
      { anchor: 0, active: 0 },
      { anchor: 2, active: 2 },
    ]);
    controller.setBuffer(new TextBuffer('xyz'));
    expect(controller.selections).toHaveLength(1);
  });
});

describe('буфер обмена при нескольких выделениях', () => {
  it('копирование соединяет выделенные куски переводом строки', () => {
    const { controller } = make('one two three');
    controller.setSelections([
      { anchor: 0, active: 3 },
      { anchor: 8, active: 13 },
    ]);
    expect(controller.selectedText()).toBe('one\nthree');
  });

  it('вырезание снимает все выделенные куски одним шагом', () => {
    const { controller, buffer } = make('one two three');
    controller.setSelections([
      { anchor: 0, active: 3 },
      { anchor: 8, active: 13 },
    ]);
    expect(controller.cutSelection()).toBe('one\nthree');
    expect(buffer.text).toBe(' two ');
    controller.undo();
    expect(buffer.text).toBe('one two three');
  });
});
