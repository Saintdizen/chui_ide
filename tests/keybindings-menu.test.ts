import { describe, expect, it } from 'vitest';
import { APP_MENU, menuAccelerators } from '../src/shared/app-menu';
import {
  bindingConflicts,
  isMenuBinding,
  menuBindingId,
  menuComboOverrides,
  menuCommandOf,
  rendererOverrides,
} from '../src/shared/keybindings';

describe('ключи переопределений: меню и renderer', () => {
  it('приставка отделяет клавишу меню от сочетания renderer', () => {
    expect(menuBindingId('file.save')).toBe('menu:file.save');
    expect(isMenuBinding('menu:file.save')).toBe(true);
    expect(isMenuBinding('file.save')).toBe(false);
    expect(menuCommandOf('menu:file.save')).toBe('file.save');
    expect(menuCommandOf('file.save')).toBe('file.save');
  });

  it('карта меню: только ключи с приставкой, без приставки в имени команды', () => {
    const map = menuComboOverrides([
      { command: 'menu:file.save', combo: 'Ctrl+Alt+S' },
      { command: 'editor.undo', combo: 'Ctrl+Z' },
    ]);
    expect([...map.entries()]).toEqual([['file.save', 'Ctrl+Alt+S']]);
  });

  it('пустое сочетание меню сохраняется как «снять»', () => {
    const map = menuComboOverrides([{ command: 'menu:file.save', combo: '' }]);
    expect(map.get('file.save')).toBe('');
  });

  it('переопределения renderer отбрасывают клавиши меню', () => {
    const overrides = [
      { command: 'menu:file.save', combo: 'Ctrl+Alt+S' },
      { command: 'editor.undo', combo: 'Ctrl+U' },
    ];
    expect(rendererOverrides(overrides)).toEqual([{ command: 'editor.undo', combo: 'Ctrl+U' }]);
  });
});

describe('bindingConflicts', () => {
  it('одно сочетание у двух команд — столкновение', () => {
    expect(
      bindingConflicts([
        { combo: 'Ctrl+K', command: 'a' },
        { combo: 'Ctrl+K', command: 'b' },
        { combo: 'Ctrl+J', command: 'c' },
      ]),
    ).toEqual([{ combo: 'Ctrl+K', commands: ['a', 'b'] }]);
  });

  it('пустые сочетания (снятые) не считаем', () => {
    expect(
      bindingConflicts([
        { combo: '', command: 'a' },
        { combo: '', command: 'b' },
      ]),
    ).toEqual([]);
  });

  it('без столкновений — пусто', () => {
    expect(
      bindingConflicts([
        { combo: 'Ctrl+K', command: 'a' },
        { combo: 'Ctrl+J', command: 'b' },
      ]),
    ).toEqual([]);
  });
});

describe('menuAccelerators', () => {
  it('собирает встроенные клавиши команд из всех групп меню', () => {
    const map = menuAccelerators();
    expect(map.get('file.save')).toBe('Ctrl+S');
    expect(map.get('palette.open')).toBe('Ctrl+Shift+P');
    // Пункт без клавиши в карту не попадает.
    expect(map.has('view.showOutline')).toBe(false);
  });

  it('покрывает ровно те команды меню, у которых клавиша есть', () => {
    const expected = new Set<string>();
    const walk = (nodes: typeof APP_MENU): void => {
      for (const node of nodes) {
        if (node.children) walk(node.children);
        if (node.command && node.accelerator) expected.add(node.command);
      }
    };
    walk(APP_MENU);
    expect([...menuAccelerators().keys()].sort()).toEqual([...expected].sort());
  });

  it('переопределение заменяет клавишу пункта', () => {
    const map = menuAccelerators(new Map([['file.save', 'Ctrl+Alt+S']]));
    expect(map.get('file.save')).toBe('Ctrl+Alt+S');
  });

  it('пустое переопределение снимает клавишу', () => {
    const map = menuAccelerators(new Map([['file.save', '']]));
    expect(map.has('file.save')).toBe(false);
  });

  it('переопределение назначает клавишу пункту, у которого её не было', () => {
    const map = menuAccelerators(new Map([['view.showOutline', 'Ctrl+Alt+O']]));
    expect(map.get('view.showOutline')).toBe('Ctrl+Alt+O');
  });
});
