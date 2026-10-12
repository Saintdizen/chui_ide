import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { EditorController } from '../src/renderer/editor/input/editor-controller';

function make(text: string): { controller: EditorController; buffer: TextBuffer } {
  const buffer = new TextBuffer(text);
  return { controller: new EditorController(buffer), buffer };
}

describe('курсор и уведомления', () => {
  it('движение курсора сообщает только о выделении, не о тексте', () => {
    const { controller } = make('abc');
    const seen: string[] = [];
    controller.onChange((change) => seen.push(change.kind));
    controller.moveRight();
    controller.moveRight();
    expect(seen).toEqual(['selection', 'selection']);
  });

  it('правка сообщает об изменении текста', () => {
    const { controller, buffer } = make('ac');
    const seen: string[] = [];
    controller.onChange((change) => seen.push(change.kind));
    controller.setSelection({ anchor: 1, active: 1 }, false);
    controller.type('b');
    expect(seen).toEqual(['text']);
    expect(buffer.text).toBe('abc');
    expect(controller.caret).toBe(2);
  });
});

describe('выделение', () => {
  it('движение с Shift протягивает выделение, без Shift — роняет его', () => {
    const { controller } = make('abcdef');
    controller.moveRight();
    controller.moveRight();
    controller.moveRight(true);
    expect(controller.selection).toEqual({ anchor: 2, active: 3 });
    // Обычное движение схлопывает выделение в точку.
    controller.moveRight();
    expect(controller.selection).toEqual({ anchor: 4, active: 4 });
  });

  it('выделить всё — от начала до конца документа', () => {
    const { controller, buffer } = make('первая\nвторая');
    controller.selectAll();
    expect(controller.selection).toEqual({ anchor: 0, active: buffer.length });
    expect(controller.selectedText()).toBe('первая\nвторая');
  });
});

describe('правки и история', () => {
  it('набор схлопывается в один шаг отмены', () => {
    const { controller, buffer } = make('');
    controller.type('п');
    controller.type('р');
    controller.type('и');
    expect(buffer.text).toBe('при');
    controller.undo();
    // Ядро истории схлопывает набор подряд — отмена возвращает всё слово сразу.
    expect(buffer.text).toBe('');
  });

  it('отмена и повтор возвращают и текст, и курсор', () => {
    const { controller, buffer } = make('abc');
    controller.setSelection({ anchor: 3, active: 3 }, false);
    controller.type('d');
    expect(buffer.text).toBe('abcd');
    controller.undo();
    expect(buffer.text).toBe('abc');
    // Курсор вернулся туда, где был до правки.
    expect(controller.caret).toBe(3);
    controller.redo();
    expect(buffer.text).toBe('abcd');
    expect(controller.caret).toBe(4);
  });

  it('ввод заменяет выделенное, отмена возвращает его', () => {
    const { controller, buffer } = make('hello world');
    controller.setSelection({ anchor: 0, active: 5 }, false);
    controller.type('bye');
    expect(buffer.text).toBe('bye world');
    controller.undo();
    expect(buffer.text).toBe('hello world');
    expect(controller.selection).toEqual({ anchor: 0, active: 5 });
  });

  it('вырезание отдаёт текст и удаляет его, отмена возвращает', () => {
    const { controller, buffer } = make('one two');
    controller.setSelection({ anchor: 0, active: 3 }, false);
    const cut = controller.cutSelection();
    expect(cut).toBe('one');
    expect(buffer.text).toBe(' two');
    controller.undo();
    expect(buffer.text).toBe('one two');
  });

  it('вырезание без выделения ничего не делает', () => {
    const { controller, buffer } = make('abc');
    expect(controller.cutSelection()).toBe('');
    expect(buffer.text).toBe('abc');
  });
});

describe('вертикальное движение держит столбец', () => {
  it('проезд через короткую строку не теряет столбец', () => {
    const { controller } = make('longer line\nshort\nlonger again');
    // Столбец 10 первой строки.
    controller.setSelection({ anchor: 10, active: 10 }, false);
    controller.moveVertical(1);
    // Вторая строка короче — курсор на её конце (строка 2 начинается на 12, длина 5).
    expect(controller.caret).toBe(17);
    controller.moveVertical(1);
    // Третья строка длинная — вернулись на столбец 10 (строка 3 начинается на 18).
    expect(controller.caret).toBe(28);
  });

  it('горизонтальное движение сбрасывает желаемый столбец', () => {
    const { controller } = make('abcdefghij\nkl\nabcdefghij');
    controller.setSelection({ anchor: 9, active: 9 }, false);
    controller.moveVertical(1); // на короткую строку, курсор в конец (13)
    controller.moveLeft(); // столбец теперь 1
    controller.moveVertical(1);
    // В третьей строке (начало 14) столбец 1, а не 9.
    expect(controller.caret).toBe(15);
  });
});

describe('отступы', () => {
  it('Tab вставляет отступ, Shift+Tab снимает его', () => {
    const { controller, buffer } = make('x');
    controller.setSelection({ anchor: 0, active: 0 }, false);
    controller.indent();
    expect(buffer.text).toBe('    x');
    controller.outdent();
    expect(buffer.text).toBe('x');
  });
});
