import { menuChecks, type MenuRole } from '../../shared/app-menu';
import { showApplicationMenu } from '../ui/app-menu';
import type { DefineCommand } from './command-args';
import { isPopupOpen } from '../ui/popup-menu';

/**
 * Команды вида: меню, палитра, быстрый переход к файлу и символу, браузер.
 * Общее у них то, что они не меняют документ — они показывают что-то поверх
 * него. Поэтому и порты здесь «показать», а не «изменить».
 */

/** Состояние того, что меню отмечает галочками. */
export interface AppViewFlags {
  readonly sidebarVisible: boolean;
  readonly rightVisible: boolean;
  readonly dockVisible: boolean;
  readonly activeDockId: string | null;
  /** Панель ИИ включена в настройках — иначе галка «Панель ИИ» врёт. */
  readonly aiEnabled: boolean;
}

export interface AppViewDeps {
  closePopupMenu(): void;
  flags(): AppViewFlags;
  menuAnchor: HTMLElement;
  execute(command: string, ...args: unknown[]): unknown;
  /** Действие, которое умеет только main: буфер обмена, масштаб, окно. */
  runMenuRole(role: MenuRole): void;
  promptValue(options: { title: string; label: string; value?: string }): Promise<string | null>;
  openBrowserPage(value: string): void;
  browserTabs: { readonly list: readonly unknown[]; closeAll(): void };
  rpc: { request(method: 'browser.viewCloseAll', payload: undefined): Promise<unknown> };
  syncEditorActions(): void;
  palette: { open(): void };
  quickOpen: { open(query: string): Promise<unknown> };
  symbolPicker: { open(): void };
}

export function registerAppViewCommands(define: DefineCommand, deps: AppViewDeps): void {
  const { rpc, flags, menuAnchor } = deps;

  define(
    {
      id: 'browser.open',
      title: 'Открыть страницу (браузер в редакторе)',
      category: 'Вид',
      keybinding: 'Ctrl+Shift+B',
      keywords: ['browser', 'url', 'страница', 'браузер', 'интернет'],
    },
    async () => {
      const value = await deps.promptValue({ title: 'Открыть страницу', label: 'Адрес', value: 'https://' });
      if (value === null || value.trim() === '') return;
      deps.openBrowserPage(value);
    },
  );

  // Закрыть все вкладки браузера: у файлов есть «закрыть другие», у страниц не было,
  // а их набирается много, когда ходишь по одному сайту.
  define({ id: 'browser.closeAll', title: 'Закрыть все вкладки браузера', category: 'Вид' }, () => {
    if (deps.browserTabs.list.length === 0) return;
    void rpc.request('browser.viewCloseAll', undefined).catch(() => undefined);
    deps.browserTabs.closeAll();
  });

  define({ id: 'app.showMenu', title: 'Меню приложения', category: 'Вид', keybinding: 'Alt+F10' }, () => {
    // Повторное нажатие закрывает: так ведёт себя системное меню, и так ждёт человек.
    if (isPopupOpen()) {
      deps.closePopupMenu();
      return;
    }
    const state = flags();
    menuAnchor.classList.add('is-menu-open');
    showApplicationMenu(
      menuAnchor,
      {
        execute: (command) => void deps.execute(command),
        runRole: (role) => deps.runMenuRole(role),
        // Галки считаются в момент показа: состояние меняется от нажатия к нажатию.
        checks: menuChecks({
          sidebar: state.sidebarVisible,
          aiPanel: state.aiEnabled && state.rightVisible,
          terminal: state.dockVisible && state.activeDockId === 'terminal',
        }),
      },
      () => menuAnchor.classList.remove('is-menu-open'),
    );
  });

  define({ id: 'palette.open', title: 'Палитра команд', category: 'Вид', keybinding: 'Ctrl+Shift+P' }, () => {
    // Действия редактора синхронизируем до открытия: палитра берёт их список.
    deps.syncEditorActions();
    deps.palette.open();
  });

  // Необязательный аргумент — начальный отбор: крошки и статусбар передают путь
  // папки, чтобы палитра сразу показала файлы рядом, а не весь проект.
  define(
    { id: 'file.quickOpen', title: 'Быстрое открытие файла', category: 'Навигация', keybinding: 'Ctrl+Shift+O' },
    (query) => {
      void deps.quickOpen.open(typeof query === 'string' ? query : '');
    },
  );

  define(
    {
      id: 'navigate.symbol',
      title: 'Перейти к символу в проекте',
      category: 'Навигация',
      keybinding: 'Ctrl+T',
      keywords: ['symbol', 'символ', 'класс', 'функция'],
    },
    () => deps.symbolPicker.open(),
  );
}
