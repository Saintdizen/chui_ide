import type { DebugLaunchOptions } from '../../shared/api';
import type { EditorWorkspace } from '../editor/host/editor-workspace';
import type { ToastKind, ToastOptions } from '../ui/toast';
import type { DefineCommand } from './command-args';
import type { DebugController } from './debug';
import type { OpenEditors } from './open-editors';

export interface DebugCommandDeps {
  debug: DebugController;
  openEditors: OpenEditors;
  /** Курсор и точки останова — их читает и пишет ввод редактора. */
  editors: Pick<EditorWorkspace, 'cursor' | 'setBreakpoints'>;
  /** Панель отладки: показываем её, только когда действие удалось. */
  dock: { show(id: 'debug'): void };
  promptValue(options: { title: string; label: string; value: string }): Promise<string | null> | string | null;
  launchOptions: {
    open(options: { options: DebugLaunchOptions; onAccept(options: DebugLaunchOptions): void; onReset(): void }): void;
  };
  /** Есть ли активный файл, который вообще можно отлаживать. */
  activeDebuggableFile(): unknown;
  /** Запуск с параметрами: сам запуск знает про раннер и source-карты. */
  startDebug(options?: DebugLaunchOptions): Promise<void>;
  /** Параметры запуска держатся в памяти и запоминаются в сессии проекта. */
  getLaunchOptions(): DebugLaunchOptions;
  setLaunchOptions(options: DebugLaunchOptions): void;
  scheduleSave(): void;
  showToast(message: string, kind?: ToastKind, options?: ToastOptions): void;
}

/**
 * Команды отладки.
 *
 * Здесь только то, что видит человек: какое действие, какой горячей клавишей и что
 * сказать, если действие не вышло. Запуск, подключение и шаги исполняет
 * `DebugController` — команды его не дублируют и не переспрашивают состояние.
 */
export function registerDebugCommands(define: DefineCommand, deps: DebugCommandDeps): void {
  const { debug, openEditors, editors, dock, promptValue, launchOptions, showToast } = deps;

  const startDebug = (options?: DebugLaunchOptions) => deps.startDebug(options);

  define({ id: 'debug.start', title: 'Отладка: запустить файл', category: 'Отладка' }, () => startDebug());

  // Параметры запуска одним окном: аргументы, переменные окружения и рабочий каталог.
  // Заданные один раз, они держатся в памяти и подставляются в обычный F5.
  define({ id: 'debug.startWithOptions', title: 'Отладка: параметры запуска…', category: 'Отладка' }, () => {
    if (!deps.activeDebuggableFile()) return;
    launchOptions.open({
      options: deps.getLaunchOptions(),
      onAccept: (options) => {
        deps.setLaunchOptions(options);
        deps.scheduleSave();
        void startDebug(options);
      },
      onReset: () => {
        deps.setLaunchOptions({});
        deps.scheduleSave();
        showToast('Параметры запуска сброшены');
      },
    });
  });

  /**
   * Подключение к уже запущенному процессу.
   *
   * Спрашиваем только порт: хост и так локальный, а чем запущен процесс — видно по
   * открытому файлу (Python или Node). Раннер и файл тут ни при чём: отлаживать
   * будем то, что уже работает, а не запускать заново.
   */
  define({ id: 'debug.attach', title: 'Отладка: подключиться к процессу…', category: 'Отладка' }, async () => {
    const answer = await promptValue({
      title: 'Подключиться к процессу',
      label: 'Порт инспектора (node --inspect=127.0.0.1:9229)',
      value: '9229',
    });
    if (answer === null) return;

    const port = Number(answer.trim());
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      showToast('Порт — это число от 1 до 65535', 'error');
      return;
    }

    const target = openEditors.active?.languageId === 'python' ? 'python' : 'node';
    const result = await debug.attach({ port, target });
    if (!result.ok) showToast(result.message, 'error');
    else dock.show('debug');
  });

  // F5: не идёт отладка — начать, стоит на паузе — продолжить.
  define(
    { id: 'debug.continue', title: 'Отладка: продолжить / запустить', category: 'Отладка', keybinding: 'F5' },
    async () => {
      if (debug.get().phase === 'idle') await startDebug();
      else await debug.resume();
    },
  );
  define({ id: 'debug.stop', title: 'Отладка: остановить', category: 'Отладка', keybinding: 'Shift+F5' }, async () => {
    await debug.stop();
  });
  define(
    { id: 'debug.stepOver', title: 'Отладка: шаг с обходом', category: 'Отладка', keybinding: 'F10' },
    async () => {
      await debug.step('over');
    },
  );
  define(
    { id: 'debug.stepInto', title: 'Отладка: шаг с заходом', category: 'Отладка', keybinding: 'F11' },
    async () => {
      await debug.step('into');
    },
  );
  define(
    { id: 'debug.stepOut', title: 'Отладка: шаг из функции', category: 'Отладка', keybinding: 'Shift+F11' },
    async () => {
      await debug.step('out');
    },
  );

  // F9 — точка останова на строке курсора: привычное место, не уводя руки с клавиатуры.
  define(
    {
      id: 'debug.toggleBreakpoint',
      title: 'Отладка: переключить точку останова',
      category: 'Отладка',
      keybinding: 'F9',
    },
    async () => {
      const active = openEditors.active;
      if (!active) return;
      editors.setBreakpoints(active.path, await debug.toggleBreakpoint(active.path, editors.cursor().line));
    },
  );
}
