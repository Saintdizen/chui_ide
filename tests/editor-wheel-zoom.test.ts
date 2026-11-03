import { beforeEach, describe, expect, it } from 'vitest';
import { EditorController } from '../src/renderer/editor/input/editor-controller';
import { EditorInputBinding } from '../src/renderer/editor/input/editor-input';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { EditorView } from '../src/renderer/editor/view/editor-view';
import { installMiniDom } from './helpers/mini-dom';

/**
 * `Ctrl`+колесо над редактором (`renderer/editor/input/editor-input.ts`).
 *
 * Проверяется связка «событие → команда»: сам размер шрифта живёт в настройках
 * приложения, редактор лишь просит шаг. Важно и обратное: без `Ctrl` колесо — это
 * прокрутка, а дельта ноль (тачпад в покое) не должна считаться шагом.
 */

function setup() {
  const commands: string[] = [];
  const host = document.createElement('div');
  const buffer = new TextBuffer('a\nb\n');
  const view = new EditorView(host as unknown as HTMLElement, buffer, {});
  const controller = new EditorController(buffer);
  new EditorInputBinding(view, controller, { onCommand: (command) => commands.push(command) });
  return { commands, view };
}

function wheel(view: EditorView, init: { deltaY: number; ctrlKey?: boolean; metaKey?: boolean }) {
  const event = {
    type: 'wheel',
    deltaY: init.deltaY,
    ctrlKey: init.ctrlKey === true,
    metaKey: init.metaKey === true,
    defaultPrevented: false,
    prevented: false,
    preventDefault() {
      this.defaultPrevented = true;
      this.prevented = true;
    },
  };
  view.element.dispatchEvent(event as never);
  return event;
}

describe('Ctrl+колесо в редакторе', () => {
  beforeEach(() => {
    installMiniDom();
  });

  it('вверх — шаг больше, вниз — меньше', () => {
    const { commands, view } = setup();
    wheel(view, { deltaY: -1, ctrlKey: true });
    wheel(view, { deltaY: 1, ctrlKey: true });
    expect(commands).toEqual(['fontSizeUp', 'fontSizeDown']);
  });

  it('Command на macOS работает так же, как Ctrl', () => {
    const { commands, view } = setup();
    wheel(view, { deltaY: -1, metaKey: true });
    expect(commands).toEqual(['fontSizeUp']);
  });

  it('без модификатора — обычная прокрутка, редактор молчит', () => {
    const { commands, view } = setup();
    const event = wheel(view, { deltaY: -100 });
    expect(commands).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('нулевая дельта (тачпад в покое) — не шаг', () => {
    const { commands, view } = setup();
    wheel(view, { deltaY: 0, ctrlKey: true });
    expect(commands).toEqual([]);
  });

  it('зум браузера гасится: иначе страница едет вместе со шрифтом', () => {
    // Мини-DOM отдаёт копию события — признàк гашения читаем на самом объекте обработчиком.
    const { view } = setup();
    const event = wheel(view, { deltaY: -1, ctrlKey: true });
    expect(event.prevented).toBe(true);
  });
});
