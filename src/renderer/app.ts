import { PushTopic, type SessionState, type Settings, type WorkspaceChangedPayload } from '../shared/api';
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
import { envShortLabel, envVisible } from './core/python-view';
import { DebugController } from './core/debug';
import { RpcClient } from './core/rpc';
import {
  collectRunTargets,
  entryLine,
  nodeInstallTarget,
  pytestCoverageTarget,
  pytestTarget,
  type RunTarget,
  type RunnableFile,
} from './core/run-config';
import type { ProjectScan } from '../shared/project-scan';
import { ThemeService } from './core/theme-service';
import { WindowFrame } from './core/window-frame';
import { WorkspaceModel } from './core/workspace-model';
import { showApplicationMenu } from './ui/app-menu';
import { createBreadcrumbs } from './ui/breadcrumbs';import { createChatPanel } from './ui/chat';
import { createDock } from './ui/dock';
import { createDiffView } from './ui/diff-view';
import { basename, clear, h, svgIcon, type IconName } from './ui/dom';
import { createEmptyState } from './ui/empty-state';
import { createExplorer } from './ui/explorer';
import { createLayout } from './ui/layout';
import { logoMark } from './ui/logo';
import { createPalette } from './ui/palette';
import { createPopover, type PopoverView } from './ui/popover';
import { createPythonEnvPopover, type PythonEnvPopoverView } from './ui/python-env-popover';
import { createQuickOpen } from './ui/quick-open';
import { createSymbolPicker } from './ui/symbol-picker';
import { closePopupMenu, isPopupOpen, showPopupMenu } from './ui/popup-menu';
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

  const layout = createLayout(mount);
  const statusBar = createStatusBar({
    openGitManager: (anchor) => openGitManager(anchor),
    openPythonEnv: (anchor) => openPythonEnv(anchor),
  });
  layout.statusBarHost.appendChild(statusBar.element);

  let settings = await rpc.request('settings.get');
  const info = await rpc.request('app.info');
  console.info(`[chui] Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node} · ${info.platform}`);

  // Тема: main — источник истины, сервис знает и выбор пользователя, и фактическую схему.
  const theme = new ThemeService(rpc, settings.appearance.theme);

  const editors = new EditorService(layout.editorHost, documents, settings.editor, theme.monacoThemeId);
  const edits = new EditService({ documents, editors, rpc });
  // Отладчик: состояние сессии держит контроллер, события идут из main push-ом.
  const debug = new DebugController(rpc);
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
  const settingsModal = createSettingsModal({ rpc, commands, theme });
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

  const diffView = createDiffView({ createDiff: (container) => editors.createDiff(container), git });
  layout.editorHost.appendChild(diffView.element);

  const searchView = createSearchView({
    rpc,
    commands,
    workspace,
    // Замена пишет файлы на диске: открытые вкладки перечитываем сразу.
    reloadFile: (path) => reloadIfOpen(path),
  });
  const terminalPanel = createTerminalPanel({ rpc, cwd: () => workspace.root, scheme: theme.resolved });

  // Панель тестов: список собирается при показе — правки в коде меняют его.
  const testPanel = createTestPanel({
    rpc,
    root: () => workspace.root,
    // Панель просит отчёт — команда уносит в терминал и печать кода выхода,
    // по ней панель и красит узлы. Покрытие — отдельная цель.
    onRun: (selector, options) => void runTarget(pytestTarget(tools.get(), selector, { ...options, platform: info.platform })),
    onCoverage: (selector) => void runTarget(pytestCoverageTarget(tools.get(), selector, { report: true, platform: info.platform })),
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
  /** Карта проекта: из неё берём тесты и точку входа. Пусто, пока проект не открыт. */
  let projectScan: ProjectScan | null = null;

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
    return collectRunTargets(runnableFileOf(document), tools.get(), projectScan);
  }

  /**
   * Кнопка запуска и значок ▶ в жёлобе говорят одно и то же: что можно запустить
   * в этом файле. Значок ставим только у настоящей точки входа — иначе жёлоб
   * пестреет стрелками у каждого файла.
   */
  function syncRunControl(): void {
    const active = openEditors.active;
    runControl.update(targetsFor(active));

    // Полоса под вкладками нужна ровно тогда, когда в ней есть что показать:
    // путь из одного сегмента крошек не рисует, и без кнопки запуска
    // оставалась бы пустая полоска с линией на всю ширину.
    layout.breadcrumbsHost.hidden = breadcrumbs.hidden && runControl.element.hidden;

    if (!active) return;
    const line = entryLine(active.languageId, active.value);
    const signature = `${active.path}:${line ?? 0}`;
    if (signature === runMarkerSignature) return;
    runMarkerSignature = signature;
    editors.setRunLines(active.path, line ? [line] : []);
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
    { class: 'icon-btn', type: 'button', title: 'Меню приложения', onClick: () => void commands.execute('app.showMenu') },
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
  });
  dock.register({ id: 'debug', title: 'Отладка', element: debugPanel.element, onShow: () => debugPanel.refresh() });

  /* ── сессия рабочей папки ──────────────────────────────────────────────── */

  /** Какой проект сейчас восстановлен: ключ, по которому кладётся сессия. */
  let sessionRoot: string | null = null;
  /** Пока идёт восстановление, сохранять нельзя — иначе затрём файл пустотой. */
  let restoringSession = false;
  let sessionSaveTimer = 0;

  /** Текущее рабочее место: что открыто, что раскрыто, какие панели видны. */
  const captureSession = (): SessionState => ({
    tabs: [...openEditors.paths],
    ...(openEditors.active ? { activeTab: openEditors.active.path } : {}),
    expanded: explorer.expandedPaths(),
    dockVisible: layout.dockVisible,
    ...(dock.activeId ? { dockActive: dock.activeId } : {}),
    sidebarVisible: layout.sidebarVisible,
    rightVisible: layout.rightVisible,
  });

  const scheduleSessionSave = (): void => {
    if (!sessionRoot || restoringSession) return;
    if (sessionSaveTimer) window.clearTimeout(sessionSaveTimer);
    sessionSaveTimer = window.setTimeout(() => {
      sessionSaveTimer = 0;
      if (!sessionRoot || restoringSession) return;
      void rpc
        .request('session.save', { root: sessionRoot, state: captureSession() })
        .catch(() => undefined); // не сохранилось — не повод мешать работе
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
      layout.setSidebarVisible(state.sidebarVisible);
      // Панель ассистента не восстанавливаем, если AI выключен: её место свободно.
      layout.setRightVisible(state.rightVisible && aiEnabled());
      if (state.dockVisible) {
        if (state.dockActive) dock.show(state.dockActive);
      } else {
        dock.hide();
      }
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
  // Закрытие окна: последний шанс сохранить рабочее место (без ожидания ответа).
  window.addEventListener('beforeunload', () => {
    if (sessionRoot && !restoringSession) {
      void rpc.request('session.save', { root: sessionRoot, state: captureSession() }).catch(() => undefined);
    }
  });

  const saveDocument = async (document: TextDocument): Promise<void> => {
    // Форматирование при сохранении: правку проводит документ, поэтому на экране
    // и на диске оказывается одно и то же.
    if (settings.editor.formatOnSave) await formatDocument(document);
    await rpc.request('workspace.writeFile', { path: document.path, text: document.value });
    document.markSaved();
    showToast(`Сохранено: ${basename(document.path)}`);
  };

  /* ── Python-инструменты: формат и установка ────────────────────────────── */

  /** Форматирование — про Python: инструменты (ruff, black) питоновские. */
  const isFormattable = (languageId: string): boolean => languageId === 'python';

  /**
   * Отформатировать документ инструментом окружения. true — текст изменился.
   * Правку проводим через документ: так она попадает в undo и в сохранение.
   */
  const formatDocument = async (document: TextDocument): Promise<boolean> => {
    if (!isFormattable(document.languageId)) return false;
    const result = await rpc
      .request('python.format', { path: document.path, text: document.value })
      .catch(() => null);
    if (!result?.tool || result.text === document.value) return false;
    document.setText(result.text, 'programmatic');
    return true;
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

  define({ id: 'file.revealAt', title: 'Перейти к позиции', category: 'Навигация' }, async (path, line, column) => {    if (typeof path !== 'string') return;
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

  define({ id: 'run.tests', title: 'Запустить тесты (pytest)', category: 'Запуск' }, async () => {
    const active = openEditors.active;
    const relative = active ? workspace.relative(active.path) : null;
    const targets = collectRunTargets(runnableFileOf(active), tools.get(), projectScan);
    const runnable = relative && relative !== active?.path ? relative : null;
    const target =
      targets.find((item) => item.source === 'test' && item.id === `pytest:${runnable}`) ??
      targets.find((item) => item.id === 'pytest:all');
    if (!target) {
      showToast('Тесты не найдены: нужен проект на Python с файлами тестов', 'error');
      return;
    }
    await runTarget(target);
  });

  /* ── отладка ───────────────────────────────────────────────────────────── */

  /** Начать отладку активного файла: как запуск, но под debugpy. */
  const startDebug = async (): Promise<void> => {
    const active = openEditors.active;
    if (!active || active.languageId !== 'python') {
      showToast('Отладчик работает с файлами Python', 'error');
      return;
    }
    if (settings.run.saveBeforeRun) {
      for (const document of documents.dirty()) await saveDocument(document);
    }
    const result = await debug.start(active.path);
    if (!result.ok) showToast(result.message, 'error');
    else dock.show('debug');
  };

  define({ id: 'debug.start', title: 'Отладка: запустить файл', category: 'Отладка' }, startDebug);

  // F5 как в VS Code: не идёт отладка — начать, стоит на паузе — продолжить.
  define({ id: 'debug.continue', title: 'Отладка: продолжить / запустить', category: 'Отладка', keybinding: 'F5' }, async () => {
    if (debug.get().phase === 'idle') await startDebug();
    else await debug.resume();
  });
  define({ id: 'debug.stop', title: 'Отладка: остановить', category: 'Отладка', keybinding: 'Shift+F5' }, async () => {
    await debug.stop();
  });
  define({ id: 'debug.stepOver', title: 'Отладка: шаг с обходом', category: 'Отладка', keybinding: 'F10' }, async () => {
    await debug.step('over');
  });
  define({ id: 'debug.stepInto', title: 'Отладка: шаг с заходом', category: 'Отладка', keybinding: 'F11' }, async () => {
    await debug.step('into');
  });
  define({ id: 'debug.stepOut', title: 'Отладка: шаг из функции', category: 'Отладка', keybinding: 'Shift+F11' }, async () => {
    await debug.step('out');
  });

  // F9 — точка останова на строке курсора: привычное место, не уводя руки с клавиатуры.
  define({ id: 'debug.toggleBreakpoint', title: 'Отладка: переключить точку останова', category: 'Отладка', keybinding: 'F9' }, async () => {
    const active = openEditors.active;
    if (!active) return;
    const line = editors.cursor().line;
    const lines = await debug.toggleBreakpoint(active.path, line);
    editors.setBreakpoints(active.path, lines);
  });

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

  define({ id: 'file.quickOpen', title: 'Быстрое открытие файла', category: 'Навигация', keybinding: 'Ctrl+Shift+O' }, () => {
    void quickOpen.open();
  });

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

  define({ id: 'settings.open', title: 'Настройки', category: 'Настройки', keybinding: 'Ctrl+,' }, () => settingsModal.open());

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
      id: 'python.format',
      title: 'Python: форматировать файл',
      category: 'Python',
      keywords: ['ruff', 'black', 'формат'],
    },
    async () => {
      const document = openEditors.active;
      if (!document || !isFormattable(document.languageId)) {
        showToast('Форматировать можно только файл Python');
        return;
      }
      const changed = await formatDocument(document);
      showToast(changed ? 'Файл отформатирован' : 'Менять нечего');
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

  define({ id: 'ai.openInEditor', title: 'Перенести чат в окно редактора', category: 'AI', keybinding: 'Ctrl+Alt+E' }, () =>
    showChatTab(),
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
      workspace: workspace.current?.name ?? null,
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
      // У Python всё про окружение — в одном попапе; в статусбаре отдельная надпись
      // «Python» дублировала бы его. У остальных проектов вид виден чипом, и только
      // когда он вообще опознан: «Неизвестно» в полосе — лишний шум.
      projectKind:
        projectScan && projectScan.kind.source !== 'none' && projectScan.kind.id !== 'python'
          ? projectScan.kind.label
          : null,
      // Виджет окружения — только там, где он осмыслен: Python-проект или уже
      // выбранный интерпретатор. У Node-проекта его не показываем.
      env:
        workspace.root && envVisible(projectScan?.kind.id ?? null, projectTools, settings.run.pythonPath)
          ? envShortLabel(projectTools)
          : null,
    });

    // Заголовок окна: как в VS Code — открытый файл и проект.
    const project = workspace.current?.name;
    layout.topBarTitle.textContent = active
      ? project
        ? `${basename(active.path)} — ${project}`
        : basename(active.path)
      : 'Chui IDE';
    layout.topBarTitle.title = active?.path ?? 'Chui IDE';
  };

  const syncEmptyState = (): void => emptyState.update(openEditors.paths.length > 0);

  const applySettings = (next: Settings): void => {
    settings = next;
    editors.applyOptions(next.editor);
    explorer.applySettings(next.explorer);
    chat.applySettings(next);
    settingsModal.applySettings(next);
    // Ассистент выключили мастер-тумблером — закрываем его панель и обновляем шапку,
    // чтобы она не занимала место и не звала в выключенный чат.
    if (!next.ai.enabled) {
      if (chatInEditor) setChatInEditor(false);
      if (layout.rightVisible) layout.setRightVisible(false);
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
        applySettings(message.payload as Settings);
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
    // при открытии вкладки отдаём ему набор — значки появятся сразу.
    for (const path of openEditors.paths) editors.setBreakpoints(path, debug.linesOf(path));
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

  // Клик по полю номеров строк — точка останова: контроллер держит набор, а
  // редактор рисует по нему значки. Один источник истины — контроллер.
  editors.onBreakpointToggle(({ path, line }) => {
    void debug.toggleBreakpoint(path, line).then((lines) => editors.setBreakpoints(path, lines));
  });

  // Останов: подсвечиваем строку и показываем панель. Пока программа идёт или
  // отладка не запущена — подсветки нет.
  debug.onDidChange((state) => {
    const frame = state.phase === 'stopped' ? state.topFrame : null;
    editors.setDebugLine(frame?.path ?? null, frame?.line ?? null);
    if (state.phase !== 'idle') dock.show('debug');
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
    // Другой проект — другое рабочее место: восстанавливаем его из сессии.
    if (info) void restoreSession(info.root);
    else sessionRoot = null;
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
    // Форматирование — как в VS Code и PyCharm: Shift+Alt+F.
    { combo: 'Shift+Alt+F', command: 'python.format' },
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
