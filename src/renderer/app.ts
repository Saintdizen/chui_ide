import {
  PushTopic,
  type BreakpointRecord,
  type DebugLaunchOptions,
  type LayoutSettings,
  type SessionState,
  type Settings,
  type SettingsPatch,
  type WorkspaceChangedPayload,
} from '../shared/api';
import { PROJECT_SETTINGS_SECTIONS, mergeDeep, type ProjectSettings } from '../shared/project-config';
import { CommandRegistry, type CommandDescriptor } from './core/commands';
import type { TextDocument } from './core/document';
import { DocumentStore } from './core/document-store';
import { EditService } from './core/edits';
import { HostService } from './core/host';
import { EditorService } from './core/editor-service';
import { GitModel } from './core/git-model';
import { diagnoseHighlighting, setHighlightScheme } from './core/highlight';
import { KeybindingService } from './core/keybindings';
import { languageLabel, languageIndent } from './core/languages';
import { ImportChecker } from './core/import-check';
import { registerImportActions } from './core/import-actions';
import { LspClient } from './core/lsp';
import { registerLspProviders } from './core/lsp-providers';
import { OpenEditors } from './core/open-editors';
import { ProjectToolsModel, type ProjectTools } from './core/project-tools';
import { envWidgetLabel } from './core/env-widget';
import { DebugController, frameForHover } from './core/debug';
import { RpcClient } from './core/rpc';
import {
  collectRunTargets,
  entryLine,
  nodeInstallTarget,
  nodeTestsTarget,
  pytestCoverageTarget,
  pytestTarget,
  type RunTarget,
  type RunnableFile,
} from './core/run-config';
import { isNodeTestFile, isPythonTestFile, type ProjectScan } from '../shared/project-scan';
import { findRunnableTests } from '../shared/python-tests';
import { detectNodeTestRunner, findRunnableNodeTests, type NodeTestRunner } from '../shared/node-tests';
import { formatEngine, formatToolNames, type FormatEngine } from '../shared/format';
import { joinPath, separatorOf, splitPath } from '../shared/paths';
import { ThemeService } from './core/theme-service';
import { WindowFrame } from './core/window-frame';
import { WorkspaceModel } from './core/workspace-model';
import { showApplicationMenu } from './ui/app-menu';
import { createBreadcrumbs } from './ui/breadcrumbs';
import { createChatPanel } from './ui/chat';
import { createDock } from './ui/dock';
import { createDiffView } from './ui/diff-view';
import { basename, clear, h, svgIcon, type IconName } from './ui/dom';
import { createEmptyState } from './ui/empty-state';
import { createExplorer } from './ui/explorer';
import { createLaunchOptionsModal } from './ui/launch-options-modal';
import { createLayout } from './ui/layout';
import { logoMark } from './ui/logo';
import { createNodeEnvPopover, type NodeEnvPopoverView } from './ui/node-env-popover';
import { createPalette } from './ui/palette';
import { createPopover, type PopoverView } from './ui/popover';
import { createPythonEnvPopover, type PythonEnvPopoverView } from './ui/python-env-popover';
import { createQuickOpen } from './ui/quick-open';
import { createSymbolPicker } from './ui/symbol-picker';
import { closePopupMenu, isPopupOpen, showPopupMenu } from './ui/popup-menu';
import { createPromptModal } from './ui/prompt-modal';
import { createRunButton } from './ui/run-button';
import { createSearchView } from './ui/search';
import { createSourceControl } from './ui/source-control';
import { createStatusBar } from './ui/statusbar';
import { createSettingsModal } from './ui/settings-modal';
import { createTabs } from './ui/tabs';
import { createTerminalPanel } from './ui/terminal';
import { createDebugPanel } from './ui/debug-panel';
import { createTestPanel } from './ui/test-panel';
import { showToast } from './ui/toast';
import { createVenvModal } from './ui/venv-modal';

/**
 * Точка сборки приложения: сервисы, команды, подписки.
 * Всё остальное — модули, которые друг о друге почти ничего не знают.
 */
export async function startApplication(mount: HTMLElement): Promise<void> {
  const rpc = new RpcClient();
  const commands = new CommandRegistry();
  const documents = new DocumentStore();
  const openEditors = new OpenEditors(documents);
  const workspace = new WorkspaceModel(rpc);
  // Состояние репозитория — отдельная модель: она подписана на push-события main,
  // поэтому UI не переспрашивает статус после каждой своей операции.
  const git = new GitModel(rpc, workspace);

  const layout = createLayout(mount, { onChange: () => void persistLayout() });
  const statusBar = createStatusBar({
    openGitManager: (anchor) => openGitManager(anchor),
    openPythonEnv: (anchor) => openPythonEnv(anchor),
    openNodeEnv: (anchor) => openNodeEnv(anchor),
    // Через команду, а не напрямую: палитра создаётся ниже, а команда уже есть.
    openFilePicker: () => void commands.execute('file.quickOpen'),
  });
  layout.statusBarHost.appendChild(statusBar.element);

  // ОбщеIDE-настройки хранятся в userData; настройки проекта (.chui_ide) ложатся поверх.
  let baseSettings = await rpc.request('settings.get');
  let projectSettings: ProjectSettings = {};
  let settings = baseSettings;
  const layoutGuard = { applying: false };
  const rebuildSettings = (): Settings => {
    const merged = mergeDeep(baseSettings, projectSettings);
    settings = (merged ?? baseSettings) as Settings;
    return settings;
  };

  // Правка настроек: IDE-секции уходят в userData, проектные (editor/explorer/run/lsp) — в .chui_ide.
  async function saveSettingsPatch(value: SettingsPatch): Promise<Settings> {
    const root = workspace.root;
    const projectPatch: Record<string, unknown> = {};
    const globalPatch: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if ((PROJECT_SETTINGS_SECTIONS as readonly string[]).includes(key)) projectPatch[key] = entry;
      else globalPatch[key] = entry;
    }
    if (root && Object.keys(projectPatch).length > 0) {
      projectSettings = await rpc.request('project.updateSettings', {
        root,
        patch: projectPatch as ProjectSettings,
      });
    }
    if (Object.keys(globalPatch).length > 0) {
      baseSettings = await rpc.request('settings.update', globalPatch as SettingsPatch);
    }
    const next = rebuildSettings();
    applySettings(next);
    return next;
  }

  // Макет рабочей области общий для всех проектов, поэтому живёт в userData
  // (settings.json), а не в `.chui_ide` конкретного проекта.
  async function persistLayout(): Promise<void> {
    if (layoutGuard.applying) return;
    baseSettings = await rpc
      .request('settings.update', {
        layout: {
          sidebarSize: layout.sidebarSize,
          rightSize: layout.rightSize,
          dockSize: layout.dockSize,
          sidebarVisible: layout.sidebarVisible,
          rightVisible: layout.rightVisible,
          dockVisible: layout.dockVisible,
        },
      })
      .catch(() => baseSettings);
  }

  /** Программное изменение макета не должно сохранять само себя. */
  function withoutPersist(run: () => void): void {
    layoutGuard.applying = true;
    try {
      run();
    } finally {
      layoutGuard.applying = false;
    }
  }

  /** Применить макет из настроек: размеры и видимость панелей. */
  function applyLayoutSettings(saved: LayoutSettings | undefined): void {
    if (!saved) return;
    withoutPersist(() => {
      layout.setSidebarSize(saved.sidebarSize);
      layout.setRightSize(saved.rightSize);
      layout.setDockSize(saved.dockSize);
      layout.setSidebarVisible(saved.sidebarVisible);
      layout.setRightVisible(saved.rightVisible);
      layout.setDockVisible(saved.dockVisible);
    });
  }

  // При открытии проекта накладываем настройки из его `.chui_ide` поверх общих.
  async function loadProjectConfig(root: string): Promise<void> {
    const config = await rpc.request('project.config', { root }).catch(() => null);
    projectSettings = config ?? {};
    applySettings(rebuildSettings());
  }

  function resetProjectConfig(): void {
    projectSettings = {};
    applySettings(rebuildSettings());
  }

  // Макет восстановлен из userData ещё до открытия проекта: панели сразу на месте.
  applyLayoutSettings(baseSettings.layout);
  const info = await rpc.request('app.info');
  console.info(`[chui] Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node} · ${info.platform}`);

  // Тема: main — источник истины, сервис знает и выбор пользователя, и фактическую схему.
  const theme = new ThemeService(rpc, settings.appearance.theme);

  const editors = new EditorService(layout.editorHost, documents, settings.editor, theme.monacoThemeId);
  const edits = new EditService({ documents, editors, rpc });
  // Отладчик: состояние сессии держит контроллер, события идут из main push-ом.
  const debug = new DebugController(rpc);
  // Подсказка под курсором в остановленном файле: значение выражения в кадре. Шов
  // в редактор — потому что контроллер отладки живёт здесь, а не в Monaco.
  editors.setDebugHover(async (expression, at) => {
    const state = debug.get();
    if (state.phase !== 'stopped') return null;
    // Строка под курсором может принадлежать не верхнему кадру, а тому, кто его
    // вызвал: считаем выражение в том кадре, чьи файл и строка совпали.
    const frame = frameForHover(state.frames, at);
    const result = await debug.hover(expression, frame?.id);
    return result ? { value: result.value, type: result.type } : null;
  });
  // Приёмник обратных вызовов из main: правки агента приходят сюда.
  const host = new HostService();
  // Языковые серверы: держим документы синхронными и кладём их пометки в Monaco.
  new LspClient(rpc, documents, editors).attach();
  // Подсказки от языковых серверов: импорты, наведения и переход к определению.
  registerLspProviders(rpc);
  // Импорты с неустановленными библиотеками: своя проверка, не зависящая от LSP.
  const importChecker = new ImportChecker(rpc, documents, editors);
  importChecker.attach();

  // Настройки — модальное окно поверх всего: и шапка, и панель AI открывают одно и то же.
  const settingsModal = createSettingsModal({
    rpc,
    commands,
    theme,
    project: {
      kind: () => projectScan?.kind.id ?? null,
      patch: (value) => saveSettingsPatch(value),
    },
  });
  document.body.appendChild(settingsModal.element);

  // Окно Python-окружений: создание venv рядом с настройками, поверх всего.
  const venvModal = createVenvModal({
    rpc,
    root: () => workspace.root,
    // Окружение появилось — запуск, подсказки и статусбар должны увидеть его сразу.
    onCreated: () => reloadPythonEnvironment(),
  });
  document.body.appendChild(venvModal.element);

  /* ── панели ────────────────────────────────────────────────────────────── */

  const explorer = createExplorer({ workspace, rpc, commands, openEditors, git, documents });
  layout.sidebarBody.appendChild(explorer.element);

  const sourceControl = createSourceControl({ git, workspace, commands });

  /**
   * Менеджер git в поповере: тот же самописный менеджер, что и панель изменений,
   * только всплывает у кнопки ветки в статусбаре. Создаём при первом клике —
   * чтобы не держать вторую подписку на модель, пока попап ни разу не открывали.
   */
  let gitManagerPopover: PopoverView | null = null;

  function openGitManager(anchor: HTMLElement): void {
    if (!gitManagerPopover) {
      const manager = createSourceControl({ git, workspace, commands });
      gitManagerPopover = createPopover(manager.element, { width: 360 });
      gitManagerPopover.element.classList.add('popover-git');
    }
    // Свежее состояние: репозиторий мог измениться вне приложения.
    void git.refresh();
    gitManagerPopover.toggle(anchor);
  }

  /**
   * Попап Python-окружения у кнопки в статусбаре: что выбрано и откуда.
   * Список окружений обновляем при открытии — попап мог провисеть долго.
   */
  let pythonEnvPopover: PopoverView | null = null;
  let pythonEnvView: PythonEnvPopoverView | null = null;

  function openPythonEnv(anchor: HTMLElement): void {
    if (!pythonEnvPopover || !pythonEnvView) {
      pythonEnvView = createPythonEnvPopover({
        rpc,
        root: () => workspace.root,
        tools: () => tools.get(),
        configured: () => settings.run.pythonPath,
        platform: () => info.platform,
        projectKind: () => projectScan?.kind.label ?? null,
        projectPython: () => (workspace.root ? (settings.run.pythonByRoot[workspace.root] ?? '') : ''),
        onSelect: (command) => {
          // Интерпретатор выбирается для ЭТОГО проекта: два Python-проекта не
          // должны подменять друг другу окружение. Пусто — вернуться к общему.
          void setProjectInterpreter(command);
          pythonEnvPopover?.close();
          // Сервер подсказок поднят со старым интерпретатором — перезапускаем.
          reopenLsp();
        },
        onCreate: () => {
          pythonEnvPopover?.close();
          void venvModal.open();
        },
        onInstallRequirements: () => {
          pythonEnvPopover?.close();
          void installRequirements();
        },
      });
      pythonEnvPopover = createPopover(pythonEnvView.element, { width: 340 });
      pythonEnvPopover.element.classList.add('popover-python-env');
    }
    void pythonEnvView.refresh();
    pythonEnvPopover.toggle(anchor);
  }

  /**
   * Попап Node-окружения по клику на чип «Node.js»: чем запускается код, чем
   * ставятся зависимости и всё ли из `package.json` на месте.
   */
  let nodeEnvPopover: PopoverView | null = null;
  let nodeEnvView: NodeEnvPopoverView | null = null;

  function openNodeEnv(anchor: HTMLElement): void {
    if (!nodeEnvPopover || !nodeEnvView) {
      nodeEnvView = createNodeEnvPopover({
        rpc,
        root: () => workspace.root,
        tools: () => tools.get(),
        projectKind: () => projectScan?.kind.label ?? null,
        onInstall: () => {
          nodeEnvPopover?.close();
          // Ставим все объявленные зависимости: `npm install` без аргументов.
          void installNodePackages([]);
        },
      });
      nodeEnvPopover = createPopover(nodeEnvView.element, { width: 340 });
      nodeEnvPopover.element.classList.add('popover-node-env');
    }
    void nodeEnvView.refresh();
    nodeEnvPopover.toggle(anchor);
  }

  const diffView = createDiffView({ createDiff: (container) => editors.createDiff(container), git });
  layout.editorHost.appendChild(diffView.element);

  const searchView = createSearchView({
    rpc,
    commands,
    workspace,
    documents,
    // Замена пишет файлы на диске: открытые вкладки перечитываем сразу.
    reloadFile: (path) => reloadIfOpen(path),
  });
  const terminalPanel = createTerminalPanel({ rpc, cwd: () => workspace.root, scheme: theme.resolved });

  /** Карта проекта: из неё берём тесты и точку входа. Пусто, пока проект не открыт. */
  let projectScan: ProjectScan | null = null;

  /** Вид проекта: от него зависит, чем собирать и запускать тесты (pytest или Node). */
  const isPythonProject = (): boolean => projectScan?.kind.id === 'python';

  /** Язык, который исполняется Node: у него свои тесты и свои инструменты. */
  const isNodeLanguage = (languageId: string): boolean => languageId === 'javascript' || languageId === 'typescript';

  /** Раннер тестов Node: объявленный в проекте, иначе встроенный `node --test`. */
  const nodeRunner = (): NodeTestRunner | null =>
    detectNodeTestRunner(tools.get().testRunner, projectScan?.testFiles ?? []);

  /**
   * Цель прогона тестов панели: селектор узла, а `null` — все тесты проекта. Раннер
   * выбираем по карте проекта: у Python это pytest, у Node — раннер проекта.
   */
  const testTargetFor = (selector: string | null, options: { report?: boolean } = {}): RunTarget => {
    const node = nodeRunner();
    if (node) return nodeTestsTarget(tools.get(), node, selector, { ...options, platform: info.platform });
    return pytestTarget(tools.get(), selector, { ...options, platform: info.platform });
  };

  // Панель тестов: список собирается при показе — правки в коде меняют его.
  // Про раннер панель не знает: сбор и запуск выбираются здесь по виду проекта.
  const testPanel = createTestPanel({
    rpc,
    collect: async () => {
      if (!workspace.root) return null;
      // Python-проект собирает pytest, Node — свой раннер (vitest, jest или `node --test`).
      if (isPythonProject()) {
        const suite = await rpc.request('python.tests');
        return { runner: 'pytest', ...suite };
      }
      return rpc.request('node.tests');
    },
    // Панель просит отчёт — команда уносит в терминал и печать кода выхода,
    // по ней панель и красит узлы.
    onRun: (selector, options) => void runTarget(testTargetFor(selector, options)),
    // Покрытие пока умеет только pytest: у Node своего отчёта нет, и кнопка
    // «С покрытием» в его проектах не показывается вовсе.
    onCoverage: (selector) =>
      void runTarget(pytestCoverageTarget(tools.get(), selector, { report: true, platform: info.platform })),
    canCoverage: () => isPythonProject(),
    // Отчёт покрытия → подсветка непокрытых строк в редакторе. Отчёт даёт пути от
    // корня проекта; редактор ключует файлы абсолютными — собираем их здесь.
    onCoverageReport: (report) => {
      const root = workspace.root;
      if (!root) return;
      const separator = separatorOf(root);
      const entries = report.files
        .filter((file) => file.missingLines.length > 0)
        .map((file) => [joinPath(root, splitPath(file.path).join(separator)), file.missingLines] as const);
      editors.setCoverage(entries);
    },
    // Пересобирать список по правке стоит только когда панель тестов на виду.
    isVisible: () => dock.visible && dock.activeId === 'tests',
  });

  const dock = createDock();
  dock.register({ id: 'search', title: 'Поиск', element: searchView.element, onShow: () => searchView.focus() });
  dock.register({ id: 'tests', title: 'Тесты', element: testPanel.element, onShow: () => void testPanel.refresh() });
  dock.register({
    id: 'terminal',
    title: 'Терминал',
    element: terminalPanel.element,
    onShow: () => void terminalPanel.open(),
  });
  dock.register({
    id: 'git',
    title: 'Изменения',
    element: sourceControl.element,
    onShow: () => sourceControl.focus(),
  });
  layout.dockHost.appendChild(dock.element);

  /* ── чат ───────────────────────────────────────────────────────────────── */

  /**
   * Чат можно перенести в область редактора — тогда он становится обычной
   * вкладкой рядом с файлами, а не отдельным экраном. Панель чата при этом одна:
   * элемент переезжает между хозяевами, второй копии не существует.
   */
  const chatEditor = h('div', { class: 'chat-editor', hidden: true });
  layout.editorHost.appendChild(chatEditor);

  let chatInEditor = false;
  /** Вкладка чата показана сейчас: файлы ждут своей очереди. */
  let chatTabActive = false;

  /** Чат виден человеку: панелью справа либо вкладкой в редакторе. */
  function chatVisible(): boolean {
    return chatInEditor ? chatTabActive : layout.rightVisible;
  }

  /** Ассистент выключен мастер-тумблером в настройках: все входы в него должны молчать. */
  const aiEnabled = (): boolean => settings.ai.enabled;

  /** Куда зовём, если AI выключен: подсказка вместо тихого «ничего не произошло». */
  const warnAiDisabled = (): void => {
    showToast('AI выключен в настройках. Включить: Настройки → AI.', 'error');
  };

  /** Показать вкладку чата (или перенести чат, если он ещё в панели). */
  function showChatTab(): void {
    if (!chatInEditor) {
      setChatInEditor(true);
      return;
    }
    chatTabActive = true;
    syncChatTab();
  }

  /** Активировали файл — вкладка чата остаётся в полосе, но не показывается. */
  function hideChatTab(): void {
    if (!chatInEditor || !chatTabActive) return;
    chatTabActive = false;
    syncChatTab();
  }

  function syncChatTab(): void {
    const shown = chatInEditor && chatTabActive;
    chatEditor.hidden = !shown;
    layout.editorIsland.classList.toggle('is-chat', shown);
    tabs.refresh();
    // Вкладка чата — это тоже «показан ли чат»: кнопка AI должна это отражать.
    syncViewButtons();
  }

  function setChatInEditor(next: boolean): void {
    if (next === chatInEditor) {
      if (next) showChatTab();
      return;
    }
    chatInEditor = next;
    chatTabActive = next;

    if (next) {
      // Панель отдаёт чат редактору: два хозяина у одной области экрана лишние.
      layout.rightBody.replaceChildren();
      chatEditor.appendChild(chat.element);
      layout.setRightVisible(false);
    } else {
      chatEditor.hidden = true;
      layout.rightBody.appendChild(chat.element);
      layout.setRightVisible(true);
    }

    syncChatTab();
  }

  /** Показать чат там, где он сейчас живёт: панелью справа или вкладкой в редакторе. */
  function revealChat(): void {
    if (!aiEnabled()) {
      warnAiDisabled();
      return;
    }
    if (chatInEditor) showChatTab();
    else layout.setRightVisible(true);
    syncViewButtons();
  }

  /**
   * Кнопка AI: свернуть/развернуть чат — где бы он ни жил. Когда чат перенесён
   * в редактор, правая панель пуста, поэтому переключать нужно вкладку, а не её.
   */
  function toggleChat(): void {
    if (!aiEnabled()) {
      warnAiDisabled();
      return;
    }
    if (chatInEditor) {
      if (chatTabActive) hideChatTab();
      else showChatTab();
      return;
    }
    layout.setRightVisible(!layout.rightVisible);
    syncViewButtons();
  }

  const chat = createChatPanel({
    rpc,
    documents,
    editors,
    edits,
    commands,
    workspace,
    settings,
    settingsModal,
    host,
    toggleEditor: () => setChatInEditor(!chatInEditor),
    isInEditor: () => chatInEditor,
  });
  layout.rightBody.appendChild(chat.element);

  const tabs = createTabs({
    openEditors,
    documents,
    commands,
    auxiliary: {
      title: 'Чат',
      get visible() {
        return chatInEditor;
      },
      get active() {
        return chatTabActive;
      },
      activate: showChatTab,
      close: () => setChatInEditor(false),
    },
  });
  layout.tabsHost.appendChild(tabs.element);

  const breadcrumbs = createBreadcrumbs({ openEditors, documents, workspace, commands });
  layout.breadcrumbsHost.appendChild(breadcrumbs);

  // Кнопка запуска живёт в той же полосе, что и крошки: это действие над файлом,
  // а не настройка, и место у него — рядом с редактором, а не в шапке окна.
  const runControl = createRunButton((target) => void runTarget(target));
  layout.breadcrumbsHost.appendChild(runControl.element);

  /* ── запуск ────────────────────────────────────────────────────────────── */

  /** Чем запускать код и какие задачи есть в проекте: спрашиваем один раз на корень. */
  const tools = new ProjectToolsModel(rpc, () => settings.run, info.platform);
  /** Подпись последнего нарисованного значка запуска: не трогаем украшения зря. */
  let runMarkerSignature = '';

  /** Перечитать карту проекта: дёшево — обход имён без чтения содержимого. */
  async function refreshScan(): Promise<void> {
    // Карта от прошлого проекта не должна мелькать на новом: чистим сразу.
    projectScan = null;
    refreshStatus();
    projectScan = await rpc.request('project.scan').catch(() => null);
    syncRunControl();
    refreshStatus();
  }

  /**
   * Языковые серверы: если LSP включён, а список серверов пуст — подставляем
   * найденные. Без этого типичные грабли: «включил LSP, а подсказок нет» — просто
   * потому, что ни один сервер не выбран. Ничего не запускаем: только проверяем,
   * что команда есть (PATH и главное окружение проекта).
   */
  async function ensureLspServers(): Promise<void> {
    if (!settings.lsp.enabled || settings.lsp.servers.length > 0) return;
    const found = await rpc.request('lsp.detect').catch(() => []);
    if (found.length === 0) return;
    await rpc.request('settings.update', { lsp: { servers: found } }).catch(() => undefined);
    showToast(`Языковые серверы подключены: ${found.map((server) => server.language).join(', ')}`);
  }

  /**
   * Перезапустить серверы подсказок и заново открыть в них документы.
   *
   * Сервер поднимается с интерпретатором проекта один раз — при первом открытии
   * файла этого языка. Сменившееся или появившееся окружение он сам не заметит, а
   * после перезапуска документы в нём уже не значатся: без повторного `lsp.open`
   * подсказки пропали бы до переоткрытия файла.
   */
  function reopenLsp(): void {
    if (!settings.lsp.enabled) return;
    void rpc
      .request('lsp.restart')
      .then(() => {
        for (const document of documents.all()) {
          void rpc.request('lsp.open', {
            path: document.path,
            languageId: document.languageId,
            text: document.value,
          });
        }
      })
      .catch(() => undefined);
  }

  /** Окружение изменилось: перечитать инструменты, карту проекта, подсказки и импорты. */
  function reloadPythonEnvironment(): void {
    void tools.refresh(workspace.root, true).then(() => {
      syncRunControl();
      refreshStatus();
    });
    void refreshScan();
    reopenLsp();
    // Импорты, которых не хватало, могли появиться вместе с окружением.
    importChecker.refresh();
  }

  /** Файл как программа: путь от корня нужен для команды в терминале. */
  const runnableFileOf = (document: TextDocument | null): RunnableFile | null => {
    const root = workspace.root;
    if (!document || !root) return null;
    const relative = workspace.relative(document.path);
    // Файл вне корня запускать нечем: команда выполняется в каталоге проекта.
    if (relative === document.path) return null;
    return { path: document.path, relative, languageId: document.languageId, text: document.value };
  };

  function targetsFor(document: TextDocument | null): RunTarget[] {
    return collectRunTargets(runnableFileOf(document), tools.get(), projectScan, nodeRunner());
  }

  /**
   * Кнопка запуска и значок ▶ в жёлобе говорят одно и то же: что можно запустить
   * в этом файле. Значок ставим только у настоящей точки входа — иначе жёлоб
   * пестреет стрелками у каждого файла.
   */
  function syncRunControl(): void {
    const active = openEditors.active;
    // Без открытого файла кнопки запуска нет: она говорит о том, что запустится
    // в файле, а в пустом редакторе остаётся только заглушка с подсказками.
    // Запуск без файла никуда не девается — он есть в палитре (Shift+F10).
    runControl.update(active ? targetsFor(active) : []);

    // Полоса под вкладками нужна ровно тогда, когда в ней есть что показать:
    // путь из одного сегмента крошек не рисует, и без кнопки запуска
    // оставалась бы пустая полоска с линией на всю ширину.
    layout.breadcrumbsHost.hidden = breadcrumbs.hidden && runControl.element.hidden;

    if (!active) return;
    const line = entryLine(active.languageId, active.value);
    const signature = `${active.path}:${line ?? 0}`;
    if (signature !== runMarkerSignature) {
      runMarkerSignature = signature;
      editors.setRunLines(active.path, line ? [line] : []);
    }
    syncTestMarkers(active);
  }

  /** Подпись для значков тестов: версия документа в ней — правка может добавить тест. */
  let testMarkerSignature = '';

  /**
   * Значки запуска отдельных тестов: по объявлениям `def test_…` в файле. Ставим
   * их только тестовым файлам — иначе жёлоб пестрел бы стрелками у каждого
   * `def test_` в чужом модуле.
   */
  function syncTestMarkers(document: TextDocument): void {
    const relative = workspace.relative(document.path);
    const inProject = relative !== document.path;
    const python = inProject && document.languageId === 'python' && isPythonTestFile(relative);
    // JS/TS разбираем своим разбором: `test('…')` и `describe` вместо `def test_…`.
    const node = inProject && isNodeLanguage(document.languageId) && isNodeTestFile(relative);
    if (!python && !node) {
      editors.setTestMarkers(document.path, []);
      return;
    }

    const signature = `${document.path}:${document.version}`;
    if (signature === testMarkerSignature) return;
    testMarkerSignature = signature;
    editors.setTestMarkers(
      document.path,
      python ? findRunnableTests(relative, document.value) : findRunnableNodeTests(relative, document.value),
    );
  }

  /** Запуск цели: файл сохраняем, панель показываем, команду набираем в терминале. */
  async function runTarget(target: RunTarget): Promise<void> {
    if (settings.run.saveBeforeRun) {
      for (const document of documents.dirty()) await saveDocument(document);
    }
    dock.show('terminal');
    await terminalPanel.run(target.command, target.label);
  }

  const emptyState = createEmptyState();
  layout.editorHost.appendChild(emptyState.element);

  const palette = createPalette({ commands });
  document.body.appendChild(palette.element);

  // F1 внутри редактора — наша палитра: две палитры в одном окне только путают.
  editors.openPaletteOnF1(() => void commands.execute('palette.open'));

  /* ── кнопки шапки ──────────────────────────────────────────────────────── */

  /** Переключатели панелей: их подсветку держит `syncViewButtons`. */
  const viewButtons = new Map<string, HTMLButtonElement>();

  /**
   * Кнопка шапки. Обычно это значок из общего набора, но кнопка ассистента носит
   * знак приложения — он шире и рисуется отдельно, поэтому его можно передать
   * готовым узлом.
   */
  const addTopButton = (
    host: HTMLElement,
    id: string,
    icon: IconName,
    title: string,
    command: string,
    glyph?: SVGSVGElement,
  ): void => {
    const button = h(
      'button',
      { class: 'icon-btn', type: 'button', title, onClick: () => void commands.execute(command) },
      glyph ?? svgIcon(icon, 16),
    );
    viewButtons.set(id, button);
    host.appendChild(button);
  };

  /** Панель закрывают и кнопкой, и командой, и сплиттером — подсветка идёт за состоянием. */
  const syncViewButtons = (): void => {
    viewButtons.get('project')?.classList.toggle('is-active', layout.sidebarVisible);
    viewButtons.get('search')?.classList.toggle('is-active', layout.dockVisible && dock.activeId === 'search');
    viewButtons.get('terminal')?.classList.toggle('is-active', layout.dockVisible && dock.activeId === 'terminal');
    // Выключенный AI прячем из шапки: неактивная кнопка всё равно звала бы в чат.
    const aiButton = viewButtons.get('ai');
    if (aiButton) {
      aiButton.hidden = !aiEnabled();
      aiButton.classList.toggle('is-active', aiEnabled() && chatVisible());
    }
  };

  // Системной полосы меню у безрамочного окна нет — открываем её кнопкой.
  // Меню рисует renderer, поэтому оно выглядит как остальные выпадашки; системное
  // меню остаётся внутри main ради горячих клавиш (см. `shared/app-menu.ts`).
  const menuButton = h(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      title: 'Меню приложения',
      onClick: () => void commands.execute('app.showMenu'),
    },
    svgIcon('menu', 16),
  );
  layout.topBarLeft.appendChild(menuButton);
  // Отдельного виджета проекта в шапке нет: имя проекта показывает заголовок
  // панели проекта, а открыть другую папку можно из меню (Ctrl+O).
  // Переключатель боковой панели стоит рядом с меню: он про то же — что открыто слева.
  // Раньше для него была отдельная полоса иконок у края окна.
  addTopButton(layout.topBarLeft, 'project', 'panel', 'Боковая панель (Ctrl+B)', 'view.toggleSidebar');

  // Действия шапки. Слева — то, что показывает содержимое: файлы, поиск,
  // терминал. Справа — служебное: ассистент, палитра, настройки, тема.
  addTopButton(layout.topBarLeft, 'save', 'save', 'Сохранить всё (Ctrl+Shift+S)', 'file.saveAll');
  addTopButton(layout.topBarLeft, 'search', 'search', 'Найти в проекте (Ctrl+Shift+F)', 'search.project');
  addTopButton(layout.topBarLeft, 'terminal', 'terminal', 'Терминал (Alt+F12)', 'view.showTerminal');

  // Ассистент носит знак приложения, а не звезду-искру: тот же знак, что
  // в пустом состоянии редактора, — кнопка и экран говорят одно и то же.
  addTopButton(layout.topBarRight, 'ai', 'sparkle', 'AI Assistant (Ctrl+Shift+A)', 'view.toggleRight', logoMark(13));
  addTopButton(layout.topBarRight, 'palette', 'command', 'Палитра команд (Ctrl+Shift+P)', 'palette.open');
  addTopButton(layout.topBarRight, 'settings', 'settings', 'Настройки', 'settings.open');

  const themeButton = h('button', {
    class: 'icon-btn',
    type: 'button',
    onClick: () => void commands.execute('view.toggleTheme'),
  });
  layout.topBarRight.appendChild(themeButton);

  // Своя рамка создаётся последней: кнопки окна должны стоять с краю шапки,
  // а не перед кнопками действий.
  const windowFrame = new WindowFrame(rpc, layout.topBarRight, layout.topBar);

  const syncThemeButton = (): void => {
    const scheme = theme.resolved;
    const name = scheme === 'dark' ? 'тёмная' : 'светлая';
    themeButton.title =
      theme.selected === 'system'
        ? `Тема: системная (сейчас ${name}) — нажмите, чтобы переключить`
        : `Тема: ${name} — нажмите, чтобы переключить`;
    clear(themeButton);
    themeButton.appendChild(svgIcon(scheme === 'dark' ? 'moon' : 'sun', 16));
  };

  /* ── вспомогательные действия ──────────────────────────────────────────── */

  const openPath = async (path: string): Promise<void> => {
    const document = await edits.ensureDocument(path);
    openEditors.open(document);
    editors.open(document);
    explorer.reveal(path);
    // Открыли файл — на экране он, вкладка чата ждёт в полосе.
    hideChatTab();
  };

  // Быстрый открыватель файлов (Ctrl+Shift+O): отдельный вход, тот же `openPath`,
  // что у дерева и вкладок, поэтому открытие ведёт себя одинаково.
  const quickOpen = createQuickOpen({ rpc, workspace, openFile: (path) => openPath(path) });
  document.body.appendChild(quickOpen.element);

  // Диалог ввода: условие точки останова. Один на приложение — открывается по месту.
  const conditionInput = createPromptModal();
  document.body.appendChild(conditionInput.element);

  /** Ввод одной строки как Promise: `null`, если окно закрыли без подтверждения. */
  const promptValue = (input: { title: string; label: string; value: string }): Promise<string | null> =>
    new Promise((resolve) => {
      conditionInput.open({
        title: input.title,
        label: input.label,
        value: input.value,
        confirmLabel: 'Задать',
        onAccept: (value) => resolve(value),
        onCancel: () => resolve(null),
      });
    });

  // Диалог параметров запуска отладки: аргументы, окружение и рабочий каталог.
  const launchOptions = createLaunchOptionsModal();
  document.body.appendChild(launchOptions.element);

  // Поиск символа по проекту (Ctrl+T): файл открываем тем же путём, что и дерево,
  // а затем встаём на строку объявления.
  const symbolPicker = createSymbolPicker({
    rpc,
    openSymbol: (symbol) => {
      void openPath(symbol.path).then(() => editors.reveal(symbol.path, symbol.line, symbol.column));
    },
  });
  document.body.appendChild(symbolPicker.element);

  // Панель отладки в нижнем доке: управление сессией, стек и переменные.
  const debugPanel = createDebugPanel({
    debug,
    onRevealFrame: (frame) => {
      if (!frame.path) return;
      void openPath(frame.path).then(() => editors.revealDebugFrame(frame.path!, frame.line, frame.column));
    },
    // Наблюдение изменилось — рабочее место стоит сохранить (см. сессию ниже).
    onWatchChange: () => scheduleSessionSave(),
    // Останов по исключению изменили — тоже часть рабочего места.
    onExceptionChange: () => scheduleSessionSave(),
    // Правка значения переменной: панель просит строку, ввод показывает app.
    promptValue,
  });
  dock.register({ id: 'debug', title: 'Отладка', element: debugPanel.element, onShow: () => debugPanel.refresh() });

  /* ── сессия рабочей папки ──────────────────────────────────────────────── */

  /** Какой проект сейчас восстановлен: ключ, по которому кладётся сессия. */
  let sessionRoot: string | null = null;
  /** Пока идёт восстановление, сохранять нельзя — иначе затрём файл пустотой. */
  let restoringSession = false;
  let sessionSaveTimer = 0;

  /** Точки останова в виде записей сессии: файл + строка + настройки. */
  const captureBreakpoints = (): BreakpointRecord[] => {
    const records: BreakpointRecord[] = [];
    for (const [path, list] of debug.allBreakpoints()) {
      for (const item of list) {
        records.push({
          path,
          line: item.line,
          ...(item.condition ? { condition: item.condition } : {}),
          ...(item.hitCondition ? { hitCondition: item.hitCondition } : {}),
          ...(item.logMessage ? { logMessage: item.logMessage } : {}),
        });
      }
    }
    return records;
  };

  /** Восстановить точки останова проекта: в контроллер и значками в редактор. */
  const restoreBreakpoints = (records: readonly BreakpointRecord[]): void => {
    const byPath = new Map<
      string,
      Array<{ line: number; condition?: string; hitCondition?: string; logMessage?: string }>
    >();
    for (const record of records) {
      const list = byPath.get(record.path) ?? [];
      list.push({
        line: record.line,
        ...(record.condition ? { condition: record.condition } : {}),
        ...(record.hitCondition ? { hitCondition: record.hitCondition } : {}),
        ...(record.logMessage ? { logMessage: record.logMessage } : {}),
      });
      byPath.set(record.path, list);
    }
    debug.restoreBreakpoints([...byPath.entries()]);
    // Значки рисует редактор: карту держит он, а состояние — контроллер. Файлы
    // значки получат сразу, даже не открытые: модель появится — отрисуется по карте.
    for (const [path, list] of debug.allBreakpoints()) editors.setBreakpoints(path, list);
  };

  /** Текущее рабочее место: что открыто, что раскрыто, какие панели видны. */
  const captureSession = (): SessionState => {
    const breakpoints = captureBreakpoints();
    const watch = debugPanel.getWatch();
    const exceptions = debug.exceptionFilters();
    return {
      tabs: [...openEditors.paths],
      ...(openEditors.active ? { activeTab: openEditors.active.path } : {}),
      expanded: explorer.expandedPaths(),
      ...(dock.activeId ? { dockActive: dock.activeId } : {}),
      // Видимость панелей сюда не входит: это общий макет (settings), а не
      // свойство проекта. Рабочее место конкретной папки — вкладки и папки.
      // Параметры запуска, наблюдение и точки останова отладки — часть рабочего места:
      // пустые не пишем, чтобы файл не разрастался полями-пустышками.
      ...(Object.keys(debugOptions).length > 0 ? { debugLaunch: debugOptions } : {}),
      ...(watch.length > 0 ? { debugWatch: watch } : {}),
      ...(exceptions.uncaught || exceptions.caught ? { debugExceptions: exceptions } : {}),
      ...(breakpoints.length > 0 ? { breakpoints } : {}),
    };
  };

  const scheduleSessionSave = (): void => {
    if (!sessionRoot || restoringSession) return;
    if (sessionSaveTimer) window.clearTimeout(sessionSaveTimer);
    sessionSaveTimer = window.setTimeout(() => {
      sessionSaveTimer = 0;
      if (!sessionRoot || restoringSession) return;
      void rpc.request('session.save', { root: sessionRoot, state: captureSession() }).catch(() => undefined); // не сохранилось — не повод мешать работе
    }, 400);
  };

  /**
   * Восстановление рабочего места при открытии проекта: вкладки, раскрытые
   * папки, видимость панелей. Файлы могли исчезнуть — открытие каждого в `try`,
   * чтобы один пропавший не сорвал восстановление остальных.
   */
  const restoreSession = async (root: string): Promise<void> => {
    if (sessionRoot === root) return;
    sessionRoot = root;
    restoringSession = true;
    try {
      openEditors.closeAll();
      const state = await rpc.request('session.load', { root });

      for (const path of state.tabs) {
        try {
          await openPath(path);
        } catch {
          // файла больше нет — просто пропускаем
        }
      }
      if (state.activeTab && openEditors.has(state.activeTab)) {
        openEditors.activate(state.activeTab);
        const document = documents.get(state.activeTab);
        if (document) editors.open(document);
      }

      explorer.restoreExpanded(state.expanded);
      // Параметры запуска, наблюдение и точки останова — из прошлой сессии проекта.
      debugOptions = state.debugLaunch ?? {};
      debugPanel.setWatch(state.debugWatch ?? []);
      if (state.debugExceptions) void debug.setExceptionFilters(state.debugExceptions);
      restoreBreakpoints(state.breakpoints ?? []);
      // Видимость панелей — из общего макета (settings), а не из сессии проекта.
      // Из сессии берём только то, какая вкладка нижней панели была открыта.
      withoutPersist(() => {
        // Панель ассистента не показываем, если AI выключен: её место свободно.
        layout.setRightVisible(layout.rightVisible && aiEnabled());
        // Нижняя панель: видимость — из макета, а какая вкладка открыта — из сессии.
        const dockTab = state.dockActive ?? dock.activeId;
        if (layout.dockVisible && dockTab) dock.show(dockTab);
        else if (!layout.dockVisible) dock.hide();
      });
    } catch {
      // повреждённый файл сессии не должен мешать — начинаем с чистого места
    } finally {
      restoringSession = false;
    }
    syncViewButtons();
    scheduleSessionSave();
  };

  openEditors.onDidChange(scheduleSessionSave);
  dock.onVisibilityChange(scheduleSessionSave);
  // Точки останова — тоже часть рабочего места: поставили или сняли — сохраняем.
  debug.onDidChangeBreakpoints(scheduleSessionSave);
  const saveDocument = async (document: TextDocument): Promise<void> => {
    // Форматирование при сохранении: правку проводит документ, поэтому на экране
    // и на диске оказывается одно и то же.
    if (settings.editor.formatOnSave) await formatDocument(document);
    await rpc.request('workspace.writeFile', { path: document.path, text: document.value });
    document.markSaved();
    showToast(`Сохранено: ${basename(document.path)}`);
  };

  /**
   * Закрытие окна с несохранёнными файлами. Сессию пишем всегда — это последний
   * шанс сохранить рабочее место. А правки терять нельзя, поэтому закрытие
   * отменяем и спрашиваем системным диалогом; окно при этом остаётся живым:
   * Electron по умолчанию не игнорирует отмену из `beforeunload`.
   */
  let closing = false;
  const confirmClose = async (): Promise<void> => {
    closing = true;
    try {
      const files = documents.dirty();
      if (files.length === 0) return;
      const { choice } = await rpc.request('dialog.confirmClose', { files: files.map((file) => file.path) });
      if (choice === 'cancel') return;
      if (choice === 'save') for (const file of files) await saveDocument(file);
      // «Сохранить» и «Выйти без сохранения» ведут сюда: этот `window.close`
      // проходит без повторного вопроса — флаг `closing` уже поднят.
      await rpc.request('window.close');
    } catch (error) {
      // Сохранение не прошло — окно оставляем, иначе правки пропадут молча.
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      closing = false;
    }
  };

  window.addEventListener('beforeunload', (event) => {
    if (sessionRoot && !restoringSession) {
      void rpc.request('session.save', { root: sessionRoot, state: captureSession() }).catch(() => undefined);
    }
    if (closing || documents.dirty().length === 0) return;
    event.preventDefault();
    // Без `returnValue` Chromium не считает выгрузку отменённой — окно закрылось бы.
    event.returnValue = false;
    void confirmClose();
  });

  /* ── Инструменты проекта: формат и установка ───────────────────────────── */

  /** Что вышло из попытки форматирования. */
  type FormatOutcome = 'changed' | 'unchanged' | 'unavailable';

  /**
   * Отформатировать документ инструментом проекта. Правку проводим через документ:
   * так она попадает в undo и в сохранение.
   *
   * `unavailable` — это не «менять нечего»: инструмента в проекте может просто не
   * быть, и сказать об этом надо честно, а не молчанием.
   */
  const formatDocument = async (document: TextDocument): Promise<FormatOutcome> => {
    const engine = formatEngine(document.languageId);
    if (!engine) return 'unavailable';
    const result =
      engine === 'python'
        ? await rpc.request('python.format', { path: document.path, text: document.value }).catch(() => null)
        : await rpc.request('node.format', { path: document.path, text: document.value }).catch(() => null);
    if (!result?.tool) return 'unavailable';
    if (result.text === document.value) return 'unchanged';
    document.setText(result.text, 'programmatic');
    return 'changed';
  };

  /** Человеческий итог форматирования — одним сообщением. */
  const formatOutcomeMessage = (engine: FormatEngine, outcome: FormatOutcome): string => {
    if (outcome === 'changed') return 'Файл отформатирован';
    if (outcome === 'unchanged') return 'Менять нечего';
    return `Нечем форматировать: ${formatToolNames(engine).join(' и ')} в проекте нет`;
  };

  /**
   * Поставить пакеты в окружение проекта и перепроверить импорты.
   * Один путь для трёх входов: команда, кнопка в попапе и быстрая правка.
   */
  const installPythonPackages = async (packages: string[], requirements = false): Promise<void> => {
    if (!workspace.root) {
      showToast('Проект не открыт', 'error');
      return;
    }
    showToast(packages.length > 0 ? `Ставлю: ${packages.join(', ')}…` : 'Устанавливаю зависимости…');
    try {
      const result = await rpc.stream('python.install', { packages, requirements }, () => undefined);
      showToast(result.installed.length > 0 ? `Готово: ${result.installed.join(', ')}` : 'Нечего ставить');
      // Пакеты появились — подчёркнутые импорты должны это увидеть.
      importChecker.refresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const installRequirements = (): Promise<void> => installPythonPackages([], true);

  /**
   * Поставить пакеты Node. Идёт в терминал, как и задачи проекта: вывод
   * `npm install` длинный, его читают и прерывают руками, а не в тосте.
   */
  const installNodePackages = async (packages: string[]): Promise<void> => {
    if (!tools.get().root) {
      showToast('Проект не открыт', 'error');
      return;
    }
    await runTarget(nodeInstallTarget(tools.get(), packages));
    // Пакеты появились — подчёркнутые импорты должны это увидеть.
    importChecker.refresh();
  };

  // Быстрая правка у подчёркнутого импорта: «Установить пакет» — прямо из редактора.
  registerImportActions({
    checker: importChecker,
    installPython: (packages) => installPythonPackages(packages),
    installNode: (packages) => installNodePackages(packages),
  });

  /** Запомнить интерпретатор для этого проекта (пусто — вернуться к общему). */
  const setProjectInterpreter = async (command: string): Promise<void> => {
    const root = workspace.root;
    if (!root) return;
    const pythonByRoot = { ...settings.run.pythonByRoot };
    if (command) pythonByRoot[root] = command;
    else delete pythonByRoot[root];
    await rpc.request('settings.update', { run: { pythonByRoot } });
  };

  /* ── реестр команд ─────────────────────────────────────────────────────── */

  /** Все команды проходят через один обработчик ошибок — UI не падает молча. */
  const define = (descriptor: CommandDescriptor, handler: (...args: unknown[]) => unknown): void => {
    commands.register(descriptor, async (...args) => {
      try {
        return await handler(...args);
      } catch (error) {
        console.error(`[chui] команда ${descriptor.id} упала:`, error);
        showToast(error instanceof Error ? error.message : String(error), 'error');
        return undefined;
      }
    });
  };

  define({ id: 'workspace.openFolder', title: 'Открыть папку', category: 'Файл', keybinding: 'Ctrl+O' }, async () => {
    const path = await workspace.pick();
    if (!path) return;
    void commands.execute('view.showExplorer');
    showToast(`Открыт проект ${basename(path)}`);
  });

  define({ id: 'workspace.refresh', title: 'Обновить дерево', category: 'Файл' }, async () => {
    await workspace.refresh();
    explorer.render();
  });

  define({ id: 'workspace.revealPath', title: 'Показать в проводнике', category: 'Навигация' }, (path) => {
    if (typeof path === 'string') explorer.reveal(path);
  });

  define({ id: 'file.open', title: 'Открыть файл', category: 'Файл' }, async (path) => {
    if (typeof path === 'string') await openPath(path);
  });

  define({ id: 'file.activate', title: 'Активировать вкладку', category: 'Файл' }, (path) => {
    if (typeof path !== 'string') return;
    openEditors.activate(path);
    const document = documents.get(path);
    if (document) editors.open(document);
    // Файл мог быть активным и до этого: клик по его вкладке всё равно должен
    // показать файл, а не оставить на экране чат.
    hideChatTab();
  });

  define({ id: 'file.close', title: 'Закрыть вкладку', category: 'Файл', keybinding: 'Ctrl+W' }, (path) => {
    const target = typeof path === 'string' ? path : (openEditors.active?.path ?? null);
    if (!target) return;
    openEditors.close(target);
    const next = openEditors.active;
    if (next) editors.open(next);
  });

  define({ id: 'file.save', title: 'Сохранить', category: 'Файл', keybinding: 'Ctrl+S' }, async () => {
    const document = openEditors.active;
    if (!document) {
      showToast('Нет открытого файла');
      return;
    }
    await saveDocument(document);
  });

  define({ id: 'file.saveAll', title: 'Сохранить всё', category: 'Файл', keybinding: 'Ctrl+Shift+S' }, async () => {
    const dirty = documents.dirty();
    if (dirty.length === 0) {
      showToast('Все файлы уже сохранены');
      return;
    }
    for (const document of dirty) await saveDocument(document);
  });

  define({ id: 'file.createFile', title: 'Создать файл', category: 'Файл' }, async (path) => {
    if (typeof path !== 'string') return undefined;
    const created = await rpc.request('workspace.createFile', { path });
    await openPath(created.path);
    explorer.scheduleRefresh();
    showToast(`Создан файл ${basename(created.path)}`);
    return created.path;
  });

  define({ id: 'file.createFolder', title: 'Создать папку', category: 'Файл' }, async (path) => {
    if (typeof path !== 'string') return undefined;
    const created = await rpc.request('workspace.createDir', { path });
    explorer.scheduleRefresh();
    showToast(`Создана папка ${basename(created.path)}`);
    return created.path;
  });

  // Из меню и палитры создание начинается с инлайн-ввода имени в дереве.
  define({ id: 'file.newFile', title: 'Новый файл…', category: 'Файл', keybinding: 'Ctrl+N' }, () => {
    explorer.startCreate('file');
  });

  define({ id: 'file.newFolder', title: 'Новая папка…', category: 'Файл' }, () => {
    explorer.startCreate('directory');
  });

  define({ id: 'file.rename', title: 'Переименовать', category: 'Файл' }, async (from, to) => {
    if (typeof from !== 'string' || typeof to !== 'string') return undefined;
    const wasActive = openEditors.active?.path === from;
    if (openEditors.has(from)) openEditors.close(from);

    const renamed = await rpc.request('workspace.rename', { from, to });
    if (wasActive) await openPath(renamed.path);
    explorer.scheduleRefresh();
    showToast(`Переименовано: ${basename(renamed.path)}`);
    return renamed.path;
  });

  define({ id: 'file.delete', title: 'Удалить в корзину', category: 'Файл' }, async (path) => {
    if (typeof path !== 'string') return;

    // Удаление необратимо, поэтому спрашиваем — но только если так настроено:
    // в проводнике это рутинное действие, и лишний вопрос раздражает.
    if (settings.explorer.confirmDelete) {
      const { confirmed } = await rpc.request('dialog.confirm', {
        title: 'Удалить в корзину',
        message: `Переместить ${basename(path)} в корзину?`,
        detail: `${workspace.relative(path)} — файл можно вернуть из корзины системы.`,
        confirmLabel: 'Удалить',
      });
      if (!confirmed) return;
    }

    if (openEditors.has(path)) openEditors.close(path);
    await rpc.request('workspace.trash', { path });
    explorer.scheduleRefresh();
    showToast(`В корзине: ${basename(path)}`);
  });

  define({ id: 'file.revealAt', title: 'Перейти к позиции', category: 'Навигация' }, async (path, line, column) => {
    if (typeof path !== 'string') return;
    await openPath(path);
    editors.reveal(path, typeof line === 'number' ? line : 1, typeof column === 'number' ? column : 1);
  });

  /* ── запуск ────────────────────────────────────────────────────────────── */

  define({ id: 'run.file', title: 'Запустить файл', category: 'Запуск', keybinding: 'Ctrl+F5' }, async () => {
    // Именно файл, а не первая цель из набора: у Python первыми могли оказаться
    // тесты, и Ctrl+F5 запускал бы их вместо самого файла.
    const target = targetsFor(openEditors.active).find((item) => item.source === 'file');
    if (!target) {
      showToast('Запускать нечего: нужен скрипт или задача в package.json', 'error');
      return;
    }
    await runTarget(target);
  });

  define({ id: 'run.tests', title: 'Запустить тесты', category: 'Запуск' }, async () => {
    const active = openEditors.active;
    const relative = active ? workspace.relative(active.path) : null;
    const targets = collectRunTargets(runnableFileOf(active), tools.get(), projectScan, nodeRunner());
    const runnable = relative && relative !== active?.path ? relative : null;
    // Цели тестов у языков называются по-разному: у Python — `pytest:…`, у Node —
    // `node-tests:…`. Сначала пробуем файл, в котором стоит человек, потом — все тесты.
    const target =
      targets.find(
        (item) => item.source === 'test' && (item.id === `pytest:${runnable}` || item.id === `node-tests:${runnable}`),
      ) ?? targets.find((item) => item.id === 'pytest:all' || item.id === 'node-tests:all');
    if (!target) {
      showToast('Тесты не найдены: нужен pytest, vitest, jest или файлы для `node --test`', 'error');
      return;
    }
    await runTarget(target);
  });

  /* ── отладка ───────────────────────────────────────────────────────────── */

  /** Запомненные параметры запуска: помнятся в сессии проекта, подставляются в F5. */
  let debugOptions: DebugLaunchOptions = {};

  /**
   * Активный файл, если его язык умеет отладчик: Python (debugpy) или JavaScript (Node).
   *
   * TypeScript отладчику не отдаём: Node его не выполняет напрямую, а раннер
   * проекта (`tsx`, `ts-node`) может быть не установлен — обещать отладку, которая
   * не состоится, хуже отказа. Запуск при этом есть: кнопка запуска зовёт `.ts`
   * встроенными средствами Node (см. `nodeTypeStripCommand`) или раннером проекта.
   * Точки в `.ts` работают, когда отлаживается собранный `.js`: их переводит
   * source-карта, — об этом и говорит подсказка.
   */
  const activeDebuggableFile = (): TextDocument | null => {
    const active = openEditors.active;
    if (active?.languageId === 'typescript') {
      showToast('TypeScript отлаживается через собранный .js: точки в .ts встанут по source-карте', 'error');
      return null;
    }
    if (!active || (active.languageId !== 'python' && active.languageId !== 'javascript')) {
      showToast('Отладчик работает с файлами Python и JavaScript', 'error');
      return null;
    }
    return active;
  };

  /** Начать отладку активного файла: адаптер подберётся по языку (debugpy или Node). */
  const startDebug = async (options: DebugLaunchOptions = debugOptions): Promise<void> => {
    const active = activeDebuggableFile();
    if (!active) return;
    if (settings.run.saveBeforeRun) {
      for (const document of documents.dirty()) await saveDocument(document);
    }
    const result = await debug.start(active.path, options);
    if (!result.ok) showToast(result.message, 'error');
    else dock.show('debug');
  };

  define({ id: 'debug.start', title: 'Отладка: запустить файл', category: 'Отладка' }, () => startDebug());

  // Параметры запуска одним окном: аргументы, переменные окружения и рабочий каталог.
  // Заданные один раз, они держатся в памяти и подставляются в обычный F5.
  define({ id: 'debug.startWithOptions', title: 'Отладка: параметры запуска…', category: 'Отладка' }, () => {
    if (!activeDebuggableFile()) return;
    launchOptions.open({
      options: debugOptions,
      onAccept: (options) => {
        debugOptions = options;
        scheduleSessionSave();
        void startDebug(options);
      },
      onReset: () => {
        debugOptions = {};
        scheduleSessionSave();
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

  // F5 как в VS Code: не идёт отладка — начать, стоит на паузе — продолжить.
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

  define({ id: 'run.choose', title: 'Запустить…', category: 'Запуск', keybinding: 'Shift+F10' }, () => {
    const targets = targetsFor(openEditors.active);
    if (targets.length === 0) {
      showToast('Запускать нечего: нужен скрипт или задача в package.json', 'error');
      return;
    }
    if (targets.length === 1) {
      void runTarget(targets[0]!);
      return;
    }
    const anchor = runControl.element;
    const rect = anchor.getBoundingClientRect();
    showPopupMenu(
      targets.map((target) => ({ label: target.label, hint: target.detail, onSelect: () => void runTarget(target) })),
      rect.right - 260,
      rect.bottom + 4,
      { anchor },
    );
  });

  define({ id: 'view.showExplorer', title: 'Показать проводник', category: 'Вид', keybinding: 'Alt+1' }, () => {
    layout.setSidebarVisible(true);
    syncViewButtons();
  });

  /* ── git ───────────────────────────────────────────────────────────────── */

  /** Путь приходит аргументом команды: так её можно вызвать из палитры и от ассистента. */
  const asPath = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

  define({ id: 'git.refresh', title: 'Обновить состояние репозитория', category: 'Git' }, async () => {
    await git.refresh();
  });

  define({ id: 'git.init', title: 'Создать репозиторий git', category: 'Git' }, async () => {
    await git.init();
    showToast('Репозиторий git создан');
  });

  define({ id: 'git.stage', title: 'Проиндексировать файл', category: 'Git' }, async (path) => {
    const target = asPath(path);
    if (target) await git.stage([target]);
  });

  define({ id: 'git.unstage', title: 'Убрать файл из индекса', category: 'Git' }, async (path) => {
    const target = asPath(path);
    if (target) await git.unstage([target]);
  });

  define({ id: 'git.discard', title: 'Откатить правки файла', category: 'Git' }, async (path, label) => {
    const target = asPath(path);
    if (!target) return;

    // Откат необратим, поэтому спрашиваем системным диалогом, а не просто делаем.
    const { confirmed } = await rpc.request('dialog.confirm', {
      title: 'Откатить правки',
      message: `Отменить правки в ${basename(target)}?`,
      detail: `${workspace.relative(target)}${typeof label === 'string' ? ` (${label})` : ''} — файл вернётся к состоянию последнего коммита. Вернуть правки будет нельзя.`,
      confirmLabel: 'Откатить',
    });
    if (!confirmed) return;

    await git.discard([target]);
    showToast(`Откатано: ${basename(target)}`);
  });

  define({ id: 'git.commit', title: 'Закоммитить изменения', category: 'Git' }, async (messageArg) => {
    const text = typeof messageArg === 'string' ? messageArg : '';
    if (!text.trim()) {
      showToast('Сначала напишите сообщение коммита', 'error');
      return undefined;
    }

    // Как в других IDE: пустой индекс — не повод отказывать, а повод спросить.
    if (git.staged.length === 0) {
      if (git.unstaged.length === 0) {
        showToast('Изменений для коммита нет', 'error');
        return undefined;
      }
      const { confirmed } = await rpc.request('dialog.confirm', {
        title: 'Коммит',
        message: 'В индексе нет файлов. Проиндексировать все изменения и закоммитить?',
        detail: `Файлов с правками: ${git.unstaged.length}`,
        confirmLabel: 'Проиндексировать и закоммитить',
      });
      if (!confirmed) return undefined;
      await git.stage(git.unstaged.map((file) => file.path));
    }

    const info = await git.commit(text);
    showToast(`Коммит ${info.hash}: ${info.summary}`);
    return info;
  });

  define({ id: 'git.showDiff', title: 'Показать различия файла', category: 'Git' }, async (path, staged) => {
    const target = asPath(path);
    if (target) await diffView.open(target, staged === true);
  });

  define({ id: 'git.checkout', title: 'Переключить ветку', category: 'Git' }, async (name) => {
    if (typeof name !== 'string' || !name) return;
    await git.checkout(name);
    showToast(`Ветка: ${name}`);
  });

  define({ id: 'git.createBranch', title: 'Создать ветку', category: 'Git' }, async (name) => {
    const branch = typeof name === 'string' ? name.trim() : '';
    if (!branch) return;
    await git.checkout(branch, true);
    showToast(`Ветка создана: ${branch}`);
  });

  define({ id: 'git.stageAll', title: 'Проиндексировать все изменения', category: 'Git' }, async () => {
    const paths = git.unstaged.map((file) => file.path);
    if (paths.length === 0) {
      showToast('Нет изменений для индексации', 'error');
      return;
    }
    await git.stage(paths);
  });

  define({ id: 'git.unstageAll', title: 'Убрать всё из индекса', category: 'Git' }, async () => {
    const paths = git.staged.map((file) => file.path);
    if (paths.length === 0) {
      showToast('Индекс уже пуст', 'error');
      return;
    }
    await git.unstage(paths);
  });

  define({ id: 'git.discardAll', title: 'Откатить все правки', category: 'Git' }, async () => {
    const paths = git.unstaged.map((file) => file.path);
    if (paths.length === 0) {
      showToast('Нет правок для отката', 'error');
      return;
    }

    // Откат необратим: спрашиваем системным диалогом, как и для одного файла.
    const { confirmed } = await rpc.request('dialog.confirm', {
      title: 'Откатить все правки',
      message: 'Отменить все правки в рабочем дереве?',
      detail: `Файлов: ${paths.length}. Изменённые вернутся к последнему коммиту, новые будут удалены. Вернуть правки будет нельзя.`,
      confirmLabel: 'Откатить все',
    });
    if (!confirmed) return;

    await git.discard(paths);
    showToast('Правки откатаны');
  });

  define({ id: 'view.showChanges', title: 'Показать изменения', category: 'Вид', keybinding: 'Ctrl+Shift+G' }, () => {
    dock.show('git');
  });

  define({ id: 'view.toggleSidebar', title: 'Боковая панель', category: 'Вид', keybinding: 'Ctrl+B' }, () => {
    layout.setSidebarVisible(!layout.sidebarVisible);
    syncViewButtons();
  });

  define({ id: 'view.showSearch', title: 'Поиск по проекту', category: 'Поиск', keybinding: 'Ctrl+Shift+F' }, () => {
    dock.show('search');
  });

  define({ id: 'search.project', title: 'Найти в проекте', category: 'Поиск' }, () => dock.show('search'));

  define({ id: 'view.showTerminal', title: 'Терминал', category: 'Вид', keybinding: 'Alt+F12' }, () => {
    dock.toggle('terminal');
  });

  define({ id: 'view.toggleDock', title: 'Свернуть нижнюю панель', category: 'Вид' }, () => {
    if (dock.visible) dock.hide();
    else dock.show(dock.activeId ?? 'terminal');
  });

  define({ id: 'view.toggleRight', title: 'Панель AI', category: 'Вид', keybinding: 'Ctrl+Shift+A' }, () => {
    toggleChat();
  });

  define({ id: 'app.showMenu', title: 'Меню приложения', category: 'Вид', keybinding: 'Alt+F10' }, () => {
    // Повторное нажатие закрывает: так ведёт себя системное меню, и так ждёт человек.
    if (isPopupOpen()) {
      closePopupMenu();
      return;
    }
    menuButton.classList.add('is-menu-open');
    showApplicationMenu(
      menuButton,
      {
        execute: (command) => void commands.execute(command),
        runRole: (role) => void rpc.request('menu.role', { role }),
      },
      () => menuButton.classList.remove('is-menu-open'),
    );
  });

  define({ id: 'palette.open', title: 'Палитра команд', category: 'Вид', keybinding: 'Ctrl+Shift+P' }, () => {
    palette.open();
  });

  // Необязательный аргумент — начальный отбор: крошки и статусбар передают путь
  // папки, чтобы палитра сразу показала файлы рядом, а не весь проект.
  define(
    { id: 'file.quickOpen', title: 'Быстрое открытие файла', category: 'Навигация', keybinding: 'Ctrl+Shift+O' },
    (query) => {
      void quickOpen.open(typeof query === 'string' ? query : '');
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
    () => symbolPicker.open(),
  );

  define({ id: 'settings.open', title: 'Настройки', category: 'Настройки', keybinding: 'Ctrl+,' }, () =>
    settingsModal.open(),
  );

  define(
    {
      id: 'python.environments',
      title: 'Python: виртуальные окружения',
      category: 'Python',
      // «venv» — как это называют на деле: без слова поиск в палитре не находит.
      keywords: ['venv', 'virtualenv', 'окружение', 'интерпретатор'],
    },
    () => void venvModal.open(),
  );

  define(
    {
      id: 'tests.open',
      title: 'Тесты: панель',
      category: 'Запуск',
      keywords: ['pytest', 'тесты', 'test'],
    },
    () => dock.show('tests'),
  );

  define(
    {
      id: 'format.document',
      title: 'Форматировать файл',
      category: 'Файл',
      keywords: ['ruff', 'black', 'prettier', 'biome', 'формат'],
    },
    async () => {
      const document = openEditors.active;
      if (!document) {
        showToast('Нет открытого файла');
        return;
      }
      const engine = formatEngine(document.languageId);
      if (!engine) {
        showToast(`Не форматирую ${languageLabel(document.languageId)}: для него инструмента нет`);
        return;
      }
      showToast(formatOutcomeMessage(engine, await formatDocument(document)));
    },
  );

  define(
    {
      id: 'python.installRequirements',
      title: 'Python: установить зависимости',
      category: 'Python',
      keywords: ['pip', 'install', 'requirements', 'пакеты'],
    },
    () => installRequirements(),
  );

  define({ id: 'settings.revealFile', title: 'Открыть settings.json', category: 'Настройки' }, async () => {
    const result = await rpc.request('settings.revealFile');
    showToast(`Настройки: ${result.path}`);
  });

  define({ id: 'lsp.restart', title: 'Языковые серверы: перезапустить', category: 'Языки' }, async () => {
    const result = await rpc.request('lsp.restart');
    showToast(result.running.length > 0 ? `Серверы: ${result.running.join(', ')}` : 'Языковые серверы остановлены');
  });

  // Диагностика нужна, когда приходит «в чате не подсвечивается код»:
  // отчёт в консоли показывает, какие языки дают токены и с каким цветом.
  define({ id: 'ai.highlightProbe', title: 'AI: диагностика подсветки кода', category: 'AI' }, async () => {
    const report = await diagnoseHighlighting();
    console.info(`[chui] подсветка кода\n${report}`);
    showToast('Отчёт о подсветке — в консоли (Ctrl+Shift+I)');
  });

  define({ id: 'ai.newChat', title: 'Новый диалог', category: 'AI' }, () => {
    revealChat();
    chat.newChat();
  });

  define({ id: 'ai.stop', title: 'Остановить генерацию', category: 'AI' }, () => chat.stop());

  define(
    { id: 'ai.openInEditor', title: 'Перенести чат в окно редактора', category: 'AI', keybinding: 'Ctrl+Alt+E' },
    () => showChatTab(),
  );

  define({ id: 'ai.backToPanel', title: 'Вернуть чат в боковую панель', category: 'AI' }, () => setChatInEditor(false));

  define({ id: 'ai.explainSelection', title: 'Объяснить выделение', category: 'AI' }, async () => {
    revealChat();
    await chat.askAboutSelection('explain');
  });

  define({ id: 'ai.fixSelection', title: 'Исправить выделение', category: 'AI' }, async () => {
    revealChat();
    await chat.askAboutSelection('fix');
  });

  define({ id: 'view.toggleTheme', title: 'Переключить тему', category: 'Вид' }, async () => {
    await theme.toggle();
    showToast(`Тема: ${theme.resolved === 'dark' ? 'тёмная' : 'светлая'}`);
  });

  define({ id: 'view.theme.dark', title: 'Тема: тёмная', category: 'Вид' }, () => theme.set('dark'));
  define({ id: 'view.theme.light', title: 'Тема: светлая', category: 'Вид' }, () => theme.set('light'));
  define({ id: 'view.theme.system', title: 'Тема: как в системе', category: 'Вид' }, () => theme.set('system'));

  /* ── реакция на события ────────────────────────────────────────────────── */

  const refreshStatus = (): void => {
    const active = openEditors.active;
    const projectTools = tools.get();
    // Отступ и язык — свойства файла: у Python четыре пробела, у Makefile таб,
    // поэтому в статусбаре видно ФАКТИЧЕСКОЕ значение, а не общее из настроек.
    const language = active?.languageId ?? null;
    const indent = settings.editor.languageIndent && language ? languageIndent(language) : null;
    statusBar.update({
      file: active ? workspace.relative(active.path) : null,
      dirty: active?.dirty ?? false,
      language: language ? languageLabel(language) : null,
      version: active?.version ?? 0,
      ai: rpc.isStreaming ? 'генерация…' : 'готов',
      tabSize: indent?.tabSize ?? settings.editor.tabSize,
      useTabs: indent ? !indent.insertSpaces : !settings.editor.insertSpaces,
      tool: active ? toolLabel(language, projectTools) : null,
      branch: git.branch,
      changes: git.changeCount,
      projectKindId: projectScan && projectScan.kind.source !== 'none' ? projectScan.kind.id : null,
      // Виджет окружения говорит на языке проекта: у Node — версия и менеджер,
      // у Python — интерпретатор. Раньше в Node-проекте тут висел Python.
      env: envWidgetLabel(projectScan?.kind.id ?? null, projectTools, settings.run.pythonPath),
    });

    // Заголовок окна: как в VS Code — открытый файл и проект.
    const project = workspace.current?.name;
    layout.topBarTitle.textContent = active
      ? project
        ? `${basename(active.path)} — ${project}`
        : basename(active.path)
      : 'chui_iDE';
    // Название приложения показываем моношрифтом (JetBrains Mono), а путь файла —
    // интерфейсным: это не название, а данные.
    layout.topBarTitle.classList.toggle('is-brand', !active);
    layout.topBarTitle.title = active?.path ?? 'chui_iDE';
  };

  const syncEmptyState = (): void => emptyState.update(openEditors.paths.length > 0);

  const applySettings = (next: Settings): void => {
    settings = next;
    editors.applyOptions(next.editor);
    explorer.applySettings(next.explorer);
    chat.applySettings(next);
    settingsModal.applySettings(next);
    // Макет мог измениться (например, размеры панелей) — применяем без повторной записи.
    applyLayoutSettings(next.layout);
    // Ассистент выключили мастер-тумблером — закрываем его панель и обновляем шапку,
    // чтобы она не занимала место и не звала в выключенный чат.
    if (!next.ai.enabled) {
      if (chatInEditor) setChatInEditor(false);
      withoutPersist(() => {
        if (layout.rightVisible) layout.setRightVisible(false);
      });
    }
    syncViewButtons();
    // Инструменты проекта зависят от настроек запуска: путь к интерпретатору
    // и менеджеру пакетов могли поменять — перепроверяем проект заново.
    void tools.refresh(workspace.root, true).then(() => {
      syncRunControl();
      refreshStatus();
    });
    // Сменили интерпретатор — перепроверяем импорты в открытых файлах.
    importChecker.refresh();
    // Схема могла прийти извне — догоняем Monaco и xterm.
    theme.apply();
    refreshStatus();
  };

  dock.onVisibilityChange((visible) => {
    layout.setDockVisible(visible);
    if (visible) terminalPanel.fit();
    syncViewButtons();
  });

  /**
   * Файл изменился на диске. Открытый и не «грязный» документ перечитываем:
   * иначе в редакторе останется старая версия — например, после правки во
   * внешнем инструменте или в терминале. Несохранённые правки не трогаем.
   */
  const reloadIfOpen = async (path: string): Promise<void> => {
    const document = documents.get(path);
    if (!document || document.dirty) return;
    await edits.reloadFromDisk(path).catch(() => undefined);
  };

  rpc.onPush((message) => {
    switch (message.topic) {
      case PushTopic.MenuCommand: {
        const payload = message.payload as { command?: string };
        if (payload?.command) void commands.execute(payload.command);
        break;
      }
      case PushTopic.WorkspaceChanged: {
        explorer.scheduleRefresh();
        // Открытый файл мог измениться снаружи — обновляем и его содержимое.
        const payload = message.payload as WorkspaceChangedPayload;
        if (payload?.path) void reloadIfOpen(payload.path);
        break;
      }
      case PushTopic.SettingsChanged:
        baseSettings = message.payload as Settings;
        applySettings(rebuildSettings());
        break;
      default:
        break;
    }
  });

  openEditors.onDidChange(() => {
    refreshStatus();
    syncEmptyState();
    syncRunControl();
    // Файл стал активным — показываем его, а вкладка чата просто ждёт в полосе.
    if (openEditors.active) hideChatTab();
    // Точки останова контроллер помнит по файлам, а редактор о них не знает:
    // при открытии вкладки отдаём ему набор — значки (с условиями) появятся сразу.
    for (const path of openEditors.paths) editors.setBreakpoints(path, debug.breakpointsOf(path));
  });
  // Счётчик правок и ветка в статусбаре живут по тому же снимку, что и дерево.
  git.onDidChange(refreshStatus);
  documents.onDidChange(({ document }) => {
    refreshStatus();
    // Правка текста может добавить или убрать точку входа — значок запуска
    // обязан следовать за файлом, а не жить до перезапуска.
    syncRunControl();
    // Тестовый файл изменился — панель тестов сама решит, пересобирать ли дерево.
    testPanel.notifyChange(document.path);
  });
  // Значок ▶ в жёлобе: запускаем тот файл, в котором на него нажали.
  editors.onRunMarker(({ path }) => {
    const target = targetsFor(documents.get(path) ?? null).find((item) => item.id === `file:${path}`);
    if (target) void runTarget(target);
  });

  // Значок у объявления теста: запускаем ровно этот — селектор уже собран разбором.
  // Чем запускать, решает язык файла: у Python это pytest, у JS/TS — раннер проекта.
  editors.onTestMarker(({ path, selector, name }) => {
    const node = isNodeLanguage(documents.get(path)?.languageId ?? '') ? nodeRunner() : null;
    void runTarget(
      node
        ? nodeTestsTarget(tools.get(), node, selector, { platform: info.platform })
        : pytestTarget(tools.get(), selector),
    );
    showToast(`Запускаю тест ${name}`);
  });

  // Клик по полю номеров строк — точка останова: контроллер держит набор, а
  // редактор рисует по нему значки. Один источник истины — контроллер.
  editors.onBreakpointToggle(({ path, line }) => {
    void debug.toggleBreakpoint(path, line).then((breakpoints) => editors.setBreakpoints(path, breakpoints));
  });

  /** Меню точки останова по правому клику на поле номеров строк. */
  const openBreakpointMenu = ({ path, line }: { path: string; line: number }): void => {
    const breakpoint = debug.breakpointsOf(path).find((item) => item.line === line);
    const at = breakpoint ?? { line };

    /** Задать настройку точки и перерисовать значки. */
    const apply = (options: { condition?: string; hitCondition?: string; logMessage?: string }): void => {
      void debug.setBreakpointOptions(path, line, options).then((list) => editors.setBreakpoints(path, list));
    };

    showPopupMenu(
      [
        {
          label: at.condition ? 'Изменить условие…' : 'Условие останова…',
          onSelect: () => {
            conditionInput.open({
              title: 'Условие останова',
              label: `Строка ${line}`,
              value: at.condition ?? '',
              placeholder: 'например n > 100',
              confirmLabel: 'Задать',
              onAccept: (value) => apply({ ...at, condition: value }),
            });
          },
        },
        {
          label: at.hitCondition ? 'Изменить счётчик попаданий…' : 'Счётчик попаданий…',
          onSelect: () => {
            conditionInput.open({
              title: 'Счётчик попаданий',
              label: 'Сколько раз пройти мимо, прежде чем остановиться',
              value: at.hitCondition ?? '',
              placeholder: 'например 5 или >3',
              confirmLabel: 'Задать',
              onAccept: (value) => apply({ ...at, hitCondition: value }),
            });
          },
        },
        {
          label: at.logMessage ? 'Изменить сообщение журнала…' : 'Точка в журнал…',
          onSelect: () => {
            conditionInput.open({
              title: 'Точка в журнал',
              label: 'Сообщение; {выражение} подставит значение',
              value: at.logMessage ?? '',
              placeholder: 'например n = {n}',
              confirmLabel: 'Задать',
              onAccept: (value) => apply({ ...at, logMessage: value }),
            });
          },
        },
        {
          label: breakpoint ? 'Убрать точку останова' : 'Поставить точку останова',
          onSelect: () => void debug.toggleBreakpoint(path, line).then((list) => editors.setBreakpoints(path, list)),
        },
      ],
      lastPointer.x,
      lastPointer.y,
    );
  };

  // Правый клик на жёлобе: координаты берём из последнего события мыши — у самого
  // события Monaco нет координат окна, а меню ставится по месту нажатия.
  const lastPointer = { x: 0, y: 0 };
  document.addEventListener(
    'mousedown',
    (event) => {
      lastPointer.x = event.clientX;
      lastPointer.y = event.clientY;
    },
    true,
  );
  editors.onBreakpointMenu(openBreakpointMenu);

  // Останов: подсвечиваем строку и показываем панель. Пока программа идёт или
  // отладка не запущена — подсветки нет.
  let revealedFrameId: number | null = null;
  let debugWasStopped = false;
  debug.onDidChange((state) => {
    const frame = state.phase === 'stopped' ? state.topFrame : null;
    editors.setDebugLine(frame?.path ?? null, frame?.line ?? null);

    // Панель отладки показываем только на НОВОМ останове: иначе каждое событие
    // (в том числе «программа идёт») уводило бы фокус из той вкладки дока, куда
    // человек ушёл сам, — например, в терминал.
    const stopped = state.phase === 'stopped';
    if (stopped && !debugWasStopped) dock.show('debug');
    debugWasStopped = stopped;

    // Остановились в файле, которого нет на экране, — открываем его и встаём на
    // строку: иначе видно панель, но не место, где программа стоит. Делаем это
    // только на НОВОМ останове: пока отладчик стоит, человек мог уйти в другой файл.
    if (frame?.path && frame.id !== revealedFrameId) {
      revealedFrameId = frame.id;
      void openPath(frame.path).then(() => editors.revealDebugFrame(frame.path!, frame.line, frame.column));
    }
    if (state.phase === 'idle') revealedFrameId = null;
  });
  tools.onDidChange(() => {
    syncRunControl();
    refreshStatus();
  });
  workspace.onDidChange((info) => {
    refreshStatus();
    syncEmptyState();
    void tools.refresh(workspace.root).then(() => syncRunControl());
    void refreshScan();
    // Новый проект — могли появиться свои серверы в окружении (pylsp в venv).
    void ensureLspServers();
    // Другой проект — другое рабочее место: восстанавливаем его из сессии,
    // затем накладываем настройки и макет проекта из .chui_ide.
    if (info) {
      void restoreSession(info.root).then(() => loadProjectConfig(info.root));
    } else {
      sessionRoot = null;
      resetProjectConfig();
    }
  });
  editors.onCursorChange((state) => statusBar.update({ line: state.line, column: state.column }));
  rpc.onDidChangeStreaming((streaming) => statusBar.update({ ai: streaming ? 'генерация…' : 'готов' }));

  theme.onDidChange((scheme) => {
    editors.setTheme(scheme);
    terminalPanel.setScheme(scheme);
    setHighlightScheme(scheme);
    syncThemeButton();
  });
  theme.apply();

  new KeybindingService(commands, [
    { combo: 'Alt+1', command: 'view.showExplorer' },
    { combo: 'Alt+2', command: 'search.project' },
    { combo: 'Ctrl+Shift+P', command: 'palette.open' },
    { combo: 'Ctrl+Shift+O', command: 'file.quickOpen' },
    // Символ по проекту — привычка из VS Code и PyCharm.
    { combo: 'Ctrl+T', command: 'navigate.symbol' },
    { combo: 'Ctrl+,', command: 'settings.open' },
    { combo: 'Ctrl+Shift+G', command: 'view.showChanges' },
    { combo: 'Ctrl+`', command: 'view.showTerminal' },
    { combo: 'Ctrl+Alt+E', command: 'ai.openInEditor' },
    // Запуск — как в PyCharm (Shift+F10) и VS Code (Ctrl+F5): обе привычки живут рядом.
    { combo: 'Ctrl+F5', command: 'run.file' },
    { combo: 'Shift+F10', command: 'run.choose' },
    // Тесты — рядом с запуском: Ctrl+Shift+F5, как принято в IDE.
    { combo: 'Ctrl+Shift+F5', command: 'run.tests' },
    // Форматирование — как в VS Code и PyCharm: Shift+Alt+F. Инструмент выбирается
    // по языку: у Python это ruff/black окружения, у JS/TS — prettier/biome проекта.
    { combo: 'Shift+Alt+F', command: 'format.document' },
    // Отладка — привычные из VS Code: F5 пуск/продолжить, Shift+F5 стоп,
    // F9 точка останова, F10/F11 шаги.
    { combo: 'F5', command: 'debug.continue' },
    { combo: 'Shift+F5', command: 'debug.stop' },
    { combo: 'F9', command: 'debug.toggleBreakpoint' },
    { combo: 'F10', command: 'debug.stepOver' },
    { combo: 'F11', command: 'debug.stepInto' },
    { combo: 'Shift+F11', command: 'debug.stepOut' },
    // Меню — как в приложениях KDE: Alt+F10 открывает его с клавиатуры.
    { combo: 'Alt+F10', command: 'app.showMenu' },
  ]).attach(window);

  // Проект мог быть открыт ещё в стартовом окне: main помнит корень, и окно IDE
  // забирает его себе, чтобы не спрашивать папку второй раз. Делаем это после
  // подписок — иначе дерево, панель изменений и статусбар не узнают об открытии.
  const current = await rpc.request('workspace.current');
  if (current.root) await workspace.open(current.root);

  await tools.refresh(workspace.root);
  await refreshScan();
  await ensureLspServers();
  syncRunControl();

  syncViewButtons();
  refreshStatus();
  syncEmptyState();
  void git.refresh();
  void windowFrame.refresh();
  // В dev-режиме сервисы доступны из консоли и автотестов: удобно проверять
  // программные правки (тот же путь, которым будет пользоваться ассистент).
  if (import.meta.env.DEV) {
    (window as unknown as { __chui?: Record<string, unknown> }).__chui = {
      rpc,
      commands,
      documents,
      editors,
      edits,
      workspace,
      openEditors,
      chat,
      dock,
      layout,
      explorer,
      terminalPanel,
      testPanel,
      sourceControl,
      diffView,
      git,
      theme,
      tools,
    };
  }
}

/**
 * Чем запустится активный файл. В статусбаре важно именно «чем», а не «каким
 * языком»: системный python3 и интерпретатор окружения проекта выглядят
 * одинаково, пока не увидишь путь.
 *
 * Python сюда не попадает: у него отдельный виджет окружения с попапом — вторая
 * строчка про интерпретатор только повторяла бы его теми же словами.
 */
function toolLabel(language: string | null, project: ProjectTools): string | null {
  if (!language || !project.root) return null;
  if (language === 'python') return null;
  if (language === 'javascript' || language === 'typescript') {
    return project.hasPackageJson ? `${project.packageManager}` : 'node';
  }
  return null;
}
