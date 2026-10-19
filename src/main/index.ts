import { app, BrowserWindow, shell } from 'electron';
import { statSync } from 'node:fs';
import path from 'node:path';
import { PushTopic, type WorkspaceChangedPayload } from '../shared/api';
import { folderFromCommandLine, type CommandLineFolder } from '../shared/cli';
import { AiService } from './ai/service';
import { BrowserService } from './browser/browser';
import { AgentBrowser } from './browser/agent-browser';
import { BrowserPanel } from './browser/panel';
import { DebugService } from './debug/debug';
import { installDiagnostics } from './diagnostics';
import { GitService } from './git/git';
import { HostClient } from './ipc/host';
import { pushToRenderers } from './ipc/push';
import { openProjectFolder, registerIpc } from './ipc/register';
import { LspService } from './lsp/lsp';
import { detectLspSources } from './lsp/detect';
import { createSeedProvider } from './lsp/seed';
import { McpService } from './mcp/mcp';
import { createApplicationMenu } from './menu';
import { projectEnv } from './project-env';
import { SandboxService } from './sandbox/sandbox';
import { registerAppScheme, serveRenderer } from './protocol';
import { WINDOW_BACKGROUND } from '../shared/colors';
import { activationForInterpreter, pythonInterpreterFor, venvDirOfPython } from './python/environments';
import { SessionStore } from './session-store';
import { ProjectConfigStore } from './project-config';
import { ReviewStore } from './project/review-store';
import { HistoryStore } from './project/history-store';
import { SettingsStore } from './settings';
import { SymbolIndexer } from './symbols/indexer';
import { SymbolStore } from './symbols/store';
import { TerminalService } from './terminal/terminal';
import { WorkspaceService } from './workspace/workspace';
import { getIdeWindow, isWaylandSession, openWelcomeWindow } from './window';

// Схему нужно объявить до инициализации приложения, иначе Chromium не даст ей привилегий.
registerAppScheme();

// Палитра проекта описана в sRGB, а Chromium по умолчанию пересчитывает цвета
// в профиль монитора. На широкоохватном экране без нормального ICC-профиля
// sRGB-контент растягивается и выглядит кислотнее задуманного — один и тот же
// hex даёт разный цвет на разных машинах. Флаг прибивает цветовое пространство
// рендеринга к sRGB, и цвета совпадают с тем, что задано в CSS и в теме редактора.
// Флаг читает Chromium до старта GPU-процесса, поэтому ставить его нужно здесь,
// а не после `whenReady`.
app.commandLine.appendSwitch('force-color-profile', 'srgb');

// Скроллбары-оверлеи: полоса всплывает поверх содержимого и не занимает ширину
// области прокрутки, как в системной настройке «полосы только при прокрутке».
// Флаг читает Chromium до старта рендерера, поэтому ставить его нужно здесь.
// Значение дописываем к уже переданному из командной строки, а не заменяем.
// Важно: любая кастомизация `::-webkit-scrollbar` в CSS отключает оверлей —
// своих правил полос в стилях быть не должно (см. `styles/main.css`).
{
  const passed = app.commandLine.getSwitchValue('enable-features');
  app.commandLine.appendSwitch('enable-features', passed === '' ? 'OverlayScrollbar' : `${passed},OverlayScrollbar`);
}

// Это не то же самое, что профиль дисплея: на Wayland Chromium ведёт окно через
// протокол цветоуправления `wp_color_manager_v1`, и тёмные тона уезжают вверх —
// токен `#1e1e1e` на экране даёт `#242424` (сдвиг +6), при этом чёрный и белый
// остаются на месте, то есть чужая кривая, а не прозрачность и не наложение.
// `force-color-profile` такой сдвиг не лечит: он про профиль монитора, а тут
// кривая на самом окне. Поэтому протокол отключаем, а значение флага дописываем
// к уже переданному из командной строки, а не заменяем его.
if (isWaylandSession()) {
  const passed = app.commandLine.getSwitchValue('disable-features');
  app.commandLine.appendSwitch(
    'disable-features',
    passed === '' ? 'WaylandWpColorManagerV1' : `${passed},WaylandWpColorManagerV1`,
  );
}

// Сбои ловим раньше остального: тогда падение не выглядит просто закрывшимся
// окном, а оседает в userData вместе с причиной.
installDiagnostics();

/**
 * Папка, которую просят открыть снаружи: `chui_iDE ~/project`, второй запуск с
 * путём или `open -a` на macOS. До готовности приложения запоминаем её, после —
 * открываем тем же путём, что и всё остальное (`openProjectFolder`).
 */
let pendingFolder: string | null = null;
let requestOpenFolder: ((folder: string) => Promise<void>) | null = null;

/**
 * Путь из командной строки. `app.getAppPath()` в списке исключений не зря: при
 * запуске `electron .` в разработке первый аргумент — это само приложение, и
 * принять его за проект значило бы открыть репозиторий IDE вместо нужной папки.
 */
function folderFromArgs(args: readonly string[], workingDirectory?: string): CommandLineFolder {
  return folderFromCommandLine({
    args,
    resolve: (value) => path.resolve(workingDirectory ?? process.cwd(), value),
    ignore: [app.getAppPath()],
    isDirectory: (candidate) => statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true,
    caseInsensitive: process.platform === 'win32',
  });
}

/** Попросить открыть папку: до готовности — запоминаем, после — открываем сразу. */
function askToOpenFolder(folder: string | null): void {
  if (!folder) return;
  if (requestOpenFolder) void requestOpenFolder(folder);
  else pendingFolder = folder;
}

/** Объяснить в консоли, какие аргументы выглядели путём, но папкой не оказались. */
function reportUnusable(unusable: readonly string[]): void {
  for (const candidate of unusable) {
    process.stderr.write(`[chui] папка не найдена: ${candidate}\n`);
  }
}

// macOS присылает этот событие при открытии папки из Finder; бывает и до готовности
// приложения, поэтому обработчик ставим сразу и запоминаем путь.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  askToOpenFolder(filePath);
});

// Второй экземпляр приложения не нужен: он бы писал в тот же settings.json.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
    // Второй запуск с путём — это просьба открыть проект в уже работающем окне.
    // Путь ищем от рабочего каталога вызвавшей стороны: у второго запуска свой cwd.
    const asked = folderFromArgs(argv.slice(1), workingDirectory);
    reportUnusable(asked.unusable);
    askToOpenFolder(asked.folder);
  });
  void app.whenReady().then(async () => {
    const settings = new SettingsStore();

    // Схема в приложении одна — тёмная, поэтому `nativeTheme.themeSource` не трогаем:
    // остаётся только тема из файла, и о её смене сообщаем renderer'у.
    const pushTheme = (): void => {
      const { appearance } = settings.get();
      pushToRenderers(PushTopic.ThemeChanged, { customTheme: appearance.customTheme ?? null });
    };

    const applyTheme = (): void => {
      for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(WINDOW_BACKGROUND);
      pushTheme();
    };

    settings.onDidChange(applyTheme);
    applyTheme();

    // Изменение в рабочей папке — это и потенциальная правка в репозитории.
    // Статус git пересчитываем по тому же потоку, что и дерево: тогда пометки
    // в проводнике обновляются для любой правки — агента, терминала, внешнего
    // инструмента, — а не только для операций, прошедших через `workspace.*`.
    // Сам пересчёт назначается ниже, когда появится сервис git.
    let refreshGitSoon: (() => void) | null = null;
    // То же и для карты символов: сохранили файл — его объявления устарели. Сборщик
    // появится ниже, а поток правок уже идёт — поэтому вызов отложенный.
    let refreshIndexSoon: ((changed: string) => void) | null = null;
    const workspace = new WorkspaceService((topic, payload) => {
      pushToRenderers(topic, payload);
      if (topic !== PushTopic.WorkspaceChanged) return;
      refreshGitSoon?.();
      refreshIndexSoon?.((payload as WorkspaceChangedPayload).path);
    });
    const ai = new AiService(settings, workspace);
    // Терминал сам активирует venv проекта: иначе pip, запуск и тесты работают
    // системным питоном, и человеку приходится вспоминать про `source`.
    const terminals = new TerminalService(
      (topic, payload) => pushToRenderers(topic, payload),
      async () => {
        const root = workspace.rootPath();
        if (!root) return null;
        // Активируется то окружение, в котором лежит рабочий интерпретатор: обычно это
        // главное окружение проекта, но выбранное для проекта может быть и вне его
        // (`~/.venvs`) — тогда терминал обязан активировать именно его.
        const run = settings.get().run;
        return activationForInterpreter(root, run.pythonByRoot[root] ?? run.pythonPath, process.platform);
      },
      // `.env` проекта читаем на каждую сессию: файл правят во время работы, и
      // перезапуск IDE ради новой переменной — лишний.
      () => projectEnv(workspace.rootPath()),
    );
    // Git ничего не хранит сам: корень берётся у рабочей папки. Статус обновляем
    // по потоку изменений рабочей папки (см. `refreshGitSoon`) и по своим git-операциям.
    const git = new GitService(
      () => workspace.rootPath(),
      (topic, payload) => pushToRenderers(topic, payload),
      // Чужой коммит (терминал, агент, внешний инструмент) переписывает `.git`, а не
      // файлы дерева: о таком изменении сервис сообщает сюда - и статус пересчитывается.
      () => refreshGitSoon?.(),
    );
    // Отложенный пересчёт статуса: поток сохранений и правок схлопывается в один
    // `git status`. Задержка больше, чем у дерева (120 мс): git заметно дороже.
    {
      let timer: NodeJS.Timeout | null = null;
      refreshGitSoon = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void git.refresh().catch(() => undefined);
          // Сводка по всем корням области: правки в неактивной папке не меняют статус
          // активной, но панель должна их видеть. Считаем только в многообласти.
          if (workspace.rootList().length > 1) {
            void git
              .summary(workspace.rootList())
              .then((list) => pushToRenderers(PushTopic.GitSummary, list))
              .catch(() => undefined);
          }
        }, 300);
      };
    }
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
      // Запасной сервер для языка: если названный в настройках не поднялся
      // (сломан, без пакетов), берём следующий по приоритету источников.
      async (language) => {
        const sources = await detectLspSources(workspace.rootPath(), process.platform);
        return sources.flat().filter((server) => server.language === language);
      },
      // Журнал обмена с серверами (настройка `lsp.trace`) — в пользовательских данных.
      () => path.join(app.getPath('userData'), 'lsp-trace.log'),
      // Файл-затравка языка: без него сервер не знает проекта и не обходит его
      // (см. `LspService.scanProject`) — поиск символов оставался бы пустым.
      createSeedProvider(() => workspace.rootPath()),
    );
    // Карта символов проекта: объявления всех файлов Python и Node без тел, собранные
    // заранее и лежащие в пользовательских данных. Разбор делает тот же языковой сервер
    // (своего парсера у нас нет), а карта лишь хранит ответ и переживает перезапуск:
    // поиск символов перестаёт ждать первого прогрева, а пока сервер не поднялся —
    // отвечает тем, что уже знает (см. `SymbolIndexer`).
    const symbolIndex = new SymbolIndexer({
      root: () => workspace.rootPath(),
      outline: (target, languageId, text) => lsp.outline(target, languageId, text),
      store: new SymbolStore(path.join(app.getPath('userData'), 'symbol-index')),
      // Окружение Python нужно карте, чтобы найти `site-packages`: оно бывает и вне
      // проекта (общее в `~/.venvs`), и от корня путь к нему не выводится.
      python: () => {
        const root = workspace.rootPath();
        const interpreter = pythonInterpreterFor(root, settings.get().run.pythonPath);
        return { venvDir: interpreter ? venvDirOfPython(interpreter) : null };
      },
      // По этим каталогам рабочая папка разрешает чтение: щелчок по символу из пакета
      // открывает исходник библиотеки, даже если пакет лежит вне проекта.
      onDependencyDirs: (dirs) => workspace.setDependencyDirs(dirs),
    });
    // Сервер отвечает точно и по всему проекту, карта — мгновенно и без него:
    // в поиске символов они дополняют друг друга.
    lsp.attachIndex(symbolIndex);
    // Сохранение и чужая правка в рабочей папке приходят одним потоком
    // (`WorkspaceChanged`): без этого карта отставала бы от кода до следующего
    // открытия проекта и находила бы удалённые объявления.
    refreshIndexSoon = (changed) => symbolIndex.noteChanged(changed);
    // Отладчик: сессия debugpy по DAP. Интерпретатор тот же, что у запуска и тестов,
    // а `.env` проекта — тот же, что у терминала и языкового сервера.
    const debug = new DebugService(
      (topic, payload) => pushToRenderers(topic, payload),
      () => workspace.rootPath(),
      () => pythonInterpreterFor(workspace.rootPath(), settings.get().run.pythonPath),
      () => projectEnv(workspace.rootPath()),
    );
    // Внешние инструменты (MCP): серверы задаются в настройках, а рабочая папка
    // нужна им как каталог запуска — многие инструменты читают проект оттуда.
    const mcp = new McpService(
      () => settings.get().ai.mcpServers,
      () => workspace.rootPath(),
    );

    // Браузер агента: свой Chromium под управлением CDP. Процесс поднимается
    // лениво — только когда настройка включена и агент позвал инструмент. Профиль
    // живёт в temp и удаляется при закрытии: браузер не видит сессий человека.
    const browser = new BrowserService(() => {
      const settingsForBrowser = settings.get().ai.browser;
      return { executable: settingsForBrowser.executable, headless: settingsForBrowser.headless };
    });

    // Встроенный браузер: страница — вкладка в редакторе, рисует её `WebContentsView`
    // поверх окна. Окно панель берёт лениво: на старте его ещё нет,
    // а притворяться, что есть, — значит создавать IDE тому, кто просил только список
    // проектов. Через ту же панель агент подключается к странице по CDP.
    const browserPanel = new BrowserPanel({
      window: () => getIdeWindow(),
      notify: (topic, payload) => pushToRenderers(topic, payload),
      openExternal: (url) => void shell.openExternal(url).catch(() => undefined),
    });
    // Что из двух достанется агенту, решает настройка: встроенный браузер (по умолчанию)
    // или отдельный Chromium. Разница между ними — в `agent-browser.ts`.
    ai.attachBrowser(new AgentBrowser(browserPanel, browser, () => settings.get().ai.browser.integrated));

    // Песочница: команды и тесты агента идут в контейнер вместо хоста. Движок
    // ищем один раз при старте — по PATH, как браузер: включённая песочница без
    // движка должна честно отказать, а не тихо вернуться на хост.
    const sandbox = new SandboxService(() => settings.get().ai.sandbox);
    ai.attachSandbox(sandbox);

    // Сессия редактора: вкладки, раскрытые папки, видимость панелей — на каждый проект.
    const sessions = new SessionStore();
    const projectConfig = new ProjectConfigStore();
    const reviews = new ReviewStore();
    const history = new HistoryStore(path.join(app.getPath('userData'), 'history'));
    // Снимок прежнего содержимого перед каждой перезаписью — источник локальной
    // истории. Ошибку снимка не поднимаем: история вспомогательная, файл важнее.
    workspace.onBeforeChange = (file, reason) => {
      const root = workspace.rootPath();
      if (!root) return;
      // Возвращаем обещание, чтобы WorkspaceService дождался снимка: иначе запись
      // могла бы обогнать чтение и в историю попал бы уже новый текст.
      return history.capture(root, file, reason).catch(() => undefined);
    };

    const deps = {
      settings,
      workspace,
      ai,
      terminals,
      git,
      lsp,
      index: symbolIndex,
      debug,
      sessions,
      projectConfig,
      reviews,
      history,
      mcp,
      browserPanel,
      host: new HostClient(),
    };
    registerIpc(deps);
    serveRenderer();
    // Меню пересобираем при каждой смене настроек: клавиши пунктов человек может
    // менять в редакторе сочетаний (`menu:<команда>`), а Electron меняет акселераторы
    // только вместе с меню. Дёшево: набор пунктов невелик.
    const rebuildMenu = (): void => createApplicationMenu(settings.get().keybindings.overrides);
    settings.onDidChange(rebuildMenu);
    rebuildMenu();

    // Проект можно задать снаружи — путём в командной строке или открытием папки
    // из системы. Тогда сразу открываем IDE; иначе начинаем со списка проектов:
    // окно IDE откроется, когда человек выберет папку или склонирует репозиторий.
    requestOpenFolder = async (folder) => {
      try {
        await openProjectFolder(deps, folder);
      } catch (error) {
        // Папку могли удалить или указать неверно: показываем причину в терминале
        // и не оставляем приложение без окна вовсе.
        process.stderr.write(
          `[chui] не удалось открыть ${folder}: ${error instanceof Error ? error.message : error}\n`,
        );
        if (BrowserWindow.getAllWindows().length === 0) openWelcomeWindow();
      }
    };

    const fromArgs = folderFromArgs(process.argv.slice(1));
    reportUnusable(fromArgs.unusable);
    const requested = pendingFolder ?? fromArgs.folder;
    pendingFolder = null;
    if (requested) await requestOpenFolder(requested);
    else openWelcomeWindow();

    app.on('will-quit', () => {
      terminals.dispose();
      lsp.dispose();
      debug.dispose();
      git.dispose();
      // Браузер — наш процесс: без остановки он остался бы висеть после выхода.
      browser.dispose();
      // Вложения встроенного браузера держат процессы: закрываем вместе с окном.
      browserPanel.dispose();
      // Серверы MCP — наши процессы: без остановки они остались бы висеть после выхода.
      mcp.dispose();
      workspace.dispose();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openWelcomeWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
