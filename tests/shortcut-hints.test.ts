import { describe, expect, it } from 'vitest';
import type { CommandDescriptor } from '../src/renderer/core/commands';
import { shortcutFor, shortcutSources, tooltipFor } from '../src/renderer/core/shortcut-hints';

/**
 * П.1: «Горячие клавиши открываемы».
 *
 * Источник (Zed `development-ui-checklist`: «Are shortcuts discoverable
 * (tooltips, menus, docs)?», JB `action-system`): сочетание должно быть
 * видно там, где живёт действие.
 *
 * Механизм (меню с `hint`, палитра с клавишей, подсказки) в программе УЖЕ БЫЛ.
 * Дыра была в источнике: сочетание у действия имеет ДВА дома — клавиши renderer
 * (`core/default-keybindings.ts`) и акселераторы Electron (`shared/app-menu.ts`),
 * и эти два списка никто не сводил.
 */
const source = (renderer: [string, string][], menu: [string, string][]) =>
  shortcutSources(
    renderer.map(([id, keybinding]) => ({ id, title: id, keybinding }) as CommandDescriptor),
    new Map(menu),
  );

describe('источник сочетаний', () => {
  it('видны оба дома: клавиши renderer и акселераторы меню', () => {
    const src = source([['editor.find', 'Ctrl+F']], [['view.toggleSidebar', 'Ctrl+B']]);
    expect(shortcutFor('editor.find', src)?.combo).toBe('Ctrl+F');
    expect(shortcutFor('view.toggleSidebar', src)?.combo).toBe('Ctrl+B');
  });

  it('команда без сочетания — это не ошибка, а ответ «нет»', () => {
    expect(shortcutFor('workspace.refresh', source([], []))).toBeNull();
  });

  it('команды без keybinding не попадают в источник', () => {
    const src = shortcutSources([{ id: 'a', title: 'A' } as CommandDescriptor], new Map());
    expect(src.rendererBindings.size).toBe(0);
  });
});

describe('кто победил при двух сочетаниях', () => {
  // Главная грабля блока. Правило держится не на теории, а на замере живым окном
  // (`npm run probe:shortcuts`, шаг 4): `Ctrl+P` и `Ctrl+Alt+E` есть и в меню, и
  // в renderer — и в обоих случаях сработала запись renderer. Значит окно обгоняет
  // меню, и показывать надо его сочетание. Обратный порядок тут не «менее верен»,
  // а прямо врёт: человек увидит `Ctrl+B`, а сработает не оно.
  it('при расхождении верно то, что сработает, — renderer', () => {
    const src = source([['view.toggleSidebar', 'Ctrl+Alt+B']], [['view.toggleSidebar', 'Ctrl+B']]);
    const found = shortcutFor('view.toggleSidebar', src);
    expect(found).toEqual({ combo: 'Ctrl+Alt+B', from: 'renderer' });
  });

  it('акселератор меню не подменяет своё сочетание', () => {
    const src = source([['view.toggleSidebar', 'Ctrl+Alt+B']], [['view.toggleSidebar', 'Ctrl+B']]);
    expect(shortcutFor('view.toggleSidebar', src)?.combo).not.toBe('Ctrl+B');
  });

  it('меню остаётся источником для команд, которых у окна нет', () => {
    // `role`-пункты («Свернуть окно») в реестре команд не живут: их клавиша — только в меню.
    const src = source([], [['window.minimize', 'Ctrl+M']]);
    expect(shortcutFor('window.minimize', src)).toEqual({ combo: 'Ctrl+M', from: 'menu' });
  });

  it('совпадающие сочетания — источник renderer', () => {
    const src = source([['x', 'Ctrl+K']], [['x', 'Ctrl+K']]);
    expect(shortcutFor('x', src)?.from).toBe('renderer');
  });
});

describe('подсказка кнопки', () => {
  it('называет действие и сочетание', () => {
    const src = source([], [['view.toggleSidebar', 'Ctrl+B']]);
    expect(tooltipFor('Боковая панель', 'view.toggleSidebar', src)).toBe('Боковая панель (Ctrl+B)');
  });

  it('без сочетания не рисует пустые скобки', () => {
    const text = tooltipFor('Обновить', 'workspace.refresh', source([], []));
    expect(text).toBe('Обновить');
    expect(text).not.toContain('()');
  });
});
