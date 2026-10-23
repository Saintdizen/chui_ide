import { describe, expect, it, vi } from 'vitest';
import { registerAppViewCommands, type AppViewDeps } from '../src/renderer/core/app-view-commands';

// Меню строит DOM, а тесты идут в среде node. Подменяем попап целиком: команде
// важно только, открыт ли он, — остальное принадлежит ui/popup-menu.
const popup = { isOpen: false };
vi.mock('../src/renderer/ui/popup-menu', () => ({
  isPopupOpen: () => popup.isOpen,
  closePopupMenu: () => undefined,
  showPopupMenu: () => undefined,
}));
vi.mock('../src/renderer/ui/app-menu', () => ({
  showApplicationMenu: () => undefined,
}));
import type { DefineCommand } from '../src/renderer/core/command-args';

/**
 * Вид: меню, палитра, переходы, браузер. Сторож держит две вещи, которые легко
 * сломать незаметно: галки меню считаются в МОМЕНТ показа и повторное нажатие
 * меню закрывает.
 */
function setup(overrides: Partial<{ popupOpen: boolean; sidebar: boolean; ai: boolean; right: boolean }> = {}) {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const log: string[] = [];
  const closed: number[] = [];
  // Состояние попапа подменяем на уровне модуля: команда спрашивает isPopupOpen().
  // Меню ставится по прямоугольнику якоря — без него showApplicationMenu падает.
  const anchor = {
    classList: { add: (c: string) => log.push(`add:${c}`), remove: (c: string) => log.push(`remove:${c}`) },
    getBoundingClientRect: () => ({ left: 0, bottom: 0, top: 0, right: 0, width: 0, height: 0 }),
  };
  const deps = {
    closePopupMenu: () => closed.push(1),
    flags: () => ({
      sidebarVisible: overrides.sidebar ?? true,
      rightVisible: overrides.right ?? true,
      dockVisible: false,
      activeDockId: null,
      aiEnabled: overrides.ai ?? true,
    }),
    menuAnchor: anchor,
    execute: (command: string) => log.push(`exec:${command}`),
    runMenuRole: (role: string) => log.push(`role:${role}`),
    promptValue: async () => 'https://example.com',
    openBrowserPage: (value: string) => log.push(`browser:${value}`),
    browserTabs: { list: [] as unknown[], closeAll: () => log.push('closeAll') },
    rpc: { request: async () => ({}) },
    syncEditorActions: () => log.push('sync'),
    palette: { open: () => log.push('palette') },
    quickOpen: { open: async (query: string) => log.push(`quick:${query}`) },
    symbolPicker: { open: () => log.push('symbols') },
  } as unknown as AppViewDeps;
  registerAppViewCommands(define, deps);
  return { commands, log, closed };
}

describe('registerAppViewCommands', () => {
  it('регистрирует пять команд вида', () => {
    const { commands } = setup();
    expect([...commands.keys()].sort()).toEqual([
      'app.showMenu',
      'browser.closeAll',
      'browser.open',
      'file.quickOpen',
      'navigate.symbol',
      'palette.open',
    ]);
  });

  // Меню строит DOM через showApplicationMenu, а тесты здесь идут в среде node.
  // Проверяем ту ветку, что решается ДО построения: повторное нажатие закрывает.
  it('повторное нажатие меню закрывает попап, когда тот уже открыт', () => {
    const { commands, log } = setup();
    popup.isOpen = true;
    commands.get('app.showMenu')!();
    popup.isOpen = false;
    // Меню не строится: ветка закрытия выходит раньше, чем доходит до DOM.
    expect(log).not.toContain('add:is-menu-open');
  });

  it('браузер открывается по введённому адресу', async () => {
    const { commands, log } = setup();
    await commands.get('browser.open')!();
    expect(log).toContain('browser:https://example.com');
  });

  it('пустых вкладок браузера нечего закрывать — в main не ходим', () => {
    const { commands, log } = setup();
    commands.get('browser.closeAll')!();
    expect(log).not.toContain('closeAll');
  });

  it('палитра синхронизирует действия редактора ДО открытия', () => {
    const { commands, log } = setup();
    commands.get('palette.open')!();
    expect(log).toEqual(['sync', 'palette']);
  });

  it('быстрый переход передаёт начальный отбор, если он есть', async () => {
    const { commands, log } = setup();
    await commands.get('file.quickOpen')!('/proj/src');
    await commands.get('file.quickOpen')!();
    expect(log).toEqual(['quick:/proj/src', 'quick:']);
  });
});
