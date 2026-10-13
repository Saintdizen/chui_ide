import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { EditorController } from '../src/renderer/editor/input/editor-controller';

/**
 * Связанные участки (linkedEditing): правка в одном повторяется в остальных. Проверяем
 * на парных тегах — это ровно случай, ради которого фича и есть: меняешь имя в открывающем
 * теге, оно меняется и в закрывающем.
 */

function make(text: string): { controller: EditorController; buffer: TextBuffer } {
  const buffer = new TextBuffer(text);
  return { controller: new EditorController(buffer), buffer };
}

// `<div></div>`: имя открывающего тега — [1,4), закрывающего — [7,10).
const HTML = '<div></div>';

describe('связанные участки (linkedEditing)', () => {
  it('набор в одном теге повторяется в другом', () => {
    const { controller, buffer } = make(HTML);
    controller.setLinkedRanges([
      { start: 1, end: 4 },
      { start: 7, end: 10 },
    ]);
    controller.setSelection({ anchor: 1, active: 1 });

    controller.type('x');

    expect(buffer.text).toBe('<xdiv></xdiv>');
  });

  it('удаление в одном теге повторяется в другом', () => {
    const { controller, buffer } = make(HTML);
    controller.setLinkedRanges([
      { start: 1, end: 4 },
      { start: 7, end: 10 },
    ]);
    controller.setSelection({ anchor: 4, active: 4 });

    controller.backspace();

    expect(buffer.text).toBe('<di></di>');
  });

  it('правка в среднем участке повторяется в обоих крайних', () => {
    const { controller, buffer } = make('<p><span></span></p>');
    // имя «span» дважды: [4,8) и [11,15)
    controller.setLinkedRanges([
      { start: 4, end: 8 },
      { start: 11, end: 15 },
    ]);
    controller.setSelection({ anchor: 4, active: 4 });
    controller.type('a');

    expect(buffer.text).toBe('<p><aspan></aspan></p>');
  });

  it('набор подряд держит связь между нажатиями', () => {
    const { controller, buffer } = make(HTML);
    controller.setLinkedRanges([
      { start: 1, end: 4 },
      { start: 7, end: 10 },
    ]);
    controller.setSelection({ anchor: 4, active: 4 });

    controller.type('X');
    controller.type('Y');

    expect(buffer.text).toBe('<divXY></divXY>');
  });

  it('отмена возвращает оба участка одним шагом', () => {
    const { controller, buffer } = make(HTML);
    controller.setLinkedRanges([
      { start: 1, end: 4 },
      { start: 7, end: 10 },
    ]);
    controller.setSelection({ anchor: 1, active: 1 });
    controller.type('x');

    controller.undo();

    expect(buffer.text).toBe(HTML);
    expect(controller.canUndo).toBe(false);
  });

  it('правка вне участка не повторяется', () => {
    const { controller, buffer } = make(HTML);
    controller.setLinkedRanges([
      { start: 1, end: 4 },
      { start: 7, end: 10 },
    ]);
    controller.setSelection({ anchor: 0, active: 0 });

    controller.type('!');

    expect(buffer.text).toBe('!<div></div>');
  });

  it('без связанных участков правка обычная', () => {
    const { controller, buffer } = make(HTML);
    controller.setSelection({ anchor: 1, active: 1 });

    controller.type('x');

    expect(buffer.text).toBe('<xdiv></div>');
  });

  it('один участок — связи нет', () => {
    const { controller } = make(HTML);
    controller.setLinkedRanges([{ start: 1, end: 4 }]);

    expect(controller.linkedRanges).toBeNull();
  });

  it('пересекающиеся участки сливаются, одиночный не связывает', () => {
    const { controller } = make(HTML);
    controller.setLinkedRanges([
      { start: 7, end: 10 },
      { start: 1, end: 4 },
      { start: 2, end: 3 }, // внутри первого — отбрасывается
    ]);

    expect(controller.linkedRanges).toEqual([
      { start: 1, end: 4 },
      { start: 7, end: 10 },
    ]);
  });

  it('при мультикурсоре связь не применяется', () => {
    const { controller, buffer } = make(HTML);
    controller.setLinkedRanges([
      { start: 1, end: 4 },
      { start: 7, end: 10 },
    ]);
    controller.setSelections([
      { anchor: 1, active: 1 },
      { anchor: 2, active: 2 },
    ]);

    controller.type('Z');

    expect(buffer.text).toBe('<ZdZiv></div>');
  });

  it('смена документа снимает связь', () => {
    const { controller } = make(HTML);
    controller.setLinkedRanges([
      { start: 1, end: 4 },
      { start: 7, end: 10 },
    ]);

    controller.setBuffer(new TextBuffer('other'));

    expect(controller.linkedRanges).toBeNull();
  });
});
