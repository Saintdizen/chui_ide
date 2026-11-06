import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { EditorController } from '../src/renderer/editor/input/editor-controller';

const depth = (controller: EditorController): number =>
  (controller as unknown as { history: { depth: number } }).history.depth;

/**
 * Отмена по шагам, а не одним куском (п.29). Три свойства, и все три — про то,
 * что шаг отмены значит для человека: «верни ровно то действие, которое я
 * сделал», а не «верни полстраницы».
 */
describe('шаги отмены', () => {
  it('две вставки агента — два Ctrl+Z', () => {
    const buffer = new TextBuffer('abc');
    const controller = new EditorController(buffer);
    controller.setSelections([{ anchor: 3, active: 3 }]);

    controller.applyEdits([{ start: 3, removed: '', inserted: 'X' }]);
    controller.applyEdits([{ start: 4, removed: '', inserted: 'Y' }]);
    expect(depth(controller)).toBe(2);

    controller.undo();
    expect(buffer.text).toBe('abcX');
    controller.undo();
    expect(buffer.text).toBe('abc');
  });

  it('правка на нескольких каретках — один шаг', () => {
    const buffer = new TextBuffer('one\ntwo');
    const controller = new EditorController(buffer);
    controller.setSelections([
      { anchor: 1, active: 1 },
      { anchor: 5, active: 5 },
    ]);

    controller.type('X');
    controller.type('Y');
    expect(buffer.text).toBe('oXYne\ntXYwo');
    // Набор подряд на двух каретках схлопывается: два знака — один шаг.
    expect(depth(controller)).toBe(1);

    controller.undo();
    expect(buffer.text).toBe('one\ntwo');
  });

  it('удаление на нескольких каретках тоже один шаг', () => {
    const buffer = new TextBuffer('abcdef\nghijkl');
    const controller = new EditorController(buffer);
    controller.setSelections([
      { anchor: 3, active: 3 },
      { anchor: 9, active: 9 },
    ]);

    controller.backspace();
    controller.backspace();
    expect(buffer.text).toBe('adef\nijkl');
    expect(depth(controller)).toBe(1);
  });

  it('набор после чужой вставки не прилипает к ней', () => {
    const buffer = new TextBuffer('abc');
    const controller = new EditorController(buffer);
    controller.setSelections([{ anchor: 3, active: 3 }]);

    controller.applyEdits([{ start: 3, removed: '', inserted: 'X' }]);
    controller.type('Z');
    // Правка ассистента и мой набор — разные действия, даже если стоят рядом.
    expect(depth(controller)).toBe(2);
    controller.undo();
    expect(buffer.text).toBe('abcX');
  });

  it('набор с паузой распадается на шаги', () => {
    const buffer = new TextBuffer('one\ntwo');
    const controller = new EditorController(buffer);
    controller.setSelections([{ anchor: 1, active: 1 }]);

    controller.type('X');
    const past = (controller as unknown as { history: { past: { time: number }[] } }).history.past;
    past[past.length - 1]!.time -= 10_000; // пауза длиннее окна склейки
    controller.type('Y');

    expect(depth(controller)).toBe(2);
  });
});
