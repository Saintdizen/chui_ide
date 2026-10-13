import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { EditorController } from '../src/renderer/editor/input/editor-controller';
import { EmmetExpander } from '../src/renderer/editor/input/emmet';

/**
 * Emmet по Tab: перехватчик раскрывает сокращение перед кареткой. Проверяем и раскрытие,
 * и то, что чужая клавиша/язык/выделение уходят дальше (тогда Tab работает отступом).
 */

function make(
  text: string,
  language = 'html',
): { expander: EmmetExpander; controller: EditorController; buffer: TextBuffer } {
  const buffer = new TextBuffer(text);
  const controller = new EditorController(buffer);
  const expander = new EmmetExpander({
    controller,
    language: () => language,
    indent: () => '  ',
    enabled: () => true,
  });
  return { expander, controller, buffer };
}

const tab = (over: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({
    key: 'Tab',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault() {},
    ...over,
  }) as KeyboardEvent;

describe('EmmetExpander', () => {
  it('Tab раскрывает сокращение разметки', () => {
    const { expander, controller, buffer } = make('ul>li');
    controller.setSelection({ anchor: 5, active: 5 });

    expect(expander.handleKey(tab())).toBe(true);
    expect(buffer.text).toBe('<ul>\n  <li></li>\n</ul>');
  });

  it('каретка встаёт внутрь элемента', () => {
    const { expander, controller, buffer } = make('li');
    controller.setSelection({ anchor: 2, active: 2 });
    expander.handleKey(tab());

    const text = buffer.text;
    expect(controller.selection.active).toBe(text.indexOf('<li>') + '<li>'.length);
  });

  it('раскрытие идёт одной правкой — отменяется одним шагом', () => {
    const { expander, controller, buffer } = make('div>span');
    controller.setSelection({ anchor: 8, active: 8 });
    expander.handleKey(tab());

    controller.undo();
    expect(buffer.text).toBe('div>span');
  });

  it('сокращение стилей раскрывается в свойство', () => {
    const { expander, controller, buffer } = make('m10', 'css');
    controller.setSelection({ anchor: 3, active: 3 });

    expect(expander.handleKey(tab())).toBe(true);
    expect(buffer.text).toBe('margin: 10px;');
  });

  it('Shift+Tab не перехватываем — это снятие отступа', () => {
    const { expander, controller } = make('ul>li');
    controller.setSelection({ anchor: 5, active: 5 });
    expect(expander.handleKey(tab({ shiftKey: true }))).toBe(false);
  });

  it('в чужом языке Emmet не работает', () => {
    const { expander, controller } = make('ul>li', 'typescript');
    controller.setSelection({ anchor: 5, active: 5 });
    expect(expander.handleKey(tab())).toBe(false);
  });

  it('не сокращение — клавишу не трогаем', () => {
    const { expander, controller } = make('привет мир');
    controller.setSelection({ anchor: 10, active: 10 });
    expect(expander.handleKey(tab())).toBe(false);
  });

  it('при выделении не раскрываем', () => {
    const { expander, controller } = make('ul>li');
    controller.setSelection({ anchor: 0, active: 5 });
    expect(expander.handleKey(tab())).toBe(false);
  });

  it('выключенный Emmet клавишу не трогает', () => {
    const buffer = new TextBuffer('ul>li');
    const controller = new EditorController(buffer);
    const expander = new EmmetExpander({
      controller,
      language: () => 'html',
      indent: () => '  ',
      enabled: () => false,
    });
    controller.setSelection({ anchor: 5, active: 5 });
    expect(expander.handleKey(tab())).toBe(false);
  });
});
