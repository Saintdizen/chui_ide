import { beforeEach, describe, expect, it, vi } from 'vitest';
import { optionId } from '../src/renderer/core/list-nav';
import { createPalette } from '../src/renderer/ui/palette';
import { createQuickOpen } from '../src/renderer/ui/quick-open';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Разметка списков для читалки (`listbox` по APG).
 *
 * Дыра была не в клавишах, а в том, что сказать. `role=listbox`/`option` у палитры
 * и быстрого открытия не было вовсе: читалка видела поле ввода и молчала о том,
 * что под ним есть варианты и один из них сейчас подсвечен. Человек нажимал `↓`,
 * слышал тишину и решал, что клавиша сломана.
 *
 * Проверяем три вещи: список объявлен, у каждой строки есть имя, и поле говорит
 * `aria-activedescendant`, какая строка текущая.
 */

// Мини-DOM не знает селекторов атрибутов — обходим узлы и спрашиваем атрибут.
function findAll(root: any, predicate: (node: any) => boolean): any[] {
  const found: any[] = [];
  const walk = (node: any): void => {
    if (predicate(node)) found.push(node);
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(root);
  return found;
}

const withRole = (root: any, role: string): any[] =>
  findAll(root, (node) => node.getAttribute?.('role') === role);

const COMMANDS = [
  { id: 'a.save', title: 'Сохранить файл', category: 'Файл', keybinding: null },
  { id: 'a.close', title: 'Закрыть файл', category: 'Файл' },
];

function openPalette(): HTMLElement {
  const palette = createPalette({
    commands: { list: () => COMMANDS, isEnabled: () => true, paletteVisible: () => COMMANDS },
    run: vi.fn(),
  } as never);
  document.body.append(palette.element as unknown as HTMLElement);
  palette.open();
  return palette.element as unknown as HTMLElement;
}

beforeEach(() => {
  installMiniDom();
});

describe('палитра команд: список объявлен', () => {
  it('поле — combobox, список — listbox, строки — option', () => {
    const root = openPalette();
    const combos = withRole(root, 'combobox');
    const lists = withRole(root, 'listbox');
    expect(combos.length).toBe(1);
    expect(lists.length).toBe(1);
    // Без связи поле не знает, что варианты — его.
    expect(combos[0]!.getAttribute('aria-controls')).toBe(lists[0]!.id);
    expect(withRole(root, 'option').length).toBeGreaterThan(0);
  });

  it('текущая строка названа и ссылка ведёт на живую строку', () => {
    const root = openPalette();
    const current = withRole(root, 'combobox')[0]!.getAttribute('aria-activedescendant');
    expect(current).toBeTruthy();
    const target = withRole(root, 'option').find((node) => node.id === current);
    expect(target).toBeTruthy();
    expect(target!.getAttribute('aria-selected')).toBe('true');
    expect(current).toBe(optionId(withRole(root, 'listbox')[0]!.id, 0));
  });
});

describe('быстрое открытие: та же разметка', () => {
  it('поле, список и объявленная текущая строка', async () => {
    const quick = createQuickOpen({
      rpc: { request: vi.fn(async () => ['/project/a.ts', '/project/b.ts']) } as never,
      workspace: { root: '/project' } as never,
      openFile: vi.fn(),
    } as never);
    await quick.open();
    const root = quick.element as unknown as HTMLElement;
    expect(withRole(root, 'combobox').length).toBe(1);
    expect(withRole(root, 'listbox').length).toBe(1);
    const current = withRole(root, 'combobox')[0]!.getAttribute('aria-activedescendant');
    const target = withRole(root, 'option').find((node) => node.id === current);
    expect(target).toBeTruthy();
    expect(target!.getAttribute('aria-selected')).toBe('true');
  });
});
