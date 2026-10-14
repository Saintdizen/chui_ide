import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { EditorController } from '../src/renderer/editor/input/editor-controller';

function make(text: string): { controller: EditorController; buffer: TextBuffer } {
  const buffer = new TextBuffer(text);
  return { controller: new EditorController(buffer), buffer };
}

describe('независимая отмена на каждый курсор', () => {
  it('убирает правку только главной каретки', () => {
    const { controller, buffer } = make('one\ntwo');
    controller.setSelections([
      { anchor: 1, active: 1 },
      { anchor: 5, active: 5 },
    ]);
    controller.type('X');
    expect(buffer.text).toBe('oXne\ntXwo');

    controller.undoAtCursor();
    // Остался только ввод ПЕРВОЙ каретки; ввод главной (второй) снят.
    expect(buffer.text).toBe('oXne\ntwo');
  });

  it('независимый повтор возвращает снятое', () => {
    const { controller, buffer } = make('one\ntwo');
    controller.setSelections([
      { anchor: 1, active: 1 },
      { anchor: 5, active: 5 },
    ]);
    controller.type('X');
    controller.undoAtCursor();
    expect(buffer.text).toBe('oXne\ntwo');
    controller.redoAtCursor();
    expect(buffer.text).toBe('oXne\ntXwo');
  });

  it('правка одной каретки не портит отмену другой', () => {
    const { controller, buffer } = make('one\ntwo');
    controller.setSelections([
      { anchor: 1, active: 1 },
      { anchor: 5, active: 5 },
    ]);
    // Второй ввод уходит в обе каретки; у каждой набирается своё слово.
    controller.type('X');
    controller.type('Y');
    expect(buffer.text).toBe('oXYne\ntXYwo');

    controller.undoAtCursor();
    // Снимается слово главной каретки целиком; ввод первой каретки остаётся.
    expect(buffer.text).toBe('oXYne\ntwo');
  });

  it('набор подряд у каретки отменяется словом', () => {
    const { controller, buffer } = make('');
    controller.type('w');
    controller.type('o');
    controller.type('r');
    controller.type('d');
    expect(buffer.text).toBe('word');
    controller.undoAtCursor();
    expect(buffer.text).toBe('');
  });

  it('удаление назад отменяется как одно действие', () => {
    const { controller, buffer } = make('hello');
    controller.setSelection({ anchor: 5, active: 5 });
    controller.backspace();
    controller.backspace();
    expect(buffer.text).toBe('hel');
    controller.undoAtCursor();
    expect(buffer.text).toBe('hello');
  });

  it('нечего отменять — текст не меняется', () => {
    const { controller, buffer } = make('abc');
    expect(controller.canUndoAtCursor).toBe(false);
    controller.undoAtCursor();
    expect(buffer.text).toBe('abc');
  });

  it('общая отмена обнуляет независимый учёт', () => {
    const { controller, buffer } = make('one\ntwo');
    controller.setSelections([
      { anchor: 1, active: 1 },
      { anchor: 5, active: 5 },
    ]);
    controller.type('X');
    expect(controller.canUndoAtCursor).toBe(true);
    controller.undo();
    expect(buffer.text).toBe('one\ntwo');
    // После общей отмены независимый учёт забыт: текста, о котором он помнил, больше нет.
    expect(controller.canUndoAtCursor).toBe(false);
  });

  it('смена документа забывает независимый учёт', () => {
    const { controller } = make('abc');
    controller.type('d');
    expect(controller.canUndoAtCursor).toBe(true);
    controller.setBuffer(new TextBuffer('xyz'));
    expect(controller.canUndoAtCursor).toBe(false);
  });

  it('независимая отмена ложится в общую историю одним шагом', () => {
    const { controller, buffer } = make('one\ntwo');
    controller.setSelections([
      { anchor: 1, active: 1 },
      { anchor: 5, active: 5 },
    ]);
    controller.type('X');
    controller.undoAtCursor();
    expect(buffer.text).toBe('oXne\ntwo');
    // Обычный Ctrl+Z отменяет независимую отмену — текст возвращается.
    controller.undo();
    expect(buffer.text).toBe('oXne\ntXwo');
  });
});
