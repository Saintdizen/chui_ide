import { describe, expect, it } from 'vitest';
import { APP_MENU, menuAccelerators } from '../src/shared/app-menu';
import {
  bindingConflicts,
  bindingDisputes,
  bindingResolution,
  isMenuBinding,
  menuBindingId,
  menuComboOverrides,
  menuCommandOf,
  rendererOverrides,
  type BindingRow,
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
  it('Ctrl+= и Ctrl+- достались кеглю текста, а масштаб окна — с Shift', () => {
    // Раньше эти клавиши держали роли `zoomIn`/`zoomOut` (масштаб всего окна), и
    // нажатие до renderer не доходило вовсе. Теперь текст идёт командой, а окно —
    // отдельными сочетаниями; иначе кегль редактора клавишами не поменять никак.
    const accelerators = menuAccelerators();
    expect(accelerators.get('editor.fontZoomIn')).toBe('Ctrl+=');
    expect(accelerators.get('editor.fontZoomOut')).toBe('Ctrl+-');
    expect(accelerators.has('view.zoomIn')).toBe(false);
  });

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

describe('bindingDisputes: кто победил и почему (п.2)', () => {
  const row = (patch: Partial<BindingRow> & { id: string; combo: string }): BindingRow => ({
    command: patch.id,
    origin: 'renderer',
    isCustom: false,
    order: 0,
    ...patch,
  });

  it('без столкновений споров нет', () => {
    expect(bindingDisputes([row({ id: 'a', combo: 'Ctrl+K' }), row({ id: 'b', combo: 'Ctrl+J' })])).toEqual([]);
  });

  it('пустые сочетания не спорят', () => {
    expect(bindingDisputes([row({ id: 'a', combo: '' }), row({ id: 'b', combo: '' })])).toEqual([]);
  });

  it('две строки одной команды — не спор: какая бы ни сработала, команда та же', () => {
    const rows = [
      row({ id: 'file.save', combo: 'Ctrl+S' }),
      row({ id: 'menu:file.save', combo: 'Ctrl+S', origin: 'menu' }),
    ];
    expect(bindingDisputes(rows)).toEqual([]);
  });

  it('клавиша меню бьёт сочетание renderer: Electron перехватывает раньше окна', () => {
    const rows = [
      row({ id: 'file.save', combo: 'Ctrl+S' }),
      row({ id: 'menu:file.saveAs', combo: 'Ctrl+S', origin: 'menu' }),
    ];
    const [dispute] = bindingDisputes(rows);
    expect(dispute!.winner.id).toBe('menu:file.saveAs');
    expect(dispute!.winner.reason).toContain('раньше окна');
    expect(dispute!.losers.map((item) => item.id)).toEqual(['file.save']);
  });

  it('своё бьёт встроенное в одном доме', () => {
    const rows = [row({ id: 'a', combo: 'Ctrl+K' }), row({ id: 'b', combo: 'Ctrl+K', isCustom: true })];
    expect(bindingDisputes(rows)[0]!.winner.id).toBe('b');
  });

  it('своё в renderer НЕ бьёт клавишу меню: Electron всё равно первый', () => {
    const rows = [
      row({ id: 'a', combo: 'Ctrl+K', isCustom: true }),
      row({ id: 'menu:b', combo: 'Ctrl+K', origin: 'menu' }),
    ];
    expect(bindingDisputes(rows)[0]!.winner.id).toBe('menu:b');
  });

  it('из двух своих главнее заданное позже', () => {
    const rows = [
      row({ id: 'a', combo: 'Ctrl+K', isCustom: true, order: 3 }),
      row({ id: 'b', combo: 'Ctrl+K', isCustom: true, order: 0 }),
    ];
    expect(bindingDisputes(rows)[0]!.winner.id).toBe('b');
  });

  it('строки спора идут в порядке главенства', () => {
    const rows = [
      row({ id: 'x', combo: 'Ctrl+K' }),
      row({ id: 'menu:y', combo: 'Ctrl+K', origin: 'menu' }),
      row({ id: 'z', combo: 'Ctrl+K', isCustom: true }),
    ];
    expect(bindingDisputes(rows)[0]!.rows.map((item) => item.id)).toEqual(['menu:y', 'z', 'x']);
  });

  it('снятие отдаёт пустое сочетание проигравшим, победителя не трогает', () => {
    const rows = [row({ id: 'menu:a', combo: 'Ctrl+K', origin: 'menu' }), row({ id: 'b', combo: 'Ctrl+K' })];
    const [dispute] = bindingDisputes(rows);
    expect(bindingResolution(dispute!)).toEqual([{ command: 'b', combo: '' }]);
  });
});
