import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { EditorController } from '../src/renderer/editor/input/editor-controller';

function make(text: string): { controller: EditorController; buffer: TextBuffer } {
  const buffer = new TextBuffer(text);
  return { controller: new EditorController(buffer), buffer };
}

describe('applyEdits: несколько правок одним шагом', () => {
  it('применяет правки и ставит курсор в конец верхней', () => {
    const { controller, buffer } = make('один два три');
    // Правки идут в порядке применения — по убыванию смещения (так их отдаёт перевод).
    controller.applyEdits([
      { start: 9, removed: 'три', inserted: '3' },
      { start: 0, removed: 'один', inserted: '1' },
    ]);
    expect(buffer.text).toBe('1 два 3');
    // Курсор — за верхней правкой (та, что левее всех).
    expect(controller.caret).toBe(1);
  });

  it('отмена возвращает всё разом, одним шагом', () => {
    const { controller, buffer } = make('один два три');
    controller.applyEdits([
      { start: 9, removed: 'три', inserted: '3' },
      { start: 0, removed: 'один', inserted: '1' },
    ]);
    expect(buffer.text).toBe('1 два 3');

    controller.undo();
    expect(buffer.text).toBe('один два три');
    // Второй отмены нет: шаг был один.
    expect(controller.canUndo).toBe(false);
  });

  it('повтор после отмены возвращает правку', () => {
    const { controller, buffer } = make('один два три');
    controller.applyEdits([
      { start: 9, removed: 'три', inserted: '3' },
      { start: 0, removed: 'один', inserted: '1' },
    ]);
    controller.undo();
    controller.redo();
    expect(buffer.text).toBe('1 два 3');
  });

  it('пустой список правок ничего не делает', () => {
    const { controller, buffer } = make('текст');
    controller.applyEdits([]);
    expect(buffer.text).toBe('текст');
    expect(controller.canUndo).toBe(false);
  });

  it('правки без изменений отбрасываются', () => {
    const { controller } = make('текст');
    controller.applyEdits([{ start: 0, removed: 'текст', inserted: 'текст' }]);
    expect(controller.canUndo).toBe(false);
  });

  it('правки в разных строках не сдвигают друг друга', () => {
    const { controller, buffer } = make('первая\nвторая\nтретья');
    // Вторая строка начинается на 7, третья — на 14.
    controller.applyEdits([
      { start: 14, removed: 'третья', inserted: '3-я' },
      { start: 7, removed: 'вторая', inserted: '2-я' },
    ]);
    expect(buffer.text).toBe('первая\n2-я\n3-я');
  });
});

describe('setBuffer: другой файл в той же панели', () => {
  it('меняет документ и ставит курсор в начало', () => {
    const { controller } = make('старый файл');
    controller.moveRight();
    const next = new TextBuffer('новый файл');
    controller.setBuffer(next);
    expect(controller.bufferRef).toBe(next);
    expect(controller.caret).toBe(0);
  });

  it('история прежнего файла не переносится', () => {
    const { controller } = make('старый');
    controller.type('х');
    expect(controller.canUndo).toBe(true);

    controller.setBuffer(new TextBuffer('новый'));
    // Отменять правки ПРОШЛОГО файла в новом было бы странно — история очищена.
    expect(controller.canUndo).toBe(false);
    expect(controller.canRedo).toBe(false);
  });

  it('курсор можно поставить сразу: так возвращается позиция при открытии файла', () => {
    const { controller } = make('старый');
    const next = new TextBuffer('первая\nвторая');
    controller.setBuffer(next, { anchor: 7, active: 7 });
    expect(controller.caret).toBe(7);
  });
});
