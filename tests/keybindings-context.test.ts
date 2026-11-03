import { describe, expect, it } from 'vitest';
import type { CommandDescriptor } from '../src/renderer/core/commands';
import { CommandRegistry } from '../src/renderer/core/commands';
import type { Keybinding } from '../src/renderer/core/keybindings';
import { KeybindingService } from '../src/renderer/core/keybindings';

/**
 * Выход из дзена по Escape.
 *
 * Добавить `Escape` в умолчания было нельзя: он принадлежит редактору (снять
 * мультикурсор, закрыть поиск). Нужно сочетание, которое действует ТОЛЬКО в
 * своём положении — и проверяется на каждое нажатие, потому что положение
 * меняется на ходу.
 */
const registry = (log: string[]): CommandRegistry => {
  const commands = new CommandRegistry();
  const define = (id: string): void => {
    commands.register({ id, title: id, category: 'Вид' } as CommandDescriptor, () => {
      log.push(id);
    });
  };
  define('view.zen');
  define('editor.collapseSelections');
  return commands;
};

const press = (service: KeybindingService, key: string, handled = false): void => {
  const event = {
    key,
    code: key === 'Escape' ? 'Escape' : 'KeyZ',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    // `handled` — нажатие уже съедено кем-то в фазе перехвата (окно, поиск).
    defaultPrevented: handled,
    preventDefault: () => undefined,
  } as unknown as KeyboardEvent;
  // `handle` — приватный: дёргаем через attach-слушатель нельзя без окна,
  // поэтому зовём тем же путём, каким это делает браузер, — подменой слушателя.
  (service as unknown as { handle(e: KeyboardEvent): void }).handle(event);
};

const service = (log: string[], zen: { on: boolean }, unlessHandled = true): KeybindingService => {
  const defaults: Keybinding[] = [{ combo: 'Escape', command: 'editor.collapseSelections' }];
  const keys = new KeybindingService(registry(log), defaults);
  keys.bindInContext({ combo: 'Escape', command: 'view.zen', when: () => zen.on, unlessHandled });
  return keys;
};

describe('сочетание, зависящее от положения', () => {
  it('в дзене Escape выходит из дзена, а не снимает мультикурсор', () => {
    const log: string[] = [];
    const zen = { on: true };
    press(service(log, zen), 'Escape');
    // Ровно одна команда: иначе за одно нажатие случилось бы два дела.
    expect(log).toEqual(['view.zen']);
  });

  it('вне дзена Escape принадлежит редактору', () => {
    const log: string[] = [];
    press(service(log, { on: false }), 'Escape');
    expect(log).toEqual(['editor.collapseSelections']);
  });

  it('положение проверяется на каждое нажатие, а не один раз', () => {
    // Если бы условие читалось при подписке, дзен включался бы позже и Escape
    // продолжал бы снимать мультикурсор всю сессию.
    const log: string[] = [];
    const zen = { on: false };
    const keys = service(log, zen);
    press(keys, 'Escape');
    zen.on = true;
    press(keys, 'Escape');
    expect(log).toEqual(['editor.collapseSelections', 'view.zen']);
  });

  it('открытое окно ест Escape первым — дзен уступает молча', () => {
    // Иначе одно нажатие закрывало бы и модалку поверх, и сам дзен: слушатель
    // окна стоит раньше, но `preventDefault()` не мешает выполниться обоим.
    const log: string[] = [];
    press(service(log, { on: true }), 'Escape', true);
    expect(log).toEqual([]);
  });

  it('без отметки «съедено» в дзене Escape выходит', () => {
    const log: string[] = [];
    press(service(log, { on: true }), 'Escape', false);
    expect(log).toEqual(['view.zen']);
  });

  it('съеденное нажатие не достаётся никому — очередь обрывается', () => {
    // Раньше `unlessHandled` значило лишь «пропусти контекст», и Escape
    // проваливался в умолчания: окно закрылось бы, а заодно снялся бы
    // мультикурсор в редакторе.
    const log: string[] = [];
    press(service(log, { on: true }, false), 'Escape', true);
    expect(log).toEqual([]);
  });
});
