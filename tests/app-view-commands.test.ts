import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAppViewCommands, type AppViewDeps, type AppViewFlags } from '../src/renderer/core/app-view-commands';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Команды вида (`renderer/core/app-view-commands.ts`).
 *
 * Сами команды ничего не меняют в документе — они показывают что-то поверх него.
 * Проверяются решения, на которых спотыкается человек: пустой адрес не открывается,
 * повторное нажатие меню его закрывает, браузер без вкладок не зовёт main.
 *
 * Меню и попап подменены: тест смотрит, какие команды зарегистрированы и что они
 * делают, а не как выглядит выпадашка.
 */

const shownMenu = vi.hoisted(() => vi.fn());
const popupOpen = vi.hoisted(() => ({ value: false }));
vi.mock('../src/renderer/ui/app-menu', () => ({ showApplicationMenu: shownMenu }));
vi.mock('../src/renderer/ui/popup-menu', () => ({
  isPopupOpen: () => popupOpen.value,
  showPopupMenu: vi.fn(),
  closePopupMenu: vi.fn(),
}));

const FLAGS: AppViewFlags = {
  sidebarVisible: true,
  rightVisible: false,
  dockVisible: true,
  activeDockId: 'terminal',
  aiEnabled: true,
};

function setup(overrides: Partial<AppViewDeps> = {}) {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const deps = {
    closePopupMenu: vi.fn(),
    flags: () => FLAGS,
    menuAnchor: document.createElement('div') as unknown as HTMLElement,
    execute: vi.fn(),
    runMenuRole: vi.fn(),
    promptValue: vi.fn(async () => 'https://example.com'),
    openBrowserPage: vi.fn(),
    browserTabs: { list: [], closeAll: vi.fn() },
    rpc: { request: vi.fn(async () => ({})) },
    syncEditorActions: vi.fn(),
    palette: { open: vi.fn() },
    quickOpen: { open: vi.fn() },
    symbolPicker: { open: vi.fn() },
    ...overrides,
  } as unknown as AppViewDeps;
  registerAppViewCommands(
    ((spec: { id: string }, run: (...args: unknown[]) => unknown) => {
      commands.set(spec.id, run);
    }) as never,
    deps,
  );
  return { commands, deps };
}

describe('браузер', () => {
  beforeEach(() => {
    installMiniDom();
  });

  it('пустой адрес не открывает страницу', async () => {
    // В поле стоит заготовка «https://», и нажатие Enter без адреса не должно
    // открывать пустую страницу.
    const { commands, deps } = setup({ promptValue: async () => '   ' });

    await commands.get('browser.open')?.();

    expect(deps.openBrowserPage).not.toHaveBeenCalled();
  });

  it('отмена ввода не открывает страницу', async () => {
    const { commands, deps } = setup({ promptValue: async () => null });

    await commands.get('browser.open')?.();

    expect(deps.openBrowserPage).not.toHaveBeenCalled();
  });

  it('введённый адрес открывается как есть', async () => {
    const { commands, deps } = setup({ promptValue: async () => 'https://example.com/a' });

    await commands.get('browser.open')?.();

    expect(deps.openBrowserPage).toHaveBeenCalledWith('https://example.com/a');
  });

  it('«закрыть все» без вкладок не беспокоит main', () => {
    const { commands, deps } = setup({ browserTabs: { list: [], closeAll: vi.fn() } as never });

    commands.get('browser.closeAll')?.();

    expect(deps.rpc.request).not.toHaveBeenCalled();
    expect(deps.browserTabs.closeAll).not.toHaveBeenCalled();
  });

  it('«закрыть все» с вкладками просит main и чистит список', () => {
    const closeAll = vi.fn();
    const { commands, deps } = setup({ browserTabs: { list: [{}], closeAll } as never });

    commands.get('browser.closeAll')?.();

    expect(deps.rpc.request).toHaveBeenCalledWith('browser.viewCloseAll', undefined);
    expect(closeAll).toHaveBeenCalled();
  });
});

describe('меню приложения', () => {
  beforeEach(() => {
    installMiniDom();
    shownMenu.mockClear();
    popupOpen.value = false;
  });

  it('показывает меню и помечает кнопку открытой', () => {
    const { commands, deps } = setup();

    commands.get('app.showMenu')?.();

    expect(shownMenu).toHaveBeenCalled();
    expect(
      (deps.menuAnchor as unknown as { classList: { contains(n: string): boolean } }).classList.contains(
        'is-menu-open',
      ),
    ).toBe(true);
  });

  it('повторное нажатие закрывает открытое меню', () => {
    // Так ведёт себя системное меню, и так ждёт человек.
    popupOpen.value = true;
    const { commands, deps } = setup();

    commands.get('app.showMenu')?.();

    expect(deps.closePopupMenu).toHaveBeenCalled();
    expect(shownMenu).not.toHaveBeenCalled();
  });

  it('галки считаются в момент показа, а не при сборке команд', () => {
    // Состояние меняется от нажатия к нажатию: заранее посчитанные галки врали бы.
    const { commands } = setup();
    commands.get('app.showMenu')?.();
    // Ключи галок — идентификаторы команд (MENU_TOGGLES), а не имена флагов.
    const first = shownMenu.mock.calls[0]?.[1] as { checks: Record<string, boolean> };

    expect(first.checks['view.toggleSidebar']).toBe(true);
    expect(first.checks['view.showTerminal']).toBe(true);
    // Правая панель закрыта — галки «Панель ИИ» нет, хотя тумблер включён.
    expect(first.checks['ai.toggle']).toBe(false);
  });
});

describe('палитра и переходы', () => {
  beforeEach(() => {
    installMiniDom();
  });

  it('палитра и быстрый переход открываются', () => {
    const { commands, deps } = setup();

    commands.get('palette.open')?.();
    commands.get('file.quickOpen')?.('src/');

    expect((deps.palette as unknown as { open(): void }).open).toHaveBeenCalled();
    // Начальный отбор — от крошек и статусбара: палитра сразу показывает нужную папку.
    expect((deps.quickOpen as unknown as { open(q: string): void }).open).toHaveBeenCalledWith('src/');
  });

  it('быстрое открытие без аргумента открывает весь проект', () => {
    const { commands, deps } = setup();

    commands.get('file.quickOpen')?.();

    expect((deps.quickOpen as unknown as { open(q: string): void }).open).toHaveBeenCalledWith('');
  });

  it('действия редактора синхронизируются до открытия палитры', () => {
    // Палитра берёт список действий из состояния: без синхронизации она покажет
    // пункты, которые недоступны для текущего выделения.
    const { commands, deps } = setup();

    commands.get('palette.open')?.();

    expect(deps.syncEditorActions).toHaveBeenCalled();
  });

  it('пункты-роли уходят в свой обработчик, а команды — в общий', () => {
    const { commands, deps } = setup();
    commands.get('app.showMenu')?.();
    const menu = shownMenu.mock.calls[0]?.[1] as {
      execute: (command: string) => void;
      runRole: (role: string) => void;
    };

    menu.execute('view.toggleSidebar');
    menu.runRole('copy');

    expect(deps.execute).toHaveBeenCalledWith('view.toggleSidebar');
    expect(deps.runMenuRole).toHaveBeenCalledWith('copy');
  });
});
