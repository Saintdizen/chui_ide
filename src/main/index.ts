import { app, BrowserWindow, nativeTheme } from 'electron';
import { PushTopic } from '../shared/api';
import { AiService } from './ai/service';
import { DebugService } from './debug/debug';
import { GitService } from './git/git';
import { HostClient } from './ipc/host';
import { pushToRenderers } from './ipc/push';
import { registerIpc } from './ipc/register';
import { LspService } from './lsp/lsp';
import { createApplicationMenu } from './menu';
import { projectEnv } from './project-env';
import { registerAppScheme, serveRenderer } from './protocol';
import { activateCommand, findEnvironments, pythonInterpreterFor } from './python/environments';
import { SessionStore } from './session-store';
import { SettingsStore } from './settings';
import { TerminalService } from './terminal/terminal';
import { WorkspaceService } from './workspace/workspace';
import { createWelcomeWindow } from './window';

// Схему нужно объявить до инициализации приложения, иначе Chromium не даст ей привилегий.
registerAppScheme();

// Палитра проекта описана в sRGB, а Chromium по умолчанию пересчитывает цвета
// в профиль монитора. На широкоохватном экране без нормального ICC-профиля
// sRGB-контент растягивается и выглядит кислотнее задуманного — один и тот же
// hex даёт разный цвет на разных машинах. Флаг прибивает цветовое пространство
// рендеринга к sRGB, и цвета совпадают с тем, что задано в CSS и в теме Monaco.
// Флаг читает Chromium до старта GPU-процесса, поэтому ставить его нужно здесь,
// а не после `whenReady`.
app.commandLine.appendSwitch('force-color-profile', 'srgb');

// Это не то же самое, что профиль дисплея: на Wayland Chromium ведёт окно через
// протокол цветоуправления `wp_color_manager_v1`, и тёмные тона уезжают вверх —
// токен `#1e1e1e` на экране даёт `#242424` (сдвиг +6), при этом чёрный и белый
// остаются на месте, то есть чужая кривая, а не прозрачность и не наложение.
// `force-color-profile` такой сдвиг не лечит: он про профиль монитора, а тут
// кривая на самом окне. Поэтому протокол отключаем, а значение флага дописываем
// к уже переданному из командной строки, а не заменяем его.
if (
  process.platform === 'linux' &&
  (process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY !== undefined)
) {
  const passed = app.commandLine.getSwitchValue('disable-features');
  app.commandLine.appendSwitch(
    'disable-features',
    passed === '' ? 'WaylandWpColorManagerV1' : `${passed},WaylandWpColorManagerV1`,
  );
}

// Второй экземпляр приложения не нужен: он бы писал в тот же settings.json.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  void app.whenReady().then(() => {
    const settings = new SettingsStore();

    // Схему выбирает main: после смены themeSource Chromium сам присылает renderer'у
    // новое значение prefers-color-scheme, и CSS переключается без правок в DOM.
    // А для того, что CSS не описать (Monaco, xterm), main шлёт resolved-схему
    // отдельным событием — полагаться на событие matchMedia в renderer нельзя.
    const pushTheme = (): void => {
      pushToRenderers(PushTopic.ThemeChanged, {
        theme: settings.get().appearance.theme,
        scheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      });
    };

    const applyTheme = (): void => {
      const choice = settings.get().appearance.theme;
      nativeTheme.themeSource = choice;
      const background = nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ececec';
      for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(background);
      pushTheme();
    };

    nativeTheme.on('updated', pushTheme);
    settings.onDidChange(applyTheme);
    applyTheme();

    const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
    const ai = new AiService(settings, workspace);
    // Терминал сам активирует venv проекта: иначе pip, запуск и тесты работают
    // системным питоном, и человеку приходится вспоминать про `source`.
    const terminals = new TerminalService(
      (topic, payload) => pushToRenderers(topic, payload),
      async () => {
        const root = workspace.rootPath();
        if (!root) return null;
        const environments = await findEnvironments(root, process.platform);
        const primary = environments.find((environment) => environment.primary);
        return primary ? activateCommand(root, primary.path, process.platform) : null;
      },
      // `.env` проекта читаем на каждую сессию: файл правят во время работы, и
      // перезапуск IDE ради новой переменной — лишний.
      () => projectEnv(workspace.rootPath()),
    );
    // Git ничего не хранит сам: корень берётся у рабочей папки, а об изменениях
    // узнаём после своих же операций и после сохранения файла.
    const git = new GitService(() => workspace.rootPath(), (topic, payload) => pushToRenderers(topic, payload));
    // Языковые серверы — внешние процессы: настройка задаёт команду, main держит их жизненный цикл.
    // Сервер подсказок запускаем с интерпретатором окружения: иначе он не видит
    // установленные пакеты и не подсказывает импорты. Проверка путей — синхронная:
    // спрашивать диск на каждый запрос сервера дёшево, а кешировать нечего.
    const lsp = new LspService(
      () => workspace.rootPath(),
      () => settings.get().lsp,
      (topic, payload) => pushToRenderers(topic, payload),
      // Тот же выбор, что у запуска: настройка важнее окружения проекта. Иначе
      // подсказки шли бы с одного питона, а код запускался другим.
      () => pythonInterpreterFor(workspace.rootPath(), settings.get().run.pythonPath),
      // Тот же `.env`, что у терминала и запуска: сервер видит то же окружение.
      () => projectEnv(workspace.rootPath()),
    );
    // Отладчик: сессия debugpy по DAP. Интерпретатор тот же, что у запуска и тестов,
    // а `.env` проекта — тот же, что у терминала и языкового сервера.
    const debug = new DebugService(
      (topic, payload) => pushToRenderers(topic, payload),
      () => workspace.rootPath(),
      () => pythonInterpreterFor(workspace.rootPath(), settings.get().run.pythonPath),
      () => projectEnv(workspace.rootPath()),
    );
    // Сессия редактора: вкладки, раскрытые папки, видимость панелей — на каждый проект.
    const sessions = new SessionStore();

    registerIpc({ settings, workspace, ai, terminals, git, lsp, debug, sessions, host: new HostClient() });
    serveRenderer();
    createApplicationMenu();
    // Приложение начинается со списка проектов: окно IDE откроется после
    // того, как пользователь выберет папку или склонирует репозиторий.
    createWelcomeWindow();

    app.on('will-quit', () => {
      terminals.dispose();
      lsp.dispose();
      debug.dispose();
      workspace.dispose();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWelcomeWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
