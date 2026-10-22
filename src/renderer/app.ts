import {
  PushTopic,
  type BrowserEventPayload,
  type DebugLaunchOptions,
  type LayoutSettings,
  type Settings,
  type SettingsPatch,
  type WorkspaceChangedPayload,
} from '../shared/api';
import { mergeDeep, type ProjectSettings } from '../shared/project-config';
import { menuChecks } from '../shared/app-menu';
import { aiPanelPlan } from '../shared/ai-panel';
import { settingsPlan } from '../shared/settings-plan';
import { lspChipFor, NO_LSP_STATUS, type LspStatus } from '../shared/lsp-status';
import { symbolIndexChip, type SymbolIndexStatus } from '../shared/symbol-index';
import { createSymbolPoller } from './core/symbol-poll';
import { perf } from '../shared/perf';
import type { FileOperation } from '../shared/lsp-workspace-edit';
import type { LspProgress } from '../shared/lsp-progress';
import { createLspProgressController } from './core/lsp-progress';
import { DEFAULT_SNIPPETS } from '../shared/snippets';
import { revertPrompt } from '../shared/unsaved';
import { AutoSave } from './core/auto-save';
import { createBlameController } from './core/blame';
import { createChangeGutterController } from './core/change-gutter';
import { CommandRegistry, type CommandDescriptor } from './core/commands';
import type { TextDocument } from './core/document';
import { uriToPath } from './core/document';
import { DocumentStore } from './core/document-store';
import { EditService } from './core/edits';
import { HostService } from './core/host';
import { EditorWorkspace } from './editor/host/editor-workspace';
import { DocumentRegistry } from './editor/host/document-registry';
import { LspFeatures } from './editor/host/lsp-features';
import { GitModel } from './core/git-model';
import { ReviewModel } from './core/review-model';
import { registerGitWriteCommands } from './core/git-write-commands';
import { registerGitViewCommands } from './core/git-view-commands';
import { registerGitAiCommands } from './core/git-ai-commands';
import { registerGitPanelCommands } from './core/git-panel-commands';
import { registerGitSyncCommands } from './core/git-sync-commands';
import { registerGitToolsCommands } from './core/git-tools-commands';
import { registerGitHistoryCommands } from './core/git-history-commands';
import { createEditorFixes } from './core/editor-fixes';
import { createGutterMenus } from './core/gutter-menus';
import { createSymbolPickers } from './core/symbol-pickers';
import { BookmarkModel } from './core/bookmarks';
import { editorContextMenuPlan } from './core/editor-menu';
import { SpellCheck } from './core/spellcheck';
import { ProjectPackagesModel } from './core/project-packages';
import { parseCoverageJson } from '../shared/coverage-json';
import { parseNodeCoverage } from '../shared/node-coverage';
import { diagnoseHighlighting, refreshHighlight } from './core/highlight';
import { KeybindingService } from './core/keybindings';
import { DEFAULT_KEYBINDINGS } from './core/default-keybindings';
import { languageFromPath, languageLabel, languageIndent } from './core/languages';
import { normalizeBrowserUrl, isLocalUrl } from '../shared/browser';
import { imageFormatLabel, isImagePath } from '../shared/images';
import { fileUrlFor, isPdfPath, pdfTabTitle } from '../shared/pdf';
import { isOfficePath, officeFormatLabel as officeFormatChip } from '../shared/office';
import { BrowserTabs } from './core/browser-tabs';
import { ImportChecker } from './core/import-check';
import { LspClient } from './core/lsp';
import { OpenEditors } from './core/open-editors';
import { AutoPanelLayout } from './core/panel-layout';
import { ProjectToolsModel } from './core/project-tools';
import { createPreloadPlanner } from './core/env-preload';
import { hasEntries, splitSettingsPatch } from './core/settings-patch';
import { planCheckout, planCommitSave, type CheckoutPlan } from './core/file-actions';
import { projectSymbolAnswer, toProjectSymbols } from './core/project-symbols';
import {
  DEFAULT_MACRO_TIMES,
  checkMacroTimes,
  macroPlayCheck,
  macroPlayedNotice,
  macroRecordedNotice,
} from './core/macro-run';
import { registerFileCreateCommands } from './core/file-create-commands';
import { registerFileMutationCommands } from './core/file-mutation-commands';
import { registerDebugCommands } from './core/debug-commands';
import { registerAiCommands } from './core/ai-commands';
import { registerViewCommands, type ZenSnapshot } from './core/view-commands';
import { registerEditorFixCommands } from './core/editor-fix-commands';
import { registerEditorModeCommands, type EditorModeName } from './core/editor-mode-commands';
import { registerFileSaveCommands } from './core/file-save-commands';
import { registerFileTabCommands } from './core/file-tab-commands';
import { registerExplorerCommands } from './core/explorer-commands';
import { registerRunCommands } from './core/run-commands';
import { registerPythonCommands } from './core/python-commands';
import { DebugController, frameForHover } from './core/debug';
import { resolveInlineValues } from './core/inline-values';
import { RpcClient } from './core/rpc';
import { addressProblem } from '../shared/fs-address';
import { resolveExplorerSettings } from '../shared/explorer-settings';
import { createSessionControl } from './core/session-control';
import {
  collectRunTargets,
  entryLine,
  nodeCoverageTarget,
  pytestCoverageTarget,
  type RunTarget,
  type RunnableFile,
  testTargetOf,
} from './core/run-config';
import type { ProjectScan } from '../shared/project-scan';
import { detectNodeTestRunner, type NodeTestRunner } from '../shared/node-tests';
import { formatEngine, formatToolNames, type FormatEngine } from '../shared/format';
import { createInstallActions } from './core/install-actions';
import { isNodeLanguage } from '../shared/languages';
import { indentFoldRanges, mergeFoldRanges } from '../shared/fold-ranges';
import { surroundOptions } from './editor/input/surround';
import { semanticFoldRanges } from './editor/highlight/folds';
import { languageGrammar } from './editor/highlight/lazy-registry';
import { toWorkspaceFileEdits } from '../shared/lsp-workspace-edit';
import { applySaveEdits } from '../shared/save-edits';
import { applyTextEdits, fromOffset } from '../shared/edits';
import { decideSaveAs } from '../shared/save-as';
import { pairFromSelection } from './core/file-compare';
import { isInsidePath, joinPath, pathAfter, separatorOf, splitPath } from '../shared/paths';
import { ThemeService } from './core/theme-service';
import { WindowFrame } from './core/window-frame';
import { WorkspaceModel } from './core/workspace-model';
import { showApplicationMenu } from './ui/app-menu';
import { showContextMenu } from './ui/context-menu';
import { createBreadcrumbs } from './ui/breadcrumbs';
import { createChatPanel, type ChatView } from './ui/chat';
import { createDock } from './ui/dock';
import { createConflictView } from './ui/conflict-view';
import { createDiffView } from './ui/diff-view';
import { basename, h, svgIcon, type IconName } from './ui/dom';
import { createEmptyState } from './ui/empty-state';
import { createImageView } from './ui/image-view';
import { createBrowserView } from './ui/browser-view';
import { createExplorer } from './ui/explorer';
import { createLaunchOptionsModal } from './ui/launch-options-modal';
import { createLayout } from './ui/layout';
import { createLspPopover } from './ui/lsp-popover';
import { createMarkdownPreview, isMarkdownPath } from './ui/markdown-preview';
import { createDocView } from './ui/doc-view';
import { createNotebookPanel } from './ui/notebook-panel';
import { logoMark } from './ui/logo';
import { createNodeEnvPopover } from './ui/node-env-popover';
import { createOutline } from './ui/outline';
import { createProblemPanel } from './ui/problem-panel';
import { problemBadgeText } from '../shared/problem-list';
import { TODO_QUERY, toTodoItems } from '../shared/todo-list';
import { createPalette } from './ui/palette';
import { createPythonEnvPopover } from './ui/python-env-popover';
import { createLazyPopover } from './ui/lazy-popover';
import { createMeaningSearch } from './ui/meaning-search';
import { createQuickOpen } from './ui/quick-open';
import { createSymbolPicker } from './ui/symbol-picker';
import { isEmptyTest, suggestTestPath, truncateTestCode } from '../shared/test-generation';
import { closePopupMenu, isPopupOpen, showPopupMenu } from './ui/popup-menu';
import { createPromptModal } from './ui/prompt-modal';
import { createRunButton } from './ui/run-button';
import { createSearchView } from './ui/search';
import { createSourceControl } from './ui/source-control';
import { createRootSettingsModal } from './ui/root-settings-modal';
import { createRemoteFileModal } from './ui/remote-file-modal';
import { createStashModal } from './ui/stash-modal';
import { createRebaseModal } from './ui/rebase-modal';
import { createRefDiffModal } from './ui/ref-diff-modal';
import { createFolderCompareModal } from './ui/folder-compare-modal';
import { createBisectModal } from './ui/bisect-modal';
import { createWorktreeModal } from './ui/worktree-modal';
import { createLfsModal } from './ui/lfs-modal';
import { createSparseModal } from './ui/sparse-modal';
import { createHistoryModal } from './ui/history-modal';
import { createBookmarksModal } from './ui/bookmarks-modal';
import { createSurroundModal } from './ui/surround-modal';
import { createRegexTester } from './ui/regex-tester';
import { createStructuralSearch } from './ui/structural-search';
import { createIdentityModal } from './ui/identity-modal';
import { createTelemetryModal } from './ui/telemetry-modal';
import { createForgeModal } from './ui/forge-modal';
import { createIssuesModal } from './ui/issues-modal';
import { createPipelinesModal } from './ui/pipelines-modal';
import { createNotificationsModal } from './ui/notifications-modal';
import { createTextModal } from './ui/text-modal';
import { createStatusBar } from './ui/statusbar';
import { needsLspRefresh, statusPatch } from './core/status-state';
import { createSettingsModal } from './ui/settings-modal';
import { createTabs, type PagesTabSource } from './ui/tabs';
import { createTerminalPanel } from './ui/terminal';
import { createDebugPanel } from './ui/debug-panel';
import { createTestPanel } from './ui/test-panel';
import { createTodoPanel } from './ui/todo-panel';
import { showToast } from './ui/toast';
import { installTooltips } from './ui/tooltip';
import { createVenvModal } from './ui/venv-modal';
import { createLspServers } from './core/lsp-servers';
import { editorActionCommands } from './core/editor-actions';
import { outcomeOfFailure } from './core/file-operations';
import { editorSurfacePlan } from './core/editor-surface';
import { testMarkerSignature as testMarkerSignatureOf, testMarkersFor } from './core/test-markers';

/**
 * Точка сборки приложения: сервисы, команды, подписки.
 * Всё остальное — модули, которые друг о друге почти ничего не знают.
 */
export async function startApplication(mount: HTMLElement): Promise<void> {
  // Подсказки — свои, вместо системных: ставятся один раз на всё окно и ловят
  // наведение на документе (см. `ui/tooltip.ts`).
  installTooltips();

  const rpc = new RpcClient();
  const commands = new CommandRegistry();
  const documents = new DocumentStore();
  const openEditors = new OpenEditors(documents);
  const workspace = new WorkspaceModel(rpc);
  // Состояние репозитория — отдельная модель: она подписана на push-события main,
  // поэтому UI не переспрашивает статус после каждой своей операции.
  const git = new GitModel(rpc, workspace);
  // Замечания к коду (code review): их показывает и правит экран сравнения.
  const reviews = new ReviewModel(rpc, workspace);
  // Пакеты проекта (монорепо): по ним панель изменений раскладывает правки.
  const packages = new ProjectPackagesModel(rpc, workspace);

  const layout = createLayout(mount, { onChange: () => void persistLayout() });
  // Адаптив панелей по ширине окна: мнение о размере отдельно от желания человека,
  // поэтому решение о видимости живёт в своей модели (`core/panel-layout`).
  const panelAuto = new AutoPanelLayout();
  const statusBar = createStatusBar({
    openGitManager: (anchor) => openGitManager(anchor),
    openPythonEnv: (anchor) => openPythonEnv(anchor),
    openNodeEnv: (anchor) => openNodeEnv(anchor),
    openProblems: () => editors.revealNextProblem(),
    openLsp: (anchor) => openLsp(anchor),
  });
  layout.statusBarHost.appendChild(statusBar.element);

  // ОбщеIDE-настройки хранятся в userData; настройки проекта (.chui_ide) ложатся поверх.
  let baseSettings = await rpc.request('settings.get');
  let projectSettings: ProjectSettings = {};
  let settings = baseSettings;
  const layoutGuard = { applying: false };
  /**
   * Масштаб интерфейса: одна пара переменных, от которой считаются все кегли и
   * размеры элементов (см. `theme.css`). Ставим на корень документа — пересчёт
   * делает CSS, перерисовывать ничего не нужно. Ставится сразу после чтения
   * настроек: с окна без проекта тоже.
   */
  const applyUiScale = (scale: number): void => {
    const root = document.documentElement;
    root.style.setProperty('--font_scale', String(scale));
    root.style.setProperty('--density', String(scale));
  };
  applyUiScale(settings.appearance.uiScale);

  const rebuildSettings = (): Settings => {
    const merged = mergeDeep(baseSettings, projectSettings);
    settings = (merged ?? baseSettings) as Settings;
    return settings;
  };

  // Правка настроек: IDE-секции уходят в userData, проектные (editor/explorer/run/lsp) — в .chui_ide.
  async function saveSettingsPatch(value: SettingsPatch): Promise<Settings> {
    const root = workspace.root;
    const { project: projectPatch, global: globalPatch } = splitSettingsPatch(value as Record<string, unknown>);
    if (root && hasEntries(projectPatch)) {
      projectSettings = await rpc.request('project.updateSettings', {
        root,
        patch: projectPatch as ProjectSettings,
      });
    }
    if (hasEntries(globalPatch)) {
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
          editorVisible: layout.editorVisible,
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
      layout.setEditorVisible(saved.editorVisible);
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
  // Версию приложения печатаем при старте: по ней видно, на чём воспроизводят проблему.
  console.info(
    `[chui] v${info.appVersion} · Electron ${info.electron} · Chromium ${info.chrome}`,
    `· Node ${info.node} · ${info.platform}`,
  );

  // Тема: схема одна — тёмная, сервис держит активную тему из файла.
  const theme = new ThemeService(rpc, settings.appearance.customTheme ?? null);

  // Языковой сервер: наведение, определение, ссылки, подсказки, переименование.
  // Сервер живёт в main — здесь только мост, который уходит швами в рабочее место.
  const lsp = new LspFeatures(rpc);

  /**
   * Закладки: строки файлов, к которым хочется вернуться. Список — рабочее место
   * проекта, поэтому его хранит сессия (см. ниже), а редактор только рисует значки.
   */
  const bookmarks = new BookmarkModel();

  /**
   * Проверка орфографии: словарь системы приходит из main (в песочнице renderer файлов
   * не читает), слова человека — из настроек. Одна модель на всё приложение: словарь
   * у всех панелей общий, и слово, добавленное где-то, снимает отметку везде.
   */
  const spell = new SpellCheck();
  spell.setUserWords(settings.editor.spellWords);
  void rpc
    .request('spell.dictionary')
    .then((dictionary) => spell.setDictionary(dictionary.words))
    .catch(() => undefined);

  /**
   * Редактор — своё ядро (`src/renderer/editor/`), без чужого движка. Всё, что раньше навешивалось
   * на движок (подсказки LSP, inline-AI, сниппеты, Ctrl+Click), приходит сюда опциями:
   * у рабочего места для каждого из них есть шов.
   */
  /**
   * Подсказки из карты символов — для обычного набора. Карта отвечает мгновенно и без
   * языковых серверов: она знает объявления проекта, даже когда сервер молчит,
   * поднимается или языка в нём нет.
   */
  const symbolsFromIndex = async (query: string) =>
    toProjectSymbols(await rpc.request('index.find', { query }).catch(() => []));

  /**
   * Подсказки из карты вместе с языковыми серверами — обычный ответ на запрос
   * «символы проекта» (второй и третий уровень Ctrl+Space).
   */
  const symbolsFromProject = async (query: string) => {
    const [found, status] = await Promise.all([
      rpc.request('lsp.symbols', { query }).catch(() => []),
      rpc.request('index.status').catch(() => null),
    ]);
    // Карта не собрана — расширять нечем, и молчим: пустой ответ не должен
    // выглядеть как «в проекте ничего нет». Решение — в core/project-symbols.ts.
    return projectSymbolAnswer(found, status);
  };

  const editors = new EditorWorkspace(layout.editorHost, new DocumentRegistry(documents), {
    tabSize: settings.editor.tabSize,
    fontSize: settings.editor.fontSize,
    lineHeight: settings.editor.lineHeight,
    cursorStyle: settings.editor.cursorStyle,
    cursorBlink: settings.editor.cursorBlink,
    rulers: settings.editor.rulers,
    whitespace: settings.editor.renderWhitespace,
    minimap: settings.editor.minimap,
    wordWrap: settings.editor.wordWrap,
    smoothScroll: settings.editor.smoothScroll,
    vimMode: settings.editor.vimMode,
    // Смена режима Vim обновляет значок в строке состояния.
    onVimModeChange: () => refreshStatus(),
    emacsMode: settings.editor.emacsMode,
    ligatures: settings.editor.fontLigatures,
    // Живой геттер: настройку меняют в окне без пересоздания редактора.
    emmetEnabled: () => settings.editor.emmet,
    // Проверка орфографии: словарь общий, настройка — живой геттер.
    spellcheck: spell,
    spellcheckEnabled: () => settings.editor.spellcheck,
    // Слово, добавленное в словарь, запоминаем в настройках — тем же путём, что
    // и прочие правки: секция `editor` уходит в .chui_ide (или в userData без проекта).
    spellSaveWord: (word) => {
      void saveSettingsPatch({ editor: { spellWords: [...settings.editor.spellWords, word] } }).catch(() => undefined);
    },
    snippets: () => [...settings.editor.snippets, ...DEFAULT_SNIPPETS],
    // Наведение от сервера: текст разметки в карточку.
    hoverFromLanguage: async (path, position) => {
      const text = await lsp.hover(path, position);
      return text ? { text } : null;
    },
    // Подсказки от сервера подмешиваются к словам языка и документа.
    completionFromLanguage: (path, position) => lsp.completion(path, position),
    // Повторный Ctrl+Space расширяет список символами проекта: сначала свои объявления,
    // потом из зависимостей. Источник — карта символов: она отвечает мгновенно и без
    // языкового сервера, а `package` в ответе и есть признак чужого объявления.
    // При наборе (`onlyIndex`) нужна только карта — серверы спрашивают свой путь.
    projectSymbols: (query: string, onlyIndex?: boolean) =>
      onlyIndex ? symbolsFromIndex(query) : symbolsFromProject(query),
    // Файлы проекта — для подсказок пути внутри импорта: `from './ut'` просит файл,
    // а не слово. Пути приходят относительными — так их и пишут в импорте.
    projectFiles: () => rpc.request('workspace.listFiles').catch(() => []),
    // Ссылки в коде: сервер помечает участки (пути в import, адреса) — их показываем
    // подчёркнутыми, а клик открывает адрес или файл (см. `openDocumentLink`).
    documentLinks: async (path) => {
      const links = await lsp.documentLinks(path);
      // Часть серверов адрес отдаёт только в `resolve` — доводим те, у кого его нет.
      return Promise.all(
        links.map(async (link) => {
          if (link.target) return link;
          const target = await lsp.resolveDocumentLink(path, link.source).catch(() => null);
          return target ? { ...link, target } : link;
        }),
      );
    },
    openLink: (target, path) => void openDocumentLink(target, path),
    // Связанные участки: имена парных тегов (открывающий и закрывающий) правятся вместе.
    linkedEditing: (path, position) => lsp.linkedEditingRanges(path, position),
    // Выделение по структуре: сервер отдаёт цепочку участков вокруг места (слово,
    // выражение, строка, блок) — по ней работают «выделить шире/уже».
    selectionRanges: (path, position) => lsp.selectionRanges(path, position),
    // Семантическая подсветка: точные роли от сервера поверх своей грамматики.
    semanticTokens: (path) => lsp.semanticTokens(path),
    // Знаки-триггеры сервера (`@` в CSS, `:` в JSON): попап открывается сразу по ним.
    completionTriggers: (path) => lsp.completionTriggers(path),
    // Дотягивание подсказки: описание символа подтягивается при выделении строки.
    resolveCompletionItem: (path, item) => lsp.resolveCompletion(path, item),
    // Подсказка о параметрах вызова: карточка у каретки по набранной `(` или `,`.
    signatureFromLanguage: (path, position) => lsp.signatureHelp(path, position),
    // Определение и ссылки — списком мест, как и прочие переходы.
    symbols: {
      definition: (path, position) => lsp.definition(path, position),
      references: (path, position) => lsp.references(path, position),
    },
    // Переход к месту: открыть файл (это умеет приложение) и встать на строку.
    revealLocation: (path, line, column) => void openPath(path).then(() => editors.reveal(path, line, column)),
    // Выбор обёртки показывает приложение: у редактора нет ни модалок, ни списка
    // вариантов. Сам список зависит от языка файла — его знает редактор.
    surroundWith: () => surroundModal.open(),
    // Форматирование участка сервером: правки приходят готовыми — применяем обычным путём.
    formatRange: (path, range) => void formatRangeWithServer(path, range),
    formatOnPaste: () => settings.editor.formatOnPaste,
    // Текст целевого файла для «заглядывания»: открытый берём из документа (в нём
    // и несохранённые правки), прочий — с диска. Не прочитали — копию не покажем.
    readText: async (path) => {
      // Картинка — не текст: в копии оказался бы бинарь (см. `shared/images.ts`).
      if (isImagePath(path)) return null;
      const open = documents.get(path);
      if (open) return open.value;
      try {
        return (await rpc.request('workspace.readFile', { path })).text;
      } catch {
        return null;
      }
    },
    relativePath: (path) => workspace.relative(path),
    onNotice: (text) => showToast(text),
    // Переименование: имя спрашиваем диалогом, правки применяет документная модель.
    renameSymbol: (path, position) => {
      void (async () => {
        const newName = await promptValue({ title: 'Переименовать символ', label: 'Новое имя', value: '' });
        if (!newName) return;
        const edit = await lsp.workspaceEdit(path, position, newName);
        if (!edit || (edit.files.length === 0 && edit.operations.length === 0)) {
          showToast('Сервер не смог переименовать этот символ', 'error');
          return;
        }
        // Операции с файлами — до правок содержимого: сервер вправе переименовать файл,
        // а правки затем придут уже по новым путям (см. `shared/lsp-workspace-edit.ts`).
        const failure = await applyFileOperations(edit.operations);
        if (failure) {
          showToast(failure, 'error');
          return;
        }
        if (edit.files.length > 0) {
          const result = await edits.applyFileEdits(edit.files);
          if (result.failed.length > 0) showToast(result.failed[0]!.message, 'error');
        }
      })();
    },
    // Inline-подсказка «допиши за меня»: запрос к модели уходит в main через RPC.
    inlineCompletion: {
      // Два замка, а не один: личная галочка автодополнения и мастер-тумблер AI.
      // Main оба тоже проверяет (`requireAiEnabled`), но он тогда уже ответил
      // отказом — а значит, на каждую паузу в наборе летел бы RPC-вызов в никуда
      // и сыпался бы toast об ошибке. Редактор должен молчать сам.
      enabled: () => settings.ai.enabled && settings.ai.inlineCompletion.enabled,
      debounceMs: () => settings.ai.inlineCompletion.debounceMs,
      complete: async ({ path, language, prefix, suffix }) => {
        // Проверяем ещё и здесь: `enabled()` спрашивают по краю, а пауза в наборе
        // и сам запрос могут попасть в разные стороны тумблера.
        if (!settings.ai.enabled) return null;
        try {
          const result = await rpc.request('ai.complete', {
            path: workspace.relative(path),
            language,
            prefix,
            suffix,
          });
          return result.text || null;
        } catch {
          // Модель недоступна, ключа нет, выключено — подсказки просто нет.
          return null;
        }
      },
    },
    // Быстрые исправления: список действий языка показывает приложение — у него и попапы,
    // и языковой сервер, и документная модель для правок.
    codeActions: (path, position) => void fixes.runCodeActions(path, position),
    // Свёртка: диапазоны берём у сервера, а если он их не умеет — считаем по отступам.
    // Свёртка: сперва сервер (он видит блоки смыслово). Нет сервера — считаем сами:
    // по грамматике (скобки, блочные комментарии, длинные строки) и по отступам.
    // Два своих источника складываем: скобки накрывают C-подобный код, отступы —
    // то, что блоками не описано (Python, YAML, тексты).
    foldRanges: async (path, text) => {
      const fromServer = await lsp.foldingRanges(path);
      if (fromServer.length > 0) return fromServer;
      // Свёртка ждёт реестр (см. `lazy-registry`): без грамматики возвращаются только
      // отступы, а реестр к этому моменту обычно уже приехал — его просит открытие файла.
      const grammar = semanticFoldRanges(await languageGrammar(languageFromPath(path)), text);
      const indent = indentFoldRanges(text, settings.editor.tabSize);
      return mergeFoldRanges([...grammar, ...indent]);
    },
    // Код-линзы: подписи-действия у объявлений («3 ссылки», «Запустить тест»). Клик
    // исполняет команду сервера, а его правки (если вернёт) применяем обычным путём.
    codeLenses: (path) => lsp.codeLenses(path),
    lensCommand: (path, command) => void runLensCommand(path, command),
    // Подсказки-вставки: тип переменной, имя параметра — прямо в коде. Серверу нужен
    // диапазон, а своего текста у него нет: конец документа считаем по тексту файла.
    inlayHints: (path, text) => lsp.inlayHints(path, endOfText(text)),
    // Правый клик по тексту: состав пунктов — `core/editor-menu.ts` (чистая функция,
    // покрыта тестом), а показывает приложение: попапы и реестр команд у него.
    contextMenu: (info, event) => {
      const items = editorContextMenuPlan(info, {
        hasAction: (id) => editors.listActions().some((action) => action.id === id),
        runAction: (id) => editors.runAction(id),
        cut: () => editors.cutToClipboard(),
        copy: () => editors.copyToClipboard(),
        paste: () => editors.pasteFromClipboard(),
        spellingAtCursor: () => Boolean(editors.spellingWordAtCursor()),
        addToDictionary: () => editors.addSpellingWordToDictionary(),
        ignoreSpelling: () => editors.ignoreSpellingWord(),
        isBookmarked: (path, line) => bookmarks.isBookmarked(path, line),
        toggleBookmark: (path, line) => bookmarks.toggle(path, line),
        openBookmarks: () => bookmarksModal.open(),
        refactorMenu: (path) => void fixes.runRefactorMenu(path),
        refactor: (path, action) => void fixes.runRefactor(path, action),
        codeActions: (path, position) => void fixes.runCodeActions(path, position),
      });
      showContextMenu(items, event.clientX, event.clientY);
    },
  });
  const edits = new EditService({ documents, editors, rpc });

  /**
   * Исполнить команду сервера (быстрого исправления или клика по линзе): ответ бывает
   * `null`, но бывает и правками (`WorkspaceEdit`) — тогда применяем их тем же путём,
   * что и остальные файловые правки: с undo и общим показом отказа.
   */
  const runLensCommand = async (
    path: string,
    command: { command: string; arguments: readonly unknown[] },
  ): Promise<void> => {
    const answer = await lsp.executeCommand(path, command.command, command.arguments);
    const fileEdits = toWorkspaceFileEdits(answer, uriToPath);
    if (fileEdits) {
      const result = await edits.applyFileEdits(fileEdits);
      if (result.failed.length > 0) showToast(result.failed[0]!.message, 'error');
    }
  };
  // Подпись blame у строки под курсором. Запрос идёт в git за одной строкой;
  // показ по умолчанию выключен и включается командой (см. `git.toggleBlame`).
  const blame = createBlameController({
    blameLine: async (path, line) => {
      const lines = await git.blame(path, { startLine: line, endLine: line }).catch(() => []);
      return lines[0] ?? null;
    },
    blameFile: (path) => git.blame(path).catch(() => []),
    show: (annotation) => editors.setBlame(annotation),
    showAll: (path, annotations) => editors.setBlameAll(path, annotations),
  });
  // Полоски изменений в жёлобе: добавленные, изменённые и удалённые строки файла
  // относительно HEAD. Включены по умолчанию (см. `git.toggleChangeGutter`).
  const changeGutter = createChangeGutterController({
    headText: (path) => git.headText(path),
    currentText: (path) => editors.currentText(path),
    paths: () => editors.visiblePaths(),
    show: (path, changes) => editors.setLineChanges(path, changes),
  });
  /** Файл, для которого полоски посчитаны последними: смена файла — повод пересчитать. */
  let gutterPath: string | null = null;
  // Отладчик: состояние сессии держит контроллер, события идут из main push-ом.
  const debug = new DebugController(rpc);
  // Подсказка под курсором в остановленном файле: значение выражения в кадре. Шов
  // в редактор — потому что контроллер отладки живёт здесь, в приложении, а не в ядре.
  editors.setDebugHover(async (expression, at) => {
    const state = debug.get();
    if (state.phase !== 'stopped') return null;
    // Строка под курсором может принадлежать не верхнему кадру, а тому, кто его
    // вызвал: считаем выражение в том кадре, чьи файл и строка совпали.
    const frame = frameForHover(state.frames, at);
    const result = await debug.hover(expression, frame?.id);
    return result ? { value: result.value, type: result.type } : null;
  });
  /**
   * Значения переменных в строках остановленного файла (`textDocument/inlineValue`):
   * справа от имени появляется `x = 42`. Участки помечает языковой сервер, значения берём
   * у отладчика. Обновляем при останове и шаге, при смене вкладки и правке текста — пока
   * программа стоит, значения могли измениться.
   */
  const refreshDebugInlineValues = async (): Promise<void> => {
    const state = debug.get();
    const path = editors.currentPath;
    // Кадр берём тот, что в текущем файле: значения видны и в вызывающих кадрах стека.
    const frame = state.phase === 'stopped' ? state.frames.find((item) => item.path === path) : undefined;
    const document = path ? documents.get(path) : null;
    if (!frame || !path || !document) {
      editors.setDebugInlineValues(null, []);
      return;
    }
    const text = document.value;
    const lineCount = text.split('\n').length;
    const items = await lsp
      .inlineValues(
        path,
        { start: { line: 1, column: 1 }, end: { line: lineCount, column: 1 } },
        { frameId: frame.id, line: frame.line, column: frame.column },
      )
      .catch(() => []);
    if (items.length === 0) {
      editors.setDebugInlineValues(path, []);
      return;
    }
    const values = await resolveInlineValues(items, text, async (expression) => {
      const result = await debug.evaluate(expression, frame.id);
      return { value: result.value };
    });
    editors.setDebugInlineValues(path, values);
  };
  // Приёмник обратных вызовов из main: правки агента приходят сюда.
  const host = new HostService();
  // Языковые серверы: держим документы синхронными и кладём их пометки в редактор.
  new LspClient(rpc, documents, editors).attach();
  // Импорты с неустановленными библиотеками: своя проверка, не зависящая от LSP.
  const importChecker = new ImportChecker(rpc, documents, editors);
  importChecker.attach();

  // Настройки — модальное окно поверх всего: и шапка, и панель AI открывают одно и то же.
  const settingsModal = createSettingsModal({
    rpc,
    commands,
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
    onCreated: (environment) => {
      // Окружение вне проекта поиск в проекте не видит никогда и основным оно не станет.
      // Назначаем его интерпретатором ЭТОГО проекта — иначе человек создал бы окружение,
      // которым ничего не пользуется.
      const root = workspace.root;
      if (root && !isInsidePath(root, environment.path)) {
        void setProjectInterpreter(environment.python).then(() => reloadPythonEnvironment());
        return;
      }
      reloadPythonEnvironment();
    },
    onPickExisting: () => void pickExistingVenv(),
  });
  document.body.appendChild(venvModal.element);

  /* ── панели ────────────────────────────────────────────────────────────── */

  const explorer = createExplorer({
    workspace,
    rpc,
    commands,
    openEditors,
    git,
    documents,
    // Закрепление — часть рабочего места: сохраняем при изменении (сессия ниже).
    onPinsChange: () => session.scheduleSave(),
    // Избранное — наоборот, свойство IDE, а не проекта: список уходит в настройки.
    onFavoritesChange: () => void saveSettingsPatch({ workspace: { favorites: explorer.favorites() } }),
    // Метки файлов — тоже рабочее место проекта: сохраняем при изменении.
    onLabelsChange: () => session.scheduleSave(),
    // Пакеты монорепо: их список нужен дереву, чтобы показать проекты строками.
    packages,
    // Удалённые папки рабочего места: адреса из настроек, файл смотрит своё окно.
    remoteRoots: () => settings.workspace.remoteRoots,
    removeRemoteRoot: (address) => {
      const next = settings.workspace.remoteRoots.filter((item) => item !== address);
      void saveSettingsPatch({ workspace: { remoteRoots: next } });
    },
    openRemoteFile: (address) => void remoteFileModal.open(address),
    // Просмотр без открытия (пробел в дереве или пункт меню): копия кода «на месте».
    peekFiles: (paths, anchor) => {
      editors.peekFiles(paths, anchor);
    },
    // Пока копия показана, её клавиши (Esc, Enter, стрелки) забирает она сама.
    peekKey: (event) => editors.handlePeekKey(event),
  });
  layout.sidebarBody.appendChild(explorer.element);

  const sourceControl = createSourceControl({
    git,
    workspace,
    commands,
    // Соавторов спрашиваем тем же диалогом, что имя ветки и сообщение коммита.
    askText: (options) => promptValue(options),
    notify: (message, kind) => showToast(message, kind),
    packages,
  });

  /**
   * Менеджер git в поповере: та же панель изменений всплывает у кнопки ветки
   * в статусбаре — вкладки «Изменения» в нижней панели больше нет. Экземпляр один:
   * берём тот же `sourceControl`, а не заводим вторую копию с отдельной подпиской.
   */
  const gitManagerPopover = createLazyPopover({
    create: () => ({ element: sourceControl.element }),
    className: 'popover-git',
    width: 360,
    // Свежее состояние: репозиторий мог измениться вне приложения.
    beforeOpen: () => void git.refresh(),
  });

  function openGitManager(anchor: HTMLElement): void {
    gitManagerPopover.toggle(anchor);
  }

  /**
   * Попап Python-окружения у кнопки в статусбаре: что выбрано и откуда. Создаём
   * лениво, но прогреваем снимок при открытии проекта (см. preloadEnvironment);
   * список обновляем ещё и при каждом открытии — попап мог провисеть долго.
   */
  const pythonEnvPopover = createLazyPopover({
    create: (close) =>
      createPythonEnvPopover({
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
          close();
          // Сервер подсказок поднят со старым интерпретатором — перезапускаем; у
          // выбранного окружения могло найтись и своё (pylsp в его `bin`).
          refreshLsp();
        },
        onCreate: () => {
          close();
          void venvModal.open();
        },
        onPickExisting: () => {
          close();
          void pickExistingVenv();
        },
        onInstallRequirements: () => {
          close();
          void installRequirements();
        },
      }),
    // Ширину не задаём: попап жмётся по содержимому (`.popover-python-env`),
    // а фиксированные 340 px растягивали его на пустом месте.
    className: 'popover-python-env',
    // Снимок обновляем при каждом открытии: попап мог провисеть долго.
    refresh: (view) => void view.refresh(),
  });

  function openPythonEnv(anchor: HTMLElement): void {
    pythonEnvPopover.toggle(anchor);
  }

  /**
   * Попап Node-окружения по клику на чип «Node.js»: чем запускается код, чем
   * ставятся зависимости и всё ли из `package.json` на месте. Снимок греем при
   * открытии проекта (см. preloadEnvironment), а при открытии попапа обновляем.
   */
  const nodeEnvPopover = createLazyPopover({
    create: (close) =>
      createNodeEnvPopover({
        rpc,
        root: () => workspace.root,
        tools: () => tools.get(),
        projectKind: () => projectScan?.kind.label ?? null,
        onInstall: () => {
          close();
          // Ставим все объявленные зависимости: `npm install` без аргументов.
          void installNodePackages([]);
        },
      }),
    // Ширину не задаём: попап жмётся по содержимому (`.popover-node-env`),
    // а фиксированные 340 px растягивали его на пустом месте.
    className: 'popover-node-env',
    refresh: (view) => void view.refresh(),
  });

  function openNodeEnv(anchor: HTMLElement): void {
    nodeEnvPopover.toggle(anchor);
  }

  /**
   * Попап языковых серверов по клику на чип в статусбаре: какой сервер обслуживает
   * язык, откуда он взят и что не поднялось. Так «почему нет подсказок» видно сразу.
   */
  const lspPopover = createLazyPopover({
    create: (close) =>
      createLspPopover({
        rpc,
        onRestart: () => {
          close();
          void commands.execute('lsp.restart');
        },
        onOpenSettings: () => {
          close();
          settingsModal.open('lsp');
        },
      }),
    className: 'popover-lsp-status',
    width: 340,
    align: 'end',
    refresh: (view) => void view.refresh(),
  });

  function openLsp(anchor: HTMLElement): void {
    lspPopover.toggle(anchor);
  }

  /**
   * Окружение проекта читаем при его открытии, а не только по клику на чип: иначе
   * попап открывался бы с пустым телом, пока данные едут. Греем ровно то, что
   * может открыться: чип в статусбаре один — у Node-проекта он про Node, иначе про
   * интерпретатор Python (см. envWidgetLabel). Попап обновляет снимок сам при
   * открытии, поэтому устаревания тут не боимся — прогрев лишь убирает ожидание.
   */
  const preloadPlanner = createPreloadPlanner({
    root: () => workspace.root ?? null,
    kind: () => projectScan?.kind.id ?? null,
    tools: () => tools.get(),
    configuredPython: () => settings.run.pythonPath,
  });

  function preloadEnvironment(): void {
    if (!preloadPlanner.shouldPreload()) return;
    if (preloadPlanner.target() === 'node') nodeEnvPopover.warm();
    else pythonEnvPopover.warm();
  }

  // Сравнение версий грузится по требованию: `OwnDiffEditor` тянет за собой реестр
  // грамматик через `editor-view`, и статический импорт увез бы все 34 языка в первый
  // чанк. Фабрика ставится сразу, модуль приезжает `import()` — к первому открытию
  // экрана различий он уже здесь.
  void import('./editor/host/diff-editor').then((module) => {
    editors.setDiffFactory((container) => new module.OwnDiffEditor(container));
  });

  const diffView = createDiffView({
    createDiff: (container) => editors.createDiff(container),
    git,
    // Тот же вход, что у разрешения конфликтов: несохранённый документ важнее диска.
    readText: async (path) => documents.get(path)?.value ?? (await rpc.request('workspace.readFile', { path })).text,
    reviews,
    notify: (message) => showToast(message, 'error'),
  });
  layout.editorHost.appendChild(diffView.element);

  // Разрешение конфликтов слияния: экран с обеими сторонами и выбором по блокам.
  const conflictView = createConflictView({
    createDiff: (container) => editors.createDiff(container),
    git,
    readText: async (path) => documents.get(path)?.value ?? (await rpc.request('workspace.readFile', { path })).text,
    applyEdits: async (path, list) => {
      // Документ и редактор меняются вместе (см. EditService): правка попадает в undo
      // и в сохранение, а не только в буфер.
      const result = await edits.applyFileEdits([{ path, edits: [...list] }]);
      const failure = result.failed[0];
      if (failure) throw new Error(failure.message);
    },
    finish: async (path) => {
      const document = await edits.ensureDocument(path);
      const outcome = await edits.saveDocument(document);
      if (outcome === 'conflict') throw new Error('Файл изменён на диске — сохраните вручную и отметьте решённым');
      await git.markResolved(path);
    },
    openInEditor: (path) => void openPath(path),
    notify: (message, kind) => showToast(message, kind === 'error' ? 'error' : 'info'),
  });
  layout.editorHost.appendChild(conflictView.element);

  const searchView = createSearchView({
    rpc,
    commands,
    workspace,
    documents,
    // Замена пишет файлы на диске: открытые вкладки перечитываем сразу.
    reloadFile: (path) => reloadIfOpen(path),
  });
  const terminalPanel = createTerminalPanel({
    rpc,
    cwd: () => workspace.root,
    // Лигатуры консоли — те же, что у кода: единый вид обоих полотен.
    ligatures: () => settings.editor.fontLigatures,
    // Ссылка из вывода терминала: локальный адрес — вкладкой в IDE, чужой — системным.
    openLink: (url) => openLinkFromTerminal(url),
  });

  /** Карта проекта: из неё берём тесты и точку входа. Пусто, пока проект не открыт. */
  let projectScan: ProjectScan | null = null;

  /** Вид проекта: от него зависит, чем собирать и запускать тесты (pytest или Node). */
  const isPythonProject = (): boolean => projectScan?.kind.id === 'python';

  /**
   * Плагины pytest, которые не загрузились у окружения проекта (см. сбор в main).
   * Их отключаем и при прогоне: те же ключи, что ушли в сбор, — иначе кнопка ▶
   * упала бы там же, где падал сбор. Пусто — окружение в порядке.
   */
  let pytestDisabledPlugins: string[] = [];

  /** Раннер тестов Node: объявленный в проекте, иначе встроенный `node --test`. */
  const nodeRunner = (): NodeTestRunner | null =>
    detectNodeTestRunner(tools.get().testRunner, projectScan?.testFiles ?? []);

  /**
   * Цель прогона тестов панели: селектор узла, а `null` — все тесты проекта. Раннер
   * выбираем по карте проекта: у Python это pytest, у Node — раннер проекта.
   */
  const testTargetFor = (selector: string | null, options: { report?: boolean } = {}): RunTarget =>
    testTargetOf(tools.get(), nodeRunner(), selector, {
      ...options,
      platform: info.platform,
      disabledPlugins: pytestDisabledPlugins,
    });

  /**
   * Куда прогон с покрытием пишет JSON-отчёт. Путь — во временном каталоге (даёт main):
   * файл нужен IDE, а не человеку, и захламлять корень проекта незачем.
   */
  let coverageJsonPath: string | null = null;

  /**
   * Куда писать отчёт покрытия Node: vitest и jest складывают туда файл
   * `coverage-final.json`. Каталог даёт main — он же выдаёт путь для pytest.
   */
  let nodeCoverageDir: string | null = null;

  /**
   * Уточнить покрытие по JSON-отчёту: терминальный даёт только непокрытые строки, а
   * здесь есть ещё и наполовину пройденные ветви. Нет файла или он битый — молча
   * остаёмся при том, что пришло из вывода pytest.
   */
  const applyCoverageJson = async (absolute: (path: string) => string): Promise<void> => {
    const file = await rpc.request('project.readCoverage', { kind: 'pytest' }).catch(() => null);
    if (!file?.text) return;
    const json = parseCoverageJson(file.text);
    if (json.files.length === 0) return;
    editors.setCoverage(
      json.files.map((entry) => [absolute(entry.path), entry.missingLines, entry.partialLines] as const),
    );
  };

  /**
   * Покрытие Node: отчёт кладёт сам раннер (`coverage-final.json` в общем каталоге
   * отчётов). Пути в нём абсолютные — от раннера, а редактор ключует файлы тем, как
   * их открыл IDE, поэтому внутренние пути приводим к своему написанию, а чужие
   * оставляем как есть. Итог отдаём и панели: там сводка и список файлов.
   */
  const applyNodeCoverage = async (root: string): Promise<void> => {
    const file = await rpc.request('project.readCoverage', { kind: 'node' }).catch(() => null);
    if (!file?.text) return;
    const report = parseNodeCoverage(file.text);
    if (report.files.length === 0) return;

    const separator = separatorOf(root);
    const absolute = (filePath: string): string => joinPath(root, splitPath(filePath).join(separator));
    const entries = report.files.map((entry) => {
      // Отчёт печатает пути с прямыми слэшами; корень на Windows — с обратными.
      const native = entry.path.split(/[/\\]+/).join(separator);
      const inside = isInsidePath(root, native);
      const relative = inside ? pathAfter(root, native) : entry.path;
      return { path: inside ? absolute(relative) : entry.path, relative, file: entry };
    });

    editors.setCoverage(
      entries.map((entry) => [entry.path, entry.file.missingLines, entry.file.partialLines] as const),
    );
    testPanel.setCoverage({
      total: report.total,
      files: entries.map((entry) => ({
        path: entry.relative,
        percent: entry.file.percent,
        statements: entry.file.statements,
        missing: entry.file.missing,
        missingLines: entry.file.missingLines,
        branches: entry.file.branches,
        branchPartial: entry.file.branchPartial,
      })),
    });
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
        // Запоминаем отключённые плагины: те же ключи нужны прогону из панели.
        pytestDisabledPlugins = suite.disabledPlugins ?? [];
        return { runner: 'pytest', ...suite };
      }
      pytestDisabledPlugins = [];
      return rpc.request('node.tests');
    },
    // Панель просит отчёт — команда уносит в терминал и печать кода выхода,
    // по ней панель и красит узлы.
    onRun: (selector, options) => void runTarget(testTargetFor(selector, options)),
    // Покрытие у Python считает pytest-cov, у Node — провайдер проекта (vitest или
    // jest). У встроенного `node --test` отчёт текстовый, без построчной разбивки —
    // там кнопки «С покрытием» нет (см. `canCoverage`).
    onCoverage: (selector) => {
      void (async () => {
        if (!isPythonProject()) {
          const runner = nodeRunner();
          if (runner !== 'vitest' && runner !== 'jest') return;
          const paths = await rpc.request('project.coverageJsonPath').catch(() => null);
          nodeCoverageDir = paths?.dir ?? null;
          void runTarget(
            nodeCoverageTarget(tools.get(), runner, selector, {
              report: true,
              platform: info.platform,
              outputDir: nodeCoverageDir ?? undefined,
            }),
          );
          return;
        }
        coverageJsonPath = await rpc
          .request('project.coverageJsonPath')
          .then((result) => result.path)
          .catch(() => null);
        void runTarget(
          pytestCoverageTarget(tools.get(), selector, {
            report: true,
            platform: info.platform,
            jsonPath: coverageJsonPath ?? undefined,
          }),
        );
      })();
    },
    // Покрытие считает плагин pytest-cov: если он не загрузился, кнопка только
    // обещала бы отчёт, которого не будет (`--cov` без плагина — ошибка запуска).
    // У Node отчёт умеют vitest и jest; встроенный `node --test` — нет.
    canCoverage: () => {
      if (!isPythonProject()) {
        const runner = nodeRunner();
        return runner === 'vitest' || runner === 'jest';
      }
      return !pytestDisabledPlugins.includes('pytest_cov');
    },
    // Отчёт покрытия → подсветка непокрытых строк в редакторе. Отчёт даёт пути от
    // корня проекта; редактор ключует файлы абсолютными — собираем их здесь.
    onCoverageReport: (report) => {
      const root = workspace.root;
      if (!root) return;
      // Node отдаёт готовый отчёт файлом (его читает `applyNodeCoverage`), а из
      // вывода терминала покрытия там нет — не разбираем его как pytest.
      if (!isPythonProject()) {
        void applyNodeCoverage(root);
        return;
      }
      const separator = separatorOf(root);
      const absolute = (filePath: string): string => joinPath(root, splitPath(filePath).join(separator));
      editors.setCoverage(
        report.files
          .filter((file) => file.missingLines.length > 0)
          .map((file) => [absolute(file.path), file.missingLines] as const),
      );
      void applyCoverageJson(absolute);
    },
    // Пересобирать список по правке стоит только когда панель тестов на виду.
    isVisible: () => dock.visible && dock.activeId === 'tests',
  });
  // Исход прогона — в значок теста в жёлобе: панель знает его по селекторам,
  // редактор превращает их в цвет значка у строки объявления теста.
  testPanel.onDidChangeOutcomes(() => editors.setTestOutcomes(testPanel.outcomes()));

  // Структура текущего файла: классы и функции списком, клик — переход к объявлению.
  const outline = createOutline({
    rpc,
    openEditors,
    documents,
    reveal: (path, line, column) => editors.reveal(path, line, column),
    isVisible: () => dock.visible && dock.activeId === 'outline',
  });

  const dock = createDock();
  // Проблемы: ошибки и предупреждения по всем открытым файлам, клик — переход к месту.
  // Панель ничего не знает ни о языковом сервере, ни о проверке импортов: берёт готовые
  // пометки у рабочего места и группирует их (правила — `shared/problem-list.ts`).
  const problemPanel = createProblemPanel({
    markers: () => editors.markers(),
    // Из панели файла может и не быть на экране — открываем его тем же путём, что и всё.
    reveal: (path, line, column) => void openPath(path).then(() => editors.reveal(path, line, column)),
    label: (path) => workspace.relative(path),
  });
  // Задачи: пометки берём обычным поиском по проекту — тем же путём, что панель поиска
  // и инструмент агента. Свой обход файлов панели не нужен, а разбор находок и
  // группировку отдаёт `shared/todo-list.ts`.
  const todoPanel = createTodoPanel({
    scan: async () => {
      const result = await rpc.request('workspace.search', {
        query: TODO_QUERY,
        isRegex: true,
        caseSensitive: false,
        maxResults: 500,
      });
      return toTodoItems(result.hits);
    },
    reveal: (path, line, column) => void openPath(path).then(() => editors.reveal(path, line, column)),
    label: (path) => workspace.relative(path),
    hasWorkspace: () => workspace.root !== null,
  });
  // Предпросмотр Markdown — режим вкладки файла .md, а не панель: разметку показываем
  // оверлеем в области редактора (как вьюер картинок и встроенный браузер), а
  // переключает режим кнопка в самой вкладке. Рисует разметку тот же разборщик, что
  // ленту чата, — безопасно (без `innerHTML`) и с той же подсветкой кода.
  // Какие файлы в режиме просмотра — помним набором путей: переключение вкладок режим не сбрасывает.
  const markdownPreviews = new Set<string>();
  /** Разметка сейчас показана — чтобы не перечитывать файл на каждом пересчёте. */
  let markdownPreviewShown = false;
  const markdownPreview = createMarkdownPreview({
    openEditors,
    documents,
    insertCode: (code) => editors.insertAtCursor(code),
    relativePath: (path) => workspace.relative(path),
    isVisible: () => previewingMarkdownPath() !== null,
    onEdit: () => setMarkdownPreview(false),
  });
  layout.editorHost.appendChild(markdownPreview.element);

  // Ячейки ноутбука: `.ipynb` показан ячейками (markdown отрисован, код — блоком),
  // а «Сравнить с HEAD» сопоставляет их с версией из git по ячейкам, не по строкам JSON.
  const notebookPanel = createNotebookPanel({
    activePath: () => editors.currentPath,
    readText: (path) => documents.get(path)?.value ?? null,
    readHead: (path) => git.headText(path),
    relativePath: (path) => workspace.relative(path),
    isVisible: () => dock.activeId === 'notebooks',
  });

  // Порядок вкладок задаёт порядок регистрации, поэтому он здесь явный: первыми идут
  // те, что открывают чаще всего, — терминал и поиск, — дальше остальные.
  dock.register({
    id: 'terminal',
    title: 'Терминал',
    element: terminalPanel.element,
    onShow: () => void terminalPanel.open(),
  });
  dock.register({ id: 'search', title: 'Поиск', element: searchView.element, onShow: () => searchView.focus() });
  dock.register({
    id: 'notebooks',
    title: 'Ячейки',
    element: notebookPanel.element,
    onShow: () => notebookPanel.refresh(),
  });
  dock.register({ id: 'tests', title: 'Тесты', element: testPanel.element, onShow: () => void testPanel.refresh() });
  // Структуру собираем при показе вкладки: файл мог смениться, пока панель была скрыта.
  dock.register({ id: 'outline', title: 'Структура', element: outline.element, onShow: () => outline.refresh() });
  // Список собираем при показе вкладки и по изменению пометок (ниже). Значок на вкладке —
  // те же числа, что в статус-баре: ошибки, а без ошибок — предупреждения.
  dock.register({
    id: 'problems',
    title: 'Проблемы',
    element: problemPanel.element,
    badge: () => problemBadgeText(problemPanel.counts()),
    onShow: () => problemPanel.refresh(),
  });
  // Задачи: пометки TODO/FIXME/HACK/XXX по проекту. Список собирает поиск по проекту
  // с готовым запросом, а разбор находок и группировку панели отдаёт `shared/todo-list.ts`.
  dock.register({
    id: 'todo',
    title: 'Задачи',
    element: todoPanel.element,
    badge: () => todoPanel.badge(),
    onShow: () => todoPanel.refresh(),
  });
  layout.dockHost.appendChild(dock.element);

  /* ── чат ───────────────────────────────────────────────────────────────── */

  // Вьюер картинок: та же область, но показывает изображение вместо текста.
  // Когда он виден — решает `syncImage` по активной вкладке.
  const imageView = createImageView({ rpc, notify: (message) => showToast(message, 'error') });
  layout.editorHost.appendChild(imageView.element);

  // Предпросмотр документа Office (.docx/.xlsx): та же область, что у вьюера картинок.
  // Когда он виден — решает `syncDoc` по активной вкладке.
  const docView = createDocView({ rpc, notify: (message) => showToast(message, 'error') });
  layout.editorHost.appendChild(docView.element);

  // Вкладки встроенного браузера: страницы живут в той же полосе, что файлы, а
  // рисует их вложение окна (WebContentsView) — место ему считает renderer.
  const browserTabs = new BrowserTabs();
  // Чат создаётся ниже, а браузеру он нужен уже сейчас: «добавить в чат» шлёт туда
  // снимок страницы и её консоль. Держим ленивую ссылку — к моменту нажатия кнопки
  // чат уже создан.
  let chatForBrowser: ChatView | null = null;
  const browserView = createBrowserView({
    rpc,
    openExternal: (url) => void rpc.request('shell.openExternal', { url }).catch(() => undefined),
    notify: (message) => showToast(message, 'error'),
    attachImage: (image) => chatForBrowser?.attachImage(image),
    attachContext: (item) => chatForBrowser?.attachContext(item),
  });
  layout.editorHost.appendChild(browserView.element);

  /**
   * Страница, на которой прямо сейчас действует ассистент. Метка живёт несколько
   * секунд после последнего действия: агент шлёт событие на каждый шаг, а между
   * шагами думает — мигать на каждом вызове было бы хуже, чем короткая задержка.
   */
  let agentPageId: string | null = null;
  let agentPageTimer = 0;
  /** Сколько живёт метка на вкладке после последнего действия. */
  const AGENT_TAB_NOTICE_MS = 3000;

  /** Агент что-то сделал на странице: сказать об этом человеку — в шапке и на вкладке. */
  function markAgentPage(id: string, action: string): void {
    // Шапка относится к активной вкладке — она решает сама, показывать ли метку.
    browserView.setAgentAction(id, action);
    if (agentPageTimer) clearTimeout(agentPageTimer);
    // Полоса перерисовывается только на смену страницы: та же вкладка уже помечена.
    if (agentPageId !== id) {
      agentPageId = id;
      tabs.refresh();
    }
    agentPageTimer = window.setTimeout(() => {
      agentPageTimer = 0;
      if (agentPageId === null) return;
      agentPageId = null;
      tabs.refresh();
    }, AGENT_TAB_NOTICE_MS);
  }

  /**
   * Полоса вкладок закрывает страницу так же, как файл, — но вложение само из дерева
   * не уходит: за это отвечает `browserView.forget`. Поэтому закрытие вкладки проходит
   * через него, а не зовёт модель напрямую — иначе гость остался бы жить процессом.
   */
  const browserPages: PagesTabSource = {
    get list() {
      return browserTabs.list;
    },
    get activePageId() {
      return browserTabs.activePageId;
    },
    get agentPageId() {
      return agentPageId;
    },
    activate: (id) => browserTabs.activate(id),
    close: (id) => {
      browserView.forget(id);
      browserTabs.close(id);
    },
    onDidChange: (listener) => {
      browserTabs.onDidChange(listener);
    },
  };

  /** Ассистент выключен мастер-тумблером в настройках: все входы в него должны молчать. */
  const aiEnabled = (): boolean => settings.ai.enabled;

  /** Куда зовём, если AI выключен: подсказка вместо тихого «ничего не произошло». */
  const warnAiDisabled = (): void => {
    showToast('AI выключен в настройках. Включить: Настройки → AI.', 'error');
  };

  /**
   * Что показать в области редактора — решает `core/editor-surface.ts`.
   *
   * Раньше каждый `sync*` знал про чужие экраны и гасил их сам; добавление
   * седьмого экрана требовало правки всех. Теперь решение одно, а здесь только
   * исполнение: экраны вне `shown` гасим, `shown` включаем. Классы у области те же,
   * и снимаются они всегда — даже у того экрана, что уже погашен (иначе при смене
   * вкладки оставался бы чужой класс и полотно пряталось бы зря).
   */
  function applySurfaces(): void {
    const activePath = openEditors.active?.path ?? null;
    const plan = editorSurfacePlan({
      activePageId: browserTabs.activePageId,
      activePath,
      isImage: activePath !== null && isImagePath(activePath),
      isOffice: activePath !== null && isOfficePath(activePath),
      markdownPreview: activePath !== null && markdownPreviews.has(activePath),
    });
    const island = layout.editorIsland;
    island.classList.toggle('is-browser', plan.shown === 'page');
    island.classList.toggle('is-image', plan.shown === 'image');
    island.classList.toggle('is-doc', plan.shown === 'doc');
    island.classList.toggle('is-markdown', plan.shown === 'markdown');
    if (plan.shown !== 'page') browserView.hide();
    if (plan.shown !== 'image') imageView.hide();
    if (plan.shown !== 'doc') docView.hide();
    if (plan.shown !== 'markdown') {
      markdownPreview.hide();
      markdownPreviewShown = false;
    }
    switch (plan.shown) {
      case 'page': {
        const page = browserTabs.active;
        // Вложение приезжает из main готовым слоем: показываем, только если его нет.
        // Иначе каждый чих вкладки (смена заголовка, загрузка) дёргал бы main зря.
        if (page && (browserView.pageId !== page.id || !browserView.isOpen)) browserView.show(page);
        break;
      }
      case 'image':
        // Только при смене файла: перезапись сбрасывала бы прокрутку и мигала на каждом
        // чихе вкладок.
        if (activePath !== null && imageView.path !== activePath) imageView.show(activePath);
        break;
      case 'doc':
        if (activePath !== null) docView.show(activePath);
        break;
      case 'markdown':
        // `show()` всегда перечитывает файл и поднимает прокрутку вверх — зовём, только
        // когда разметку действительно надо обновить (после правки или переключения
        // вкладки). Остальные поводы (страница, режим) ей ни к чему.
        if (!markdownPreviewShown) markdownPreview.show();
        markdownPreviewShown = true;
        break;
      default:
        // Текст — экранам делать нечего, они уже погашены выше.
        break;
    }
    // Подсветка кнопок в шапке идёт за экраном: по ней видно, открыт ли браузер.
    syncViewButtons();
    tabs.refresh();
  }

  /** Часы правок файла и разметки: что показывать — решает `applySurfaces`. */
  function previewingMarkdownPath(): string | null {
    const path = openEditors.active?.path ?? null;
    return path !== null && markdownPreviews.has(path) ? path : null;
  }

  /** Включить/выключить просмотр разметки (по умолчанию — у активного файла). */
  function setMarkdownPreview(on: boolean, path: string | null = openEditors.active?.path ?? null): void {
    if (path === null || !isMarkdownPath(path)) return;
    if (on) markdownPreviews.add(path);
    else markdownPreviews.delete(path);
    applySurfaces();
    tabs.refresh();
  }

  /** Переключить режим файла (.md): текст ↔ разметка. */
  function toggleMarkdownPreview(path: string): void {
    setMarkdownPreview(!markdownPreviews.has(path), path);
  }

  // Страница навигировалась, открылась или закрылась — полотно идёт за ней,
  // а разметка уступает место, если страница заняла область.
  browserTabs.onDidChange(() => {
    // Страница заняла или освободила область: полотно, картинка и разметка делят
    // её с ней, поэтому пересчитываем область целиком, а не только браузер.
    applySurfaces();
  });

  /** Показать чат в правой панели — единственном его месте. */
  function revealChat(): void {
    if (!aiEnabled()) {
      warnAiDisabled();
      return;
    }
    layout.setRightVisible(true);
    syncViewButtons();
  }

  /** Кнопка AI: свернуть/развернуть правую панель с чатом. */
  function toggleChat(): void {
    if (!aiEnabled()) {
      warnAiDisabled();
      return;
    }
    // Скрытый редактор — окно без единого файла, и ассистент в нём остаётся
    // единственным содержимым. Свернуть и его значит остаться с пустым полотном.
    // Инвариант держит сам `layout` (см. `applyPanelIntent`); здесь — чтобы сказать
    // вслух, почему кнопка не отозвалась.
    if (layout.rightVisible && !layout.editorVisible) {
      showToast('Редактор скрыт: ассистент — единственное, что есть в окне. Верните редактор (Ctrl+Alt+E)');
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
    // Открытие файла — тем же путём, что у дерева и быстрого открытия: клик по
    // файлу в ленте чата открывает вкладку, а не только ставит курсор.
    openFile: (path) => openPath(path),
  });
  layout.rightBody.appendChild(chat.element);
  // Чат готов — браузер теперь может слать ему снимок страницы и её консоль.
  chatForBrowser = chat;
  // Статус ассистента (режим и заполнение контекста) живёт в общей полосе окна:
  // композер отдаёт готовую строку, статус-бар принимает её в свой слот.
  statusBar.chatSlot.appendChild(chat.statusElement);

  const tabs = createTabs({
    openEditors,
    documents,
    commands,
    // Вкладки браузера стоят в этой же полосе — страница закрывается так же, как файл.
    pages: browserPages,
    // Файлы .md получают в вкладке кнопку «текст ↔ разметка».
    preview: {
      applies: (path) => isMarkdownPath(path),
      active: (path) => markdownPreviews.has(path),
      toggle: (path) => toggleMarkdownPreview(path),
    },
  });
  layout.tabsHost.appendChild(tabs.element);

  // Путь к файлу живёт в строке состояния: крошки рисуют его сегментами и
  // заменяют прежнюю ссылку на файл — одно дублировало другое.
  const breadcrumbs = createBreadcrumbs({ openEditors, documents, workspace, commands });
  statusBar.fileSlot.appendChild(breadcrumbs);

  const runControl = createRunButton((target) => void runTarget(target));
  // Имя открытого файла в центре шапки: показывается, когда кнопки запуска нет.
  const topBarName = h('span', { class: 'topbar-name' });

  /* ── запуск ────────────────────────────────────────────────────────────── */

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
   * Языковые серверы: поиск недостающих, перезапуск, прогрев.
   *
   * Вся эта логика не знает ни DOM, ни редактора — она ушла в
   * `core/lsp-servers.ts`, где проверяется тестом. Здесь передаются только связи:
   * откуда взять свежие настройки, что показать человеку, куда ведёт кнопка.
   */
  const lspServers = createLspServers({
    rpc,
    // Тумблер и список читаем СВЕЖИМИ функциями, а не значениями: настройки
    // приходят push-событием позже ответа `settings.update`.
    settings: () => ({ lsp: settings.lsp }),
    root: () => workspace.root,
    scan: () => projectScan,
    documents: () => documents.all(),
    // Уведомление с кнопкой — форма `showToast`, но кнопка называется иначе.
    toast: (message, kind, action) =>
      action
        ? showToast(message, kind, { action: { label: action.label, run: action.run } })
        : showToast(message, kind),
    openLspSettings: () => {
      // Окно настроек на разделе «Языки»: оттуда ставят сервер, которого нет.
      settingsModal.open('lsp');
    },
    onStatus: (status) => applyLspStatus(status),
    onPrewarmed: () => refreshSymbolIndex(),
    onRestarted: () => {
      // Перезапуск снял серверы: чип обновился сразу ответом, а «не поднялось» надо
      // переспросить, когда документы доедут до main.
      window.setTimeout(() => void refreshLspStatus(), 1500);
    },
  });
  const refreshLsp = (): void => void lspServers.refresh();

  /**
   * Карта символов: сколько уже разобрано.
   *
   * Собирается она в main в фоне, а здесь виден только итог опроса. Пока идёт сборка
   * (`warming`), спрашиваем раз в секунду и показываем «Символы: N…» в полосе состояния:
   * поиск по структуре в это время работает, но неполно, и человек должен это видеть.
   * Как только карта готова — опрос прекращается, виджет гаснет.
   */
  const symbolPoller = createSymbolPoller({
    request: async () => (await rpc.request('index.status')) as SymbolIndexStatus,
    show: (status) => statusBar.update({ symbols: symbolIndexChip(status as SymbolIndexStatus) }),
    intervalMs: 1000,
  });

  function refreshSymbolIndex(): void {
    symbolPoller.poll();
  }

  /** Окружение изменилось: перечитать инструменты, карту проекта, подсказки и импорты. */
  function reloadPythonEnvironment(): void {
    void tools.refresh(workspace.root, true).then(() => {
      syncRunControl();
      refreshStatus();
    });
    void refreshScan();
    refreshLsp();
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
    return collectRunTargets(runnableFileOf(document), tools.get(), projectScan, nodeRunner(), pytestDisabledPlugins);
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

    // Запускать нечего — кнопка прячется, но центр шапки не пустует: там имя файла.
    topBarName.hidden = !runControl.element.hidden;

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
   * Значки запуска отдельных тестов в жёлобе. Тестовый ли файл и какие в нём тесты —
   * решает `core/test-markers.ts`; здесь — только сравнение подписи и вызов редактора.
   * Подпись несёт версию документа: без неё правка, добавляющая тест, не переставила бы значок.
   */
  function syncTestMarkers(document: TextDocument): void {
    const signature = testMarkerSignatureOf(document.path, document.version);
    if (signature === testMarkerSignature) return;
    testMarkerSignature = signature;
    editors.setTestMarkers(
      document.path,
      testMarkersFor(
        { relative: workspace.relative(document.path), absolute: document.path, languageId: document.languageId },
        document.value,
      ),
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
    viewButtons.get('editorToggle')?.classList.toggle('is-active', layout.editorVisible);
    viewButtons.get('search')?.classList.toggle('is-active', layout.dockVisible && dock.activeId === 'search');
    // Кнопка нижней панели помнит состояние самого острова, а не одной вкладки:
    // она его распахивает и захлопывает целиком.
    viewButtons.get('dock')?.classList.toggle('is-active', layout.dockVisible);
    viewButtons.get('split')?.classList.toggle('is-active', editors.isSplit);
    // Кнопка браузера помнит, показана ли страница сейчас: тем же значком её и
    // открывают повторно — как кнопки панелей.
    viewButtons.get('browser')?.classList.toggle('is-active', browserView.isOpen);
    // Выключенный AI прячем из шапки: неактивная кнопка всё равно звала бы в чат.
    const aiButton = viewButtons.get('ai');
    if (aiButton) {
      aiButton.hidden = !aiEnabled();
      aiButton.classList.toggle('is-active', aiEnabled() && layout.rightVisible);
    }
  };

  /**
   * Подстроить панели под ширину окна. Решение принимает `AutoPanelLayout` и только
   * на переходе между полосами ширины. Свёрнутость от размера — не выбор человека,
   * поэтому в настройки её не пишем (`withoutPersist`) и подсветку кнопок обновляем.
   */
  const syncAdaptivePanels = (): void => {
    const change = panelAuto.update(window.innerWidth, {
      sidebar: layout.sidebarVisible,
      right: layout.rightVisible,
    });
    if (!change) return;
    withoutPersist(() => {
      layout.setSidebarVisible(change.sidebar);
      layout.setRightVisible(change.right);
    });
    syncViewButtons();
  };
  window.addEventListener('resize', syncAdaptivePanels);
  syncAdaptivePanels();

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
  // Слева — действия над содержимым: сохранить, поиск, страница рядом с кодом.
  addTopButton(layout.topBarLeft, 'save', 'save', 'Сохранить всё (Ctrl+Alt+S)', 'file.saveAll');
  addTopButton(layout.topBarLeft, 'search', 'search', 'Поиск по проекту (Ctrl+Shift+F)', 'search.project');
  // Встроенный браузер: страница вкладкой рядом с кодом. Своим разделителем — это
  // не раскладка окна, а ещё один способ открыть содержимое рядом с редактором.
  layout.topBarLeft.appendChild(h('span', { class: 'topbar-sep' }));
  addTopButton(layout.topBarLeft, 'browser', 'globe', 'Открыть страницу (Ctrl+Shift+B)', 'browser.open');

  // Центр шапки отдан главному: кнопке запуска, а когда запускать нечего — имени
  // открытого файла (см. syncRunControl). Одно сменяет другое, пустоты не бывает.
  layout.topBarTitle.append(topBarName, runControl.element);

  // Переключатели раскладки — справа, у кнопок окна: они меняют вид окна, а не
  // содержимое, и в ряду действий над файлами им не место.
  // Переключатель боковой панели: он про то же — что открыто слева.
  addTopButton(layout.topBarRight, 'project', 'panel', 'Боковая панель (Ctrl+B)', 'view.toggleSidebar');
  // Панель редактора: тот же смысл — что открыто в центре. Прячется целиком, отдавая
  // место соседям; правка файлов при этом не теряется, вкладки никуда не деваются.
  addTopButton(layout.topBarRight, 'editorToggle', 'panelCenter', 'Панель редактора (Ctrl+Alt+E)', 'view.toggleEditor');
  // Нижний остров (терминал, поиск, задачи): кнопка целиком включает и выключает его,
  // а значок — та же рамка с полосой, что у боковой панели, только полоса снизу.
  addTopButton(layout.topBarRight, 'dock', 'panelBottom', 'Нижняя панель (Alt+F12)', 'view.toggleDock');
  // Разделение области редактора: два файла рядом. Кнопка помнит состояние.
  addTopButton(layout.topBarRight, 'split', 'split', 'Разделить редактор (Ctrl+\\)', 'view.splitEditor');
  // Служебное — за разделителем. Палитры команд и настроек в шапке больше нет:
  // палитра живёт на Ctrl+Shift+P и в меню «Вид», настройки — в меню «Файл».
  layout.topBarRight.appendChild(h('span', { class: 'topbar-sep' }));
  // Палитра живёт на Ctrl+Shift+P и в меню «Вид»: кнопку в шапке человек попросил
  // убрать с глаз. Из разметки она не удалена — скрыта: на неё опираются живые
  // пробы (palette-probe и соседние), а места в полосе `hidden` не занимает.
  addTopButton(layout.topBarRight, 'palette', 'command', 'Палитра команд (Ctrl+Shift+P)', 'palette.open');
  const paletteButton = viewButtons.get('palette');
  if (paletteButton) paletteButton.hidden = true;
  // Ассистент носит знак приложения, а не звезду-искру: тот же знак, что
  // в пустом состоянии редактора, — кнопка и экран говорят одно и то же.
  // Кнопка AI в шапке бьёт в `ai.toggle`, а не в собственную команду: прежняя
  // `view.toggleRight` звала `toggleChat()` мимо проверки `aiEnabled()` и открывала
  // панель при выключенном AI — та же ошибка, что чинил `ai.toggle` (см. ниже).
  addTopButton(layout.topBarRight, 'ai', 'sparkle', 'AI Assistant (Ctrl+Shift+A)', 'ai.toggle', logoMark(13));

  // Своя рамка создаётся последней: кнопки окна должны стоять с краю шапки,
  // а не перед кнопками действий.
  const windowFrame = new WindowFrame(rpc, layout.topBarRight, layout.topBar);

  /* ── вспомогательные действия ──────────────────────────────────────────── */

  /**
   * Показать PDF вкладкой-страницей. Адрес `file:` строим здесь, потому что вкладку
   * заводит renderer, а право на такой адрес проверит main (рабочая папка): он же
   * откажет, если файл вне проекта или больше предела просмотрщика.
   */
  const openPdfTab = (path: string): void => {
    browserTabs.open(fileUrlFor(path), pdfTabTitle(path));
    explorer.reveal(path);
  };

  const openPath = async (path: string, options: { preview?: boolean } = {}): Promise<void> => {
    // PDF — тоже не текст, и показывать его умеет сам движок: вкладка-страница со
    // встроенным просмотрщиком (см. `shared/pdf.ts`). Документ ему не нужен:
    // открывать в редакторе нечего, а вкладку ведёт `BrowserTabs`.
    if (isPdfPath(path)) {
      openPdfTab(path);
      return;
    }
    // Документ Office — не текст, а zip с XML: в буфере редактора оказался бы бинарь.
    // Заглушка нужна вкладке, дереву и статусбару, а содержимое рисует свой экран.
    if (isOfficePath(path)) {
      const document = edits.binaryDocument(path);
      openEditors.open(document, options);
      explorer.reveal(path);
      return;
    }
    // Картинка — не текст: бинарь открывать редактором нельзя. Заводим документ-заглушку
    // (он нужен вкладке, дереву и статусбару), а полотно покажет вьюер (см. `syncImage`).
    if (isImagePath(path)) {
      // Документ-заглушка: текста в нём нет и быть не должно (см. `binaryDocument`).
      const document = edits.binaryDocument(path);
      openEditors.open(document, options);
      explorer.reveal(path);
      return;
    }
    const document = await edits.ensureDocument(path);
    openEditors.open(document, options);
    editors.open(document);
    explorer.reveal(path);
  };

  /**
   * Применить операции с файлами из `WorkspaceEdit` сервера (создать, переименовать,
   * удалить) — по порядку. Возвращает текст ошибки или null. «Пропустить молча» уважаем:
   * сервер этим говорит, что отсутствие файла/существование цели — не беда.
   * Что считается ошибкой и как она звучит для человека — решает `core/file-operations.ts`.
   */
  const applyFileOperations = async (operations: readonly FileOperation[]): Promise<string | null> => {
    for (const operation of operations) {
      try {
        if (operation.kind === 'create') {
          await rpc.request('workspace.createFile', { path: operation.path });
        } else if (operation.kind === 'rename') {
          await rpc.request('workspace.rename', { from: operation.from, to: operation.to });
        } else {
          await rpc.request('workspace.trash', { path: operation.path });
        }
      } catch (error) {
        // «Пропустить молча» решает модуль: только свой флаг прощает свою ошибку.
        const outcome = outcomeOfFailure(operation, error);
        if (outcome.kind === 'skipped') continue;
        return outcome.error;
      }
    }
    return null;
  };

  const openDocumentLink = async (target: string, fromPath: string): Promise<void> => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      if (target.startsWith('file:')) {
        await openPath(uriToPath(target));
        return;
      }
      await rpc.request('shell.openExternal', { url: target }).catch(() => undefined);
      return;
    }
    // Внешней схемы нет — считаем путём относительно файла.
    const base = fromPath.slice(0, Math.max(fromPath.lastIndexOf('/'), fromPath.lastIndexOf('\\')));
    await openPath(`${base}/${target}`);
  };

  // Быстрый открыватель файлов (Ctrl+Shift+O): отдельный вход, тот же `openPath`,
  // что у дерева и вкладок, поэтому открытие ведёт себя одинаково.
  const quickOpen = createQuickOpen({ rpc, workspace, openFile: (path) => openPath(path) });
  document.body.appendChild(quickOpen.element);

  // Диалог ввода: условие точки останова. Один на приложение — открывается по месту.
  const conditionInput = createPromptModal();
  document.body.appendChild(conditionInput.element);

  // Отложенные изменения (stash): своё окно — открывается из панели изменений.
  const stashModal = createStashModal({
    git,
    confirm: async (options) => {
      const { confirmed } = await rpc.request('dialog.confirm', options);
      return confirmed;
    },
    notify: (message) => showToast(message, 'error'),
  });
  document.body.appendChild(stashModal.element);

  // Окно с текстом от git: сюда показываем граф веток.
  const textModal = createTextModal();
  document.body.appendChild(textModal.element);

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

  // Интерактивный rebase: список шагов собирает окно, а `reword` просит новое
  // сообщение тем же диалогом строки, что и прочие вводы в приложении.
  const rebaseModal = createRebaseModal({
    git,
    askMessage: (subject) => promptValue({ title: 'Новое сообщение коммита', label: 'Сообщение', value: subject }),
    notify: (message, kind) => showToast(message, kind),
  });
  document.body.appendChild(rebaseModal.element);

  // Сравнение веток: своё окно со списком различий. Клик по файлу открывает его
  // в экране сравнения (слева первая ссылка, справа вторая) — режим просмотра.
  const refDiffModal = createRefDiffModal({
    git,
    openFile: (base, head, path) => void diffView.openRefs(base, head, path),
    notify: (message, kind) => showToast(message, kind),
  });
  document.body.appendChild(refDiffModal.element);

  // Сравнение двух папок: список различающихся файлов, клик — их сравнение.
  const folderCompareModal = createFolderCompareModal({
    rpc,
    openFile: (left, right) => void diffView.openFiles(left, right),
    notify: (message, kind) => showToast(message, kind),
  });
  document.body.appendChild(folderCompareModal.element);

  // Поиск багованного коммита: окно ведёт диалог с git (хороший/плохой), а найденный
  // коммит открывается тем же экраном сравнения, что и коммит строки под курсором.
  const bisectModal = createBisectModal({
    git,
    openCommit: (commit) => {
      const path = editors.currentPath;
      if (path) void diffView.open(path, false, commit);
    },
    notify: (message, kind) => showToast(message, kind),
  });
  document.body.appendChild(bisectModal.element);

  // Рабочие каталоги (worktree): список, открытие каталога как проекта, добавление
  // и удаление. Проект открываем тем же путём, что папку из стартового окна.
  const worktreeModal = createWorktreeModal({
    git,
    currentRoot: () => workspace.root,
    openProject: async (path) => {
      await workspace.open(path);
      showToast(`Открыт рабочий каталог ${basename(path)}`);
    },
    confirm: async (options) => (await rpc.request('dialog.confirm', options)).confirmed,
    notify: (message, kind) => showToast(message, kind),
  });
  document.body.appendChild(worktreeModal.element);

  // Git LFS: большие файлы в отдельном хранилище. Окно показывает шаблоны и файлы,
  // даёт взять шаблон под LFS, отказаться от него и подтянуть содержимое.
  const lfsModal = createLfsModal({
    git,
    notify: (message, kind) => showToast(message, kind),
  });
  document.body.appendChild(lfsModal.element);

  // Разреженный рабочий каталог: какие папки выложены на диск. Рядом с LFS — обе про
  // то, что происходит с репозиторием в большом проекте.
  const sparseModal = createSparseModal({
    git,
    notify: (message, kind) => showToast(message, kind),
  });
  document.body.appendChild(sparseModal.element);

  // Локальная история файла: снимки содержимого, снятые при сохранении. Возврат идёт
  // тем же путём, что и любая правка документа: текст кладётся в документ и файл
  // сохраняется — так возврат попадает в undo и сам становится снимком.
  const historyModal = createHistoryModal({
    rpc,
    restore: async (path, text) => {
      const document = await edits.ensureDocument(path);
      document.setText(text, 'programmatic');
      await edits.saveDocument(document, { force: true });
    },
    // Вторая половина ленты — коммиты git того же файла. Нет репозитория — лента
    // останется со снимками: `git.log` для файла вне git вернёт пусто, а не сбой.
    gitHistory: (path) => git.log(path, 50),
    // Действие для записи из git: различие с текущим текстом — на экране сравнения.
    openCommitDiff: (target, hash) => void diffView.open(target, false, hash),
    notify: (message, kind) => showToast(message, kind),
  });
  document.body.appendChild(historyModal.element);

  // Личность автора и подпись коммитов: настройки самого git, но правятся из IDE —
  // в ЛОКАЛЬНОМ конфиге репозитория (глобальные настройки человека не трогаем).
  const identityModal = createIdentityModal({
    git,
    notify: (message, kind) => showToast(message, kind),
  });
  document.body.appendChild(identityModal.element);

  /**
   * Журнал прогонов: строки, которые main уже записал в файл. Трасса под ответом
   * живёт до перезапуска, а журнал — в файле: его и смотрят, когда разбираются
   * с прошлым днём.
   */
  const telemetryModal = createTelemetryModal({
    rpc,
    notify: (message, kind) => showToast(message, kind),
    // Файл лежит в пользовательских данных, вне проекта: открывает проводник системы.
    reveal: (path) => void rpc.request('shell.revealInOS', { path }).catch(() => undefined),
  });
  document.body.appendChild(telemetryModal.element);

  // Запросы на слияние (PR/MR): своя обёртка над клиентами `gh`/`glab`. Токены и вход
  // берёт клиент, IDE показывает список и зовёт его же на «создать» и «забрать ветку».
  const forgeModal = createForgeModal({
    git,
    currentBranch: () => git.branch,
    notify: (message, kind) => showToast(message, kind),
    confirm: async (options) => (await rpc.request('dialog.confirm', options)).confirmed,
  });
  document.body.appendChild(forgeModal.element);

  // Задачи площадки (issues): тот же приём, что у запросов на слияние — всё делает
  // клиент `gh`/`glab`, а окно показывает список и зовёт его же на «создать» и «закрыть».
  const issuesModal = createIssuesModal({
    git,
    notify: (message, kind) => showToast(message, kind),
    confirm: async (options) => (await rpc.request('dialog.confirm', options)).confirmed,
  });
  document.body.appendChild(issuesModal.element);

  // Прогоны CI (Actions/Pipelines): список последних прогонов и перезапуск проваленного.
  const pipelinesModal = createPipelinesModal({
    git,
    notify: (message, kind) => showToast(message, kind),
    confirm: async (options) => (await rpc.request('dialog.confirm', options)).confirmed,
  });
  document.body.appendChild(pipelinesModal.element);

  // Уведомления площадки: непрочитанные ветки (GitHub) или незакрытые дела (GitLab).
  const notificationsModal = createNotificationsModal({
    git,
    notify: (message, kind) => showToast(message, kind),
  });
  document.body.appendChild(notificationsModal.element);

  // Поиск символа по проекту (Ctrl+T): файл открываем тем же путём, что и дерево,
  // а затем встаём на строку объявления.
  const symbolPicker = createSymbolPicker({
    rpc,
    openSymbol: (symbol) => {
      void openPath(symbol.path).then(() => editors.reveal(symbol.path, symbol.line, symbol.column));
    },
  });
  document.body.appendChild(symbolPicker.element);

  // Поиск по смыслу: запрос словами, а не точной строкой. Источники те же, что у
  // поиска агента — имена символов и текстовые строки, — но список собирается тут,
  // в редакторе. Открываем результат тем же путём, что и переход к символу.
  const meaningSearch = createMeaningSearch({
    rpc,
    relative: (path) => workspace.relative(path),
    openHit: (hit) => {
      void openPath(hit.path).then(() => editors.reveal(hit.path, hit.line, hit.column));
    },
  });
  document.body.appendChild(meaningSearch.element);

  // Панель отладки в нижнем доке: управление сессией, стек и переменные.
  const debugPanel = createDebugPanel({
    debug,
    onRevealFrame: (frame) => {
      if (!frame.path) return;
      void openPath(frame.path).then(() => editors.revealDebugFrame(frame.path!, frame.line, frame.column));
    },
    // Наблюдение изменилось — рабочее место стоит сохранить (см. сессию ниже).
    onWatchChange: () => session.scheduleSave(),
    // Останов по исключению изменили — тоже часть рабочего места.
    onExceptionChange: () => session.scheduleSave(),
    // Правка значения переменной: панель просит строку, ввод показывает app.
    promptValue,
  });
  dock.register({ id: 'debug', title: 'Отладка', element: debugPanel.element, onShow: () => debugPanel.refresh() });

  /* ── сессия рабочей папки ──────────────────────────────────────────────── */

  // Рабочее место проекта вынесено в отдельный контроллер: здесь только сборка
  // его зависимостей — восстановить место при открытии проекта и сохранить при изменении.
  const session = createSessionControl({
    rpc,
    documents,
    openEditors,
    editors,
    debug,
    explorer,
    workspace,
    dock,
    debugPanel,
    bookmarks: {
      records: () => bookmarks.records(),
      restore: (records) => bookmarks.restore(records),
    },
    layout,
    aiEnabled,
    openPath,
    withoutPersist,
    syncViewButtons,
    getDebugOptions: () => debugOptions,
    setDebugOptions: (options) => {
      debugOptions = options;
    },
  });

  // Закладки: список ведёт модель, редактор по нему рисует значки, сессия хранит его.
  // Одна подписка на изменение — значков и сохранения хватает одного источника.
  // Обёртка выделения: варианты зависят от языка открытого файла (блочный комментарий,
  // теги), а применяет их редактор. Пустое выделение тоже годится — будет пара знаков.
  const surroundModal = createSurroundModal({
    options: () => surroundOptions(editors.activeLanguage()),
    apply: (option) => {
      if (!editors.surroundSelection(option)) showToast('Нет открытого файла');
    },
  });
  document.body.appendChild(surroundModal.element);

  // Отладчик регулярных выражений: окно поверх редактора. Текст для поля подставляем из
  // выделения — чаще всего шаблон приходят проверять именно на выделенном куске.
  const regexTester = createRegexTester({ initialText: () => editors.selectedText() });
  document.body.appendChild(regexTester.element);

  // Замена по структуре: образец и замена вводятся в окне, а правку применяет
  // приложение — ей нужен документ, тогда правка идёт обычным путём (undo и сохранение).
  const structuralSearch = createStructuralSearch({
    activeText: () => {
      const path = editors.currentPath;
      return path ? (documents.get(path)?.value ?? null) : null;
    },
    selectionText: () => editors.selectedText(),
    apply: async ({ start, end, inserted }) => {
      const path = editors.currentPath;
      if (!path) return false;
      const document = documents.get(path);
      if (!document || document.readOnly) {
        showToast('Файл открыт только для чтения', 'error');
        return false;
      }
      // Одной правкой на весь участок — так она ложится в историю одним шагом.
      const from = fromOffset(document.value, start);
      const to = fromOffset(document.value, end);
      const result = await edits.applyFileEdits([
        {
          path,
          edits: [
            {
              startLine: from.line,
              startColumn: from.column,
              endLine: to.line,
              endColumn: to.column,
              newText: inserted,
              oldText: document.value.slice(start, end),
            },
          ],
        },
      ]);
      if (result.failed.length > 0) {
        showToast(result.failed[0]!.message, 'error');
        return false;
      }
      return true;
    },
    activePath: () => editors.currentPath,
    // Охват по проекту — тем же образцом: слой main обходит файлы и пишет изменённые,
    // а открытые вкладки перечитываем, иначе редактор покажет текст до замены.
    searchProject: (options) => rpc.request('workspace.structuralSearch', options),
    replaceProject: (options) => rpc.request('workspace.structuralReplace', options),
    reloadFile: (path) => reloadIfOpen(path),
    openFile: (path) => openPath(path).then(() => undefined),
  });
  document.body.appendChild(structuralSearch.element);

  const bookmarksModal = createBookmarksModal({
    bookmarks,
    root: () => workspace.root,
    reveal: (path, line) => void openPath(path).then(() => editors.reveal(path, line, 1)),
  });
  document.body.appendChild(bookmarksModal.element);

  /**
   * «Настройки папки»: вид дерева для ОДНОГО корня области. Путь приходит аргументом
   * команды (пункт меню у строки корня) — поэтому окно и открывается на конкретной папке.
   */
  let rootSettingsTarget: string | null = null;
  const rootSettingsModal = createRootSettingsModal({
    root: () => rootSettingsTarget ?? workspace.root,
    settings: () => settings.explorer,
    save: async (byRoot) => {
      await saveSettingsPatch({ explorer: { byRoot } });
    },
  });
  document.body.appendChild(rootSettingsModal.element);

  /**
   * Удалённый файл: свой просмотр с записью клиентом системы (`ssh`/`wsl`/`docker`).
   * Вкладку для него не открываем: у неё вся жизнь про локальный диск — сервер,
   * наблюдение, git (`main/workspace/remote-fs.ts`).
   */
  const remoteFileModal = createRemoteFileModal({ rpc, notify: (message, kind) => showToast(message, kind) });
  document.body.appendChild(remoteFileModal.element);

  /** Файлы, у которых значки закладок уже розданы: с них же и снимаем их. */
  const paintedBookmarks = new Set<string>();
  const paintBookmarks = (): void => {
    const files = new Set(bookmarks.files());
    for (const path of paintedBookmarks) {
      if (!files.has(path)) editors.setBookmarks(path, []);
    }
    for (const path of files) editors.setBookmarks(path, bookmarks.linesOf(path));
    paintedBookmarks.clear();
    for (const path of files) paintedBookmarks.add(path);
  };
  bookmarks.onDidChange(() => {
    paintBookmarks();
    session.scheduleSave();
  });
  // Клик по значку закладки в поле слева снимает её: состоянием владеет модель.
  editors.onBookmarkToggle(({ path, line }) => bookmarks.remove(path, line));
  /**
   * Сохранить документ на диск. Если файл изменился снаружи после нашего чтения,
   * молча писать нельзя — перетрём чужую правку (ассистента, из терминала).
   * Спрашиваем и перезаписываем только с согласия. `false` — человек отменил.
   */
  const saveDocument = async (document: TextDocument): Promise<boolean> => {
    // Файл только для чтения (большой) сохранять нечего: правок в нём быть не может.
    if (document.readOnly) {
      showToast('Файл открыт только для чтения — сохранять нечего', 'error');
      return false;
    }
    // Правки текста при сохранении: подрезать хвосты и поставить перевод строки.
    // Проводим через документ — тогда и на экране, и на диске одно и то же.
    const prepared = applySaveEdits(document.value, {
      trimTrailingWhitespace: settings.editor.trimTrailingWhitespace,
      insertFinalNewline: settings.editor.insertFinalNewline,
    });
    if (prepared !== document.value) document.setText(prepared, 'programmatic');
    // Форматирование при сохранении: правку проводит документ, поэтому на экране
    // и на диске оказывается одно и то же.
    if (settings.editor.formatOnSave) await formatDocument(document);
    const result = await edits.saveDocument(document);
    if (result === 'conflict') {
      const { confirmed } = await rpc.request('dialog.confirm', {
        title: 'Файл изменён на диске',
        message: `Файл «${basename(document.path)}» изменён после того, как его открыли.`,
        detail:
          'На диске уже другая версия — вероятно, её записал ассистент или другой инструмент. ' +
          'Если сохранить сейчас, правки из редактора заменят то, что там записано. Продолжить?',
        confirmLabel: 'Перезаписать',
      });
      if (!confirmed) return false;
      await edits.saveDocument(document, { force: true });
    }
    showToast(`Сохранено: ${basename(document.path)}`);
    return true;
  };

  /**
   * Сохранить несохранённые буферы перед операцией, которая читает рабочее дерево.
   *
   * Коммит (и исправление коммита) работает с файлами на диске, а не с экраном:
   * без этого правки из буфера в коммит не попадали, зато вкладка оставалась с
   * пометкой «не сохранён» — и работа человека терялась из виду.
   *
   * `false` — сохранить не удалось: человек отказался перезаписывать файл, который
   * изменили снаружи, или файл открыт только для чтения. Тогда операцию не начинаем:
   * иначе она прошла бы по устаревшему содержимому.
   */
  const saveDirtyForGit = async (): Promise<boolean> => {
    // План решает core/file-actions.ts: что сохранять, что нельзя (только для чтения),
    // а также учитывает настройку. Отсутствие значения — это «сохранять».
    const plan = planCommitSave(documents.dirty(), settings.git.saveBeforeCommit !== false);
    if (plan.blocked.length > 0) {
      // Файлы только для чтения сохранить нельзя, а git смотрит диск: коммит ушёл бы
      // по устаревшему содержимому. Отказываем и называем виновников.
      showToast(`Не сохранить (только чтение): ${plan.blocked.length}`, 'error');
      return false;
    }
    for (const path of plan.save) {
      const document = documents.get(path);
      if (document && !(await saveDocument(document))) return false;
    }
    // Файлы на диске только что изменились, а снимок статуса git у нас ещё прежний:
    // без пересчёта коммит решил бы, что правок нет (его модель помнит старый ответ).
    await git.refresh().catch(() => undefined);
    return true;
  };

  /**
   * Сторож для действий, меняющих рабочее дерево под ногами (checkout).
   *
   * Отличия от saveDirtyForGit: у checkout своя настройка (иначе человек,
   * разрешивший сохранять перед коммитом, не ждал бы того же перед ветвью), и
   * отказ здесь не «не сохранил», а «я сохранил, а ты всё равно потеряешь».
   *
   * Возвращает true — можно переключаться (что надо, уже на диске).
   */
  const prepareCheckout = async (): Promise<boolean> => {
    const plan: CheckoutPlan = planCheckout(documents.dirty(), settings.git.saveBeforeCheckout !== false);
    if (plan.blocked.length > 0) {
      // Сохранить нечего — файл только для чтения. git смотрит диск, а на экране
      // текст, которого на диске нет: переключение молча выкинет его.
      showToast(`Не сохранить (только чтение): ${plan.blocked.length}`, 'error');
      return false;
    }
    if (plan.ask) {
      // Сохранять запрещено настройкой: решает человек, а не догадка.
      const answer = await rpc.request('dialog.confirm', {
        title: 'Есть несохранённые файлы',
        message: 'Переключение ветки идёт по диску — несохранённое в ней не участвует. Сохранить и переключиться?',
        confirmLabel: 'Сохранить и переключиться',
      });
      if (!answer.confirmed) return false;
      for (const path of documents
        .dirty()
        .filter((document) => !document.readOnly)
        .map((document) => document.path)) {
        const document = documents.get(path);
        if (document && !(await saveDocument(document))) return false;
      }
    }
    for (const path of plan.save) {
      const document = documents.get(path);
      if (document && !(await saveDocument(document))) return false;
    }
    if (plan.save.length > 0 || plan.ask) await git.refresh().catch(() => undefined);
    return true;
  };

  /**
   * Сохранить документ ПОД ДРУГИМ ИМЕНЕМ (Save As). Путь выбирает человек системным
   * диалогом, поэтому в отличие от Ctrl+S запись идёт не по пути документа, а по
   * выбранному. Прежний файл на диске остаётся как был — это копия, и терять его
   * правкой «сохранить как» неправильно.
   *
   * Вкладка переезжает на новый файл: несохранённые правки уезжают вместе с ней,
   * поэтому закрытие прежней вкладки ничего не теряет. Правки при сохранении
   * (хвосты, перевод строки, формат) — те же, что у Ctrl+S: иначе текст на диске
   * зависел бы от того, каким путём его сохранили.
   */
  const saveDocumentAs = async (document: TextDocument): Promise<boolean> => {
    if (document.readOnly) {
      showToast('Файл открыт только для чтения — сохранить как нельзя', 'error');
      return false;
    }
    const picked = await rpc
      .request('dialog.saveFile', { title: 'Сохранить как', defaultPath: document.path })
      .catch(() => null);

    // Что делать с выбранным путём — решает чистая функция: отмена, тот же путь
    // (обычное сохранение) или путь вне рабочей области. Здесь остаётся запись.
    const decision = decideSaveAs(document.path, picked?.path ?? null, workspace.roots);
    if (decision.kind === 'cancel') return false;
    if (decision.kind === 'same-path') return saveDocument(document);
    if (decision.kind === 'outside') {
      showToast(decision.message, 'error');
      return false;
    }
    const target = decision.target;

    const prepared = applySaveEdits(document.value, {
      trimTrailingWhitespace: settings.editor.trimTrailingWhitespace,
      insertFinalNewline: settings.editor.insertFinalNewline,
    });
    if (prepared !== document.value) document.setText(prepared, 'programmatic');
    if (settings.editor.formatOnSave) await formatDocument(document);

    try {
      await rpc.request('workspace.writeFile', { path: target, text: document.value });
    } catch (error) {
      showToast(
        `Не удалось сохранить как ${basename(target)}: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
      return false;
    }

    // Вкладка переходит на новый файл. Прежнюю закрываем: два документа с одним
    // текстом на экране только путают, а правки уже записаны в новый файл.
    const previous = document.path;
    openEditors.close(previous);
    await openPath(target);
    explorer.scheduleRefresh();
    showToast(`Сохранено как ${basename(target)}`);
    return true;
  };

  /**
   * Закрытие окна с несохранёнными файлами. Сессию пишем всегда — это последний
   * шанс сохранить рабочее место. А правки терять нельзя, поэтому закрытие
   * отменяем и спрашиваем системным диалогом; окно при этом остаётся живым:
   * Electron по умолчанию не игнорирует отмену из `beforeunload`.
   *
   * `toLauncher` — куда уходит закрытое окно: «Закрыть проект» возвращает человека
   * к списку проектов (его поднимает main), обычное закрытие — просто выход.
   * Стартовое окно просим ПЕРЕД своим закрытием: отправить ответ в уничтоженное
   * окно невозможно, и вызов остался бы без результата.
   */
  let closing = false;
  const closeWindowSafely = async (toLauncher = false): Promise<void> => {
    closing = true;
    try {
      const files = documents.dirty();
      if (files.length > 0) {
        const { choice } = await rpc.request('dialog.confirmClose', { files: files.map((file) => file.path) });
        if (choice === 'cancel') return;
        if (choice === 'save') {
          for (const file of files) {
            // Отмена перезаписи — окно оставляем: правки ещё в редакторе.
            if (!(await saveDocument(file))) return;
          }
        }
      }
      if (toLauncher) await rpc.request('app.closeProject');
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

  const confirmClose = (): Promise<void> => closeWindowSafely();

  window.addEventListener('beforeunload', (event) => {
    session.saveNow();
    if (closing || documents.dirty().length === 0) return;
    event.preventDefault();
    // Без `returnValue` Chromium не считает выгрузку отменённой — окно закрылось бы.
    event.returnValue = false;
    void confirmClose();
  });

  /* ── Инструменты проекта: формат и установка ───────────────────────────── */

  /** Что вышло из попытки форматирования. */
  type FormatOutcome = 'changed' | 'unchanged' | 'unavailable' | 'readonly';

  /**
   * Отформатировать УЧАСТОК файла языковым сервером (`rangeFormatting`). Так форматируют
   * выделение и вставленный кусок: инструмент проекта (ruff, prettier) переписывает файл
   * целиком и на участок не годится. Сервер отдаёт правки — применяем их обычным путём,
   * поэтому и отмена у правки одна.
   *
   * Молча ничего не делаем, когда звали из-за вставки: там ошибку показывать не о чем.
   * Из команды (`format.selection`) `false` — это «сервер не умеет»: о нём говорим.
   */
  const formatRangeWithServer = async (
    path: string,
    range: { startLine: number; startColumn: number; endLine: number; endColumn: number },
    options: { silent?: boolean } = {},
  ): Promise<boolean> => {
    const document = documents.get(path);
    if (!document || document.readOnly) return false;
    const serverEdits = await lsp.formatRange(path, range).catch(() => []);
    if (serverEdits.length === 0) {
      if (!options.silent) showToast('Нечем форматировать участок: языковой сервер этого не умеет');
      return false;
    }
    // Правки могли ничего не изменить (сервер вернул тот же текст) — это не ошибка.
    let after: string;
    try {
      after = applyTextEdits(document.value, serverEdits);
    } catch {
      if (!options.silent) showToast('Форматирование вернуло несогласованные правки', 'error');
      return false;
    }
    if (after === document.value) {
      if (!options.silent) showToast('Менять нечего');
      return true;
    }
    const result = await edits.applyFileEdits([{ path, edits: serverEdits }]);
    if (result.failed.length > 0) {
      if (!options.silent) showToast(result.failed[0]!.message, 'error');
      return false;
    }
    return true;
  };

  /**
   * Отформатировать документ инструментом проекта. Правку проводим через документ:
   * так она попадает в undo и в сохранение.
   *
   * `unavailable` — это не «менять нечего»: инструмента в проекте может просто не
   * быть, и сказать об этом надо честно, а не молчанием.
   */
  const formatDocument = async (document: TextDocument): Promise<FormatOutcome> => {
    if (document.readOnly) return 'readonly';
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
    if (outcome === 'readonly') return 'Файл открыт только для чтения — форматировать нечего';
    return `Нечем форматировать: ${formatToolNames(engine).join(' и ')} в проекте нет`;
  };

  /**
   * Поставить пакеты в окружение проекта и перепроверить импорты.
   * Один путь для трёх входов: команда, кнопка в попапе и быстрая правка.
   */
  const install = createInstallActions({
    rpc,
    toast: showToast,
    settings: () => settings,
    root: () => workspace.root,
    projectTools: () => tools.get(),
    runInTerminal: (target) => runTarget(target),
    refreshImports: () => importChecker.refresh(),
    onInterpreterChanged: () => {
      // Подсказки подняты со старым интерпретатором — перезапускаем: у нового
      // окружения может найтись и свой pylsp.
      refreshLsp();
      pythonEnvPopover.refresh();
    },
  });
  const { installPythonPackages, installRequirements, installNodePackages, setProjectInterpreter, pickExistingVenv } =
    install;

  // Быстрые правки под курсором: свои (поставить пакет) и серверные (refactor,
  // действия языка). Состав меню — `core/editor-fixes.ts`.
  const fixes = createEditorFixes({
    editors,
    documents,
    lsp,
    edits,
    importChecker,
    installPythonPackages,
    installNodePackages,
    showToast,
    // Команда линзы — часть командного слоя; подсказки только зовут её.
    runLensCommand: (path, command) => void runLensCommand(path, command),
  });

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

  /**
   * Действия редактора, которых нет среди наших команд: переносим их в свою палитру.
   * Список короткий и честный — только то, что редактор действительно умеет, — поэтому
   * путаницы из двух палитр больше нет. Набор пересобираем на каждое открытие палитры:
   * он зависит от панели в фокусе (сравнение, отладка), а прежние пункты снимаем — иначе
   * мёртвые действия остались бы в списке.
   *
   * Регистрируем в обход `define`: нужен `() => void` для снятия с реестра. Ошибки
   * ловим здесь же — пункт палитры не должен падать молча.
   */
  let editorActionDisposers: Array<() => void> = [];
  const syncEditorActions = (): void => {
    for (const dispose of editorActionDisposers) dispose();
    editorActionDisposers = editorActionCommands(editors.listActions()).map((command) =>
      commands.register(command, async () => {
        // `editor.<id>` — обратно в id редактора: пункт заведён под префиксом.
        const actionId = command.id.slice('editor.'.length);
        try {
          editors.runAction(actionId);
        } catch (error) {
          console.error(`[chui] действие ${actionId} упало:`, error);
          showToast(error instanceof Error ? error.message : String(error), 'error');
        }
      }),
    );
  };

  // Дерево, рабочая область и уведомления — в `core/explorer-commands.ts`: сами команды
  // решают, что перерисовать и что сказать человеку, а модели дерева и области живут у
  // себя. `applySettings` передаём лениво — она объявлена ниже, а нужна в момент вызова.
  registerExplorerCommands(define, {
    workspace,
    explorer,
    editors,
    rpc,
    commands,
    showToast,
    applySettings: (next) => applySettings(next),
    basename,
  });

  // Закрыть проект: окно IDE уступает место стартовому окну со списком проектов
  // (`app.closeProject` в main). Путь тот же, что у закрытия окна, — с вопросом
  // о несохранённых файлах.
  define({ id: 'project.close', title: 'Закрыть проект', category: 'Файл' }, () => closeWindowSafely(true));


  // Вкладки — в `core/file-tab-commands.ts`. Открытие пути осталось здесь: только оно
  // различает pdf, картинку, Office и текст; модулю досталось «какая вкладка показана»
  // и что делать с соседями — это фасет «вкладки», которым потом поделится AppContext.
  registerFileTabCommands(define, {
    openEditors,
    documents,
    editors,
    browserStrip: browserTabs,
    browserPages,
    openPath,
  });

  // Сравнение двух папок: список различий, клик по файлу открывает его сравнение.
  define({ id: 'folder.compare', title: 'Сравнить папки', category: 'Навигация' }, async (left, right) => {
    if (typeof left !== 'string' || typeof right !== 'string') return;
    await folderCompareModal.open(left, right);
  });

  // Сравнение двух файлов — из дерева, тем же экраном, что показывает git-различия.
  // Это просмотр: блоки без кнопок индексации (см. `openFiles`).
  define({ id: 'diff.compareFiles', title: 'Сравнить два файла', category: 'Навигация' }, async (left, right) => {
    if (typeof left !== 'string' || typeof right !== 'string') return;
    await diffView.openFiles(left, right);
  });

  // «Сравнить с…»: выбранный файл и подобранный быстрым открывателем. Так сравнивают
  // с файлом из другой папки, не раскрывая дерево до него.
  define({ id: 'file.compareWith', title: 'Сравнить с…', category: 'Файл' }, async (path) => {
    if (typeof path !== 'string') return;
    const other = await quickOpen.pick('С чем сравнить?');
    if (!other || other === path) return;
    await diffView.openFiles(path, other);
  });

  // Ровно два файла в выделении — сравниваем их между собой без вопросов.
  define({ id: 'file.compareSelection', title: 'Сравнить выделенные файлы', category: 'Файл' }, async (paths) => {
    if (!Array.isArray(paths)) return;
    const list = paths.filter((item): item is string => typeof item === 'string');
    const pair = pairFromSelection(list);
    if (!pair) return;
    await diffView.openFiles(pair.left, pair.right);
  });

  // Терминал системы в папке: открывается ВНЕ окна IDE, привычный человеку.
  // Не путать с `terminal.openIn` — тот поднимает встроенную панель.
  define({ id: 'terminal.openExternal', title: 'Терминал системы в папке', category: 'Терминал' }, async (target) => {
    const path = typeof target === 'string' && target !== '' ? target : workspace.root;
    if (!path) return;
    const { ok } = await rpc.request('shell.openTerminal', { path });
    if (!ok) showToast('Не нашёл терминал: задайте свой в настройке `TERMINAL`', 'error');
  });

  /**
   * Подключить удалённую папку: адрес спрашиваем строкой (системный диалог папки
   * локальный — удалённую папку он выбрать не может), проверяем разбором и клиентом.
   */
  const addRemoteRoot = (): void => {
    conditionInput.open({
      title: 'Удалённая папка',
      label: 'Адрес',
      placeholder: 'ssh://user@host/srv/app',
      confirmLabel: 'Подключить',
      onAccept: (value) => void connectRemoteRoot(value),
    });
  };

  const connectRemoteRoot = async (value: string): Promise<void> => {
    const problem = addressProblem(value);
    if (problem) {
      showToast(problem, 'error');
      return;
    }
    // Клиент проверяем ДО записи в настройки: без ssh/wsl/docker адрес открывать нечем,
    // и лучше сказать это сразу, чем оставить молча нерабочую строку в списке.
    const check = await rpc.request('remote.check', { address: value }).catch((error: unknown) => ({
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }));
    if (!check.ok) {
      showToast(check.detail, 'error');
      return;
    }
    if (settings.workspace.remoteRoots.includes(value)) {
      showToast('Такая папка уже подключена');
      return;
    }
    await saveSettingsPatch({ workspace: { remoteRoots: [...settings.workspace.remoteRoots, value] } });
    showToast(`Подключено: ${check.detail || value}`);
  };

  define({ id: 'remote.addRoot', title: 'Подключить удалённую папку…', category: 'Вид' }, () => addRemoteRoot());

  define({ id: 'remote.openFile', title: 'Открыть удалённый файл…', category: 'Вид' }, (address) => {
    if (typeof address !== 'string' || address === '') return;
    void remoteFileModal.open(address);
  });

  // Настройки вида дерева для одной папки области: пункт меню у строки корня.
  define({ id: 'explorer.rootSettings', title: 'Настройки папки…', category: 'Вид' }, (path) => {
    rootSettingsTarget = typeof path === 'string' && path !== '' ? path : workspace.root;
    if (!rootSettingsTarget) {
      showToast('Папка не открыта', 'error');
      return;
    }
    rootSettingsModal.open();
  });


  define({ id: 'file.revealInOS', title: 'Показать в системном проводнике', category: 'Файл' }, async (path) => {
    if (typeof path !== 'string') return;
    const { ok } = await rpc.request('shell.revealInOS', { path });
    if (!ok) showToast('Не удалось показать в проводнике системы', 'error');
  });

  define(
    {
      id: 'file.history',
      title: 'Локальная история файла',
      category: 'Файл',
      keywords: ['история', 'снимки', 'локальная', 'timeline', 'восстановить версию'],
    },
    (path) => {
      if (typeof path !== 'string') return;
      void historyModal.open(path);
    },
  );

  define({ id: 'file.openExternal', title: 'Открыть внешней программой', category: 'Файл' }, async (path) => {
    if (typeof path !== 'string') return;
    const { ok } = await rpc.request('shell.openPath', { path });
    if (!ok) showToast('Система не нашла, чем открыть файл', 'error');
  });

  // Терминал поднимается в нужной папке: у открытого файла — рядом с ним, у папки —
  // в ней самой. Сессию создаём ДО показа дока: показ сам открывает терминал, и та
  // сессия ушла бы в корень области — наш каталог потерялся бы (гонка `creating`).
  define({ id: 'terminal.openIn', title: 'Терминал в папке', category: 'Терминал' }, async (target) => {
    const path = typeof target === 'string' && target !== '' ? target : workspace.root;
    if (!path) return;
    await terminalPanel.newSession(path);
    dock.show('terminal');
  });

  define({ id: 'file.revealAt', title: 'Перейти к позиции', category: 'Навигация' }, async (path, line, column) => {
    if (typeof path !== 'string') return;
    await openPath(path);
    editors.reveal(path, typeof line === 'number' ? line : 1, typeof column === 'number' ? column : 1);
  });

  /* ── запуск ────────────────────────────────────────────────────────────── */

  /**
   * Цель прогона тестов: файл под курсором, иначе — все тесты проекта. Вынесено
   * из команды, потому что тем же расчётом решается, доступна ли она вовсе.
   */
  const testTarget = (): RunTarget | undefined => {
    const active = openEditors.active;
    const relative = active ? workspace.relative(active.path) : null;
    const targets = collectRunTargets(runnableFileOf(active), tools.get(), projectScan, nodeRunner());
    const runnable = relative && relative !== active?.path ? relative : null;
    // Цели тестов у языков называются по-разному: у Python — `pytest:…`, у Node —
    // `node-tests:…`. Сначала пробуем файл, в котором стоит человек, потом — все тесты.
    return (
      targets.find(
        (item) => item.source === 'test' && (item.id === `pytest:${runnable}` || item.id === `node-tests:${runnable}`),
      ) ?? targets.find((item) => item.id === 'pytest:all' || item.id === 'node-tests:all')
    );
  };

  // Сами команды запуска — в `core/run-commands.ts`: они только выбирают цель и говорят,
  // чего не хватает. Расчёт целей (`targetsFor`, `testTarget`) и прогон (`runTarget`)
  // остаются здесь: ими пользуются кнопка в шапке, статус-бар и панель задач.
  registerRunCommands(define, {
    openEditors,
    targetsFor,
    testTarget,
    runTarget,
    runControl,
    showMenu: (items, x, y, options) => showPopupMenu(items, x, y, options),
    showToast,
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

  // Команды отладки — `core/debug-commands.ts`: тексты, клавиши, «что сказать,
  // если не вышло». Исполняет DebugController, поэтому состояние спрашивается
  // через его же get(), а параметры запуска держит это замыкание (они в сессии).
  registerDebugCommands(define, {
    debug,
    openEditors,
    editors,
    dock,
    promptValue,
    launchOptions,
    activeDebuggableFile: () => activeDebuggableFile(),
    startDebug: (options) => startDebug(options),
    getLaunchOptions: () => debugOptions,
    setLaunchOptions: (options) => {
      debugOptions = options;
    },
    scheduleSave: () => session.scheduleSave(),
    showToast,
  });

  // Закладки: поставить на строку курсора, ходить между ними, показать списком.
  // Уборка закладок файла клавиши не получает: это редкое дело, а не жест.
  define({ id: 'editor.toggleBookmark', title: 'Закладки: поставить или снять', category: 'Навигация' }, () => {
    const path = editors.currentPath;
    if (path) bookmarks.toggle(path, editors.cursor().line);
  });

  /** Перейти к соседней закладке: файл может быть другим — сначала открываем его. */
  const goToBookmark = (direction: 1 | -1): void => {
    const path = editors.currentPath;
    const target = path
      ? bookmarks.next({ path, line: editors.cursor().line }, direction)
      : ((direction === 1 ? bookmarks.all[0] : bookmarks.all[bookmarks.all.length - 1]) ?? null);
    if (!target) {
      showToast('Закладок нет');
      return;
    }
    void openPath(target.path).then(() => editors.reveal(target.path, target.line, 1));
  };

  define({ id: 'editor.nextBookmark', title: 'Закладки: следующая', category: 'Навигация' }, () => goToBookmark(1));
  define({ id: 'editor.previousBookmark', title: 'Закладки: предыдущая', category: 'Навигация' }, () =>
    goToBookmark(-1),
  );
  define({ id: 'editor.bookmarksList', title: 'Закладки: список', category: 'Навигация' }, () => bookmarksModal.open());
  define({ id: 'editor.clearBookmarksInFile', title: 'Закладки: убрать в файле', category: 'Навигация' }, () => {
    const path = editors.currentPath;
    if (path) bookmarks.clearFile(path);
  });

  // Дзен-режим помнит, что было видно до входа. Состояние живёт здесь, а не в модуле
  // команд: оно переживает вызовы и умирает вместе с окном, как и сам макет.
  let zenSaved: ZenSnapshot | null = null;

  // Вид: панели, док, разделение и дзен — `core/view-commands.ts`. Состояние остаётся
  // в раскладке и доке; команда только переключает и просит перерисовать кнопки.
  registerViewCommands(define, {
    layout,
    dock,
    syncViewButtons,
    withoutPersist,
    getZen: () => zenSaved,
    setZen: (snapshot) => {
      zenSaved = snapshot;
    },
    editors,
    openEditors,
    statusBar,
    openGitManager,
    isMarkdownPath,
    toggleMarkdownPreview,
    regexTester,
    showToast,
  });

  // Флаг режима: чтение и запись одним местом. Запись обновляет и локальные
  // настройки (иначе команда не увидит своего эффекта до перечитывания), и диск —
  // одна команда не сможет записать одно, а показать другое.
  const editorMode = (name: EditorModeName): boolean => settings.editor[name];
  const setEditorMode = (name: EditorModeName, on: boolean): void => {
    settings = { ...settings, editor: { ...settings.editor, [name]: on } };
    void saveSettingsPatch({ editor: { [name]: on } }).catch(() => undefined);
  };

  // Режимы ввода и орфография — `core/editor-mode-commands.ts`: там порядок
  // «применить → сообщить → сохранить» и все тексты.
  registerEditorModeCommands(define, {
    editors,
    mode: editorMode,
    setMode: setEditorMode,
    showToast,
    // Лениво: `refreshStatus` объявлена ниже — ссылка «сейчас» упала бы в TDZ.
    refreshStatus: () => refreshStatus(),
  });

  // Исправления и рефакторинги текущего файла — `core/editor-fix-commands.ts`:
  // четыре команды — одна развилка «есть ли открытый файл».
  registerEditorFixCommands(define, {
    currentPath: () => editors.currentPath,
    fixes,
    showToast,
  });

  // Создание и переименование — в `core/file-create-commands.ts`: там порядок шагов
  // (закрыть вкладку → трогать диск) и отмены, идущие теми же шагами обратно.
  registerFileCreateCommands(define, {
    rpc,
    commands,
    openEditors,
    explorer,
    settings,
    showToast,
    openPath,
  });

  // Сохранение и перечитывание с диска — в `core/file-save-commands.ts`: самой
  // записи буфера там нет, только выбор цели и честное «нет открытого файла».
  registerFileSaveCommands(define, {
    openEditors,
    documents,
    saveDocument,
    saveDocumentAs,
    // Лениво: `revertFilesToDisk` объявлена ниже этой строки, и брать ссылку сразу
    // нельзя — имена модулей сидят в замыкании, а не в моменте регистрации.
    revertFilesToDisk: (targets) => revertFilesToDisk(targets),
    showToast,
  });

  // Удаление в корзину, перенос и копирование живут в `core/file-mutation-commands.ts`:
  // диск, вкладки и уведомления — там, а «что именно трогать» решают чистые модули
  // (`file-actions`, `tree-move`, `file-notices`).
  registerFileMutationCommands(define, {
    rpc,
    openEditors,
    explorer,
    settings,
    workspace,
    showToast,
    openPath,
  });

  /* ── git ───────────────────────────────────────────────────────────────── */


  // Запись в репозиторий (индекс, коммит, откат) живёт в `core/git-write-commands.ts`:
  // оно не завязано на панели, а зависит только от модели git и двух диалогов —
  // и проверяется тестом без окна.
  registerGitWriteCommands(define, {
    git,
    showToast,
    confirm: async (options) => (await rpc.request('dialog.confirm', options)).confirmed,
    root: () => workspace.root,
    relative: (path) => workspace.relative(path),
    saveDirtyForGit,
  });

  // Сообщение коммита по diff — в `core/git-ai-commands.ts`: там же гейты AI,
  // а самой команде нужен только один запрос к main.
  registerGitAiCommands(define, {
    git,
    showToast,
    isAiEnabled: aiEnabled,
    warnAiDisabled,
    commitMessage: (payload) => rpc.request('ai.commitMessage', payload),
    setMessage: (message) => sourceControl.setMessage(message),
    // Панель изменений теперь в поповере у кнопки ветки: уже открытый не переключаем (toggle бы закрыл).
    revealComposer: () => {
      if (!gitManagerPopover?.isOpen) openGitManager(statusBar.gitAnchor);
    },
  });

  // Показ (сравнение, замечания, blame, жёлоб) — рядом, в `core/git-view-commands.ts`:
  // там только диалоги и ни одного пути записи в репозиторий.
  registerGitViewCommands(define, {
    git,
    showToast,
    openDiff: (path, staged, commit) => diffView.open(path, staged, commit),
    diffIsOpen: () => diffView.isOpen,
    showDiffComments: () => diffView.showComments(),
    currentPath: () => editors.currentPath,
    cursorLine: () => editors.cursor().line,
    toggleBlame: () => blame.toggle(),
    toggleFileBlame: () => blame.toggleFile(),
    toggleChangeGutter: () => changeGutter.toggle(),
  });

  // История и stash — только показ готового от git: `core/git-panel-commands.ts`.
  registerGitPanelCommands(define, {
    git,
    showToast,
    openText: (title, text) => textModal.open(title, text),
    openStash: () => stashModal.open(),
  });

  // Окна git, которые ничего не меняют: bisect, worktree, площадка, личность, LFS,
  // sparse, сравнение веток и подмодули — `core/git-tools-commands.ts`.
  registerGitToolsCommands(define, {
    isRepository: () => git.isRepository,
    showToast,
    panels: {
      bisect: () => bisectModal.open(),
      worktrees: () => worktreeModal.open(),
      pullRequests: () => forgeModal.open(),
      issues: () => issuesModal.open(),
      pipelines: () => pipelinesModal.open(),
      notifications: () => notificationsModal.open(),
      identity: () => identityModal.open(),
      lfs: () => lfsModal.open(),
      sparse: () => sparseModal.open(),
      compareRefs: () => refDiffModal.open(),
    },
    submoduleUpdate: async () => {
      await git.submoduleUpdate();
    },
  });

  // История, теги и reflog — списки, из которых выбирают действие:
  // `core/git-history-commands.ts`. Попап открываем там, где стоит редактор.
  registerGitHistoryCommands(define, {
    git,
    showToast,
    confirm: async (options) => (await rpc.request('dialog.confirm', options)).confirmed,
    ask: (options) => promptValue(options),
    popup: (items) => {
      const rect = layout.editorHost.getBoundingClientRect();
      showPopupMenu(items, rect.left + 40, rect.top + 40, { anchor: layout.editorHost });
    },
    execute: (id) => void commands.execute(id),
    openRebase: () => rebaseModal.open(),
    openDiff: (path, commit) => diffView.open(path, false, commit),
    currentPath: () => editors.currentPath,
  });

  // Списки символов: иерархии, экспорты, наследование, члены типа, переопределения.
  // Состав и переходы — `core/symbol-pickers.ts`; команды он регистрирует сам.
  createSymbolPickers({
    define,
    lsp,
    editors,
    workspace,
    rpc,
    layout,
    openPath,
    meaningSearch,
    refreshSymbolIndex,
  });

  // Ветки, синхронизация и массовые действия с индексом — `core/git-sync-commands.ts`:
  // там всё, что трогает дерево разом или спрашивает подтверждение.
  registerGitSyncCommands(define, {
    git,
    showToast,
    prepareCheckout: () => prepareCheckout(),
    openConflict: (path) => conflictView.open(path),
    currentPath: () => editors.currentPath,
    pullMode: () => settings.git.pullMode,
    isMultiRoot: () => workspace.isMultiRoot,
    confirm: async (options) => (await rpc.request('dialog.confirm', options)).confirmed,
    activePath: () => openEditors.active?.path ?? null,
    hasTab: (path) => openEditors.has(path),
    closeTab: (path) => openEditors.close(path),
    openPath: (path) => openPath(path),
  });


  define({ id: 'search.project', title: 'Поиск по проекту', category: 'Поиск', keybinding: 'Ctrl+Shift+F' }, () =>
    dock.show('search'),
  );

  // TODO/FIXME — тот же поиск по проекту, только запрос готовый: регулярка ловит
  // пометки одним проходом, а результаты открываются как обычно — панелью поиска.
  define(
    {
      id: 'search.todo',
      title: 'Найти TODO и FIXME',
      category: 'Поиск',
      keywords: ['todo', 'fixme', 'hack', 'пометки'],
    },
    () => {
      dock.show('search');
      searchView.search('\\b(TODO|FIXME|HACK|XXX)\\b', { isRegex: true });
    },
  );


  define({ id: 'editor.structuralReplace', title: 'Заменить по структуре', category: 'Рефакторинг' }, () => {
    structuralSearch.open();
  });


  /**
   * Открыть адрес вкладкой встроенного браузера. Адрес нормализуем тем же правилом,
   * что и браузер агента (`shared/browser.ts`): без схемы — https, локальные — http,
   * а всем прочим схемам (file:, javascript:) отказ.
   */
  const openBrowserPage = (rawUrl: string): void => {
    const normalized = normalizeBrowserUrl(rawUrl);
    if (!normalized.ok) {
      showToast(normalized.reason, 'error');
      return;
    }
    // Дальше всё делает модель: вкладка появится в полосе, а полотно покажет страницу.
    browserTabs.open(normalized.url);
  };

  /**
   * Ссылка из вывода терминала. Локальный адрес открываем вкладкой в IDE: это почти
   * всегда свой запущенный сервер или тест, и смотреть его надо рядом с кодом, а не
   * искать окно браузера. Чужой адрес отдаём системному браузеру — схему проверит main.
   * Развилка знакомая (в других редакторах она выведена настройкой), и по умолчанию
   * локальные ссылки открываются встроенным браузером.
   */
  const openLinkFromTerminal = (url: string): void => {
    if (isLocalUrl(url)) {
      openBrowserPage(url);
      return;
    }
    void rpc.request('shell.openExternal', { url }).catch(() => undefined);
  };

  // Встроенный браузер: страница открывается вкладкой в редакторе.
  define(
    {
      id: 'browser.open',
      title: 'Открыть страницу (браузер в редакторе)',
      category: 'Вид',
      keybinding: 'Ctrl+Shift+B',
      keywords: ['browser', 'url', 'страница', 'браузер', 'интернет'],
    },
    async () => {
      const value = await promptValue({ title: 'Открыть страницу', label: 'Адрес', value: 'https://' });
      if (value === null || value.trim() === '') return;
      openBrowserPage(value);
    },
  );

  // Закрыть все вкладки браузера: у файлов есть «закрыть другие», у страниц не было,
  // а их набирается много, когда ходишь по одному сайту.
  define({ id: 'browser.closeAll', title: 'Закрыть все вкладки браузера', category: 'Вид' }, () => {
    if (browserTabs.list.length === 0) return;
    void rpc.request('browser.viewCloseAll', undefined).catch(() => undefined);
    browserTabs.closeAll();
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
        checks: menuChecks({
          sidebar: layout.sidebarVisible,
          aiPanel: aiEnabled() && layout.rightVisible,
          terminal: layout.dockVisible && dock.activeId === 'terminal',
        }),
      },
      () => menuButton.classList.remove('is-menu-open'),
    );
  });

  define({ id: 'palette.open', title: 'Палитра команд', category: 'Вид', keybinding: 'Ctrl+Shift+P' }, () => {
    syncEditorActions();
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

  // Команды Python — в `core/python-commands.ts`: меню, проверки и то, что видит человек.
  // Профилировщик и установщик пакетов приходят сюда из `core/line-profile.ts` и
  // `core/install-actions.ts` — они нужны не только командам.
  registerPythonCommands(define, {
    editors,
    documents,
    saveDocument,
    venvModal,
    installRequirements,
    rpc,
    showToast,
    basename,
  });

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
      if (document.readOnly) {
        showToast('Файл открыт только для чтения — форматировать нечего');
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

  // Форматирование ВЫДЕЛЕНИЯ: сервер переписывает только участок, файл целиком не трогает.
  // Инструмент проекта так не умеет — он всегда форматирует весь файл.
  // Сочетание Ctrl+K Ctrl+F живёт в клавиатуре редактора (`keymap.ts` → `formatSelection`):
  // вторая подпись на ту же пару врала — гонку выигрывал обработчик редактора.
  // Здесь сочетания нет намеренно: команда нужна палитре и меню.
  define(
    {
      id: 'format.selection',
      title: 'Форматировать выделение',
      category: 'Файл',
      keywords: ['format', 'selection', 'выделение', 'формат'],
    },
    async () => {
      const document = openEditors.active;
      if (!document) {
        showToast('Нет открытого файла');
        return;
      }
      if (document.readOnly) {
        showToast('Файл открыт только для чтения — форматировать нечего');
        return;
      }
      // Выделения нет — форматируем весь файл: команда участка без выделения
      // берёт документ целиком. Иначе команда молчала бы о «нечего делать».
      if (!editors.hasSelection()) {
        const engine = formatEngine(document.languageId);
        if (!engine) {
          showToast(`Не форматирую ${languageLabel(document.languageId)}: для него инструмента нет`);
          return;
        }
        showToast(formatOutcomeMessage(engine, await formatDocument(document)));
        return;
      }
      await formatRangeWithServer(document.path, editors.selectionRange());
    },
  );

  // Упорядочить импорты делает языковой сервер: у него просим действие `source.organizeImports`.

  /**
   * Макросы: запись действий и повтор. Макрос копит не клавиши, а действия (движение,
   * правку, вставленный текст), поэтому повтор не зависит от раскладки и от того, где
   * стоит курсор. Запись идёт вводом активной панели — ключей у команд нет: это редкий
   * жест, и вешать его на клавишу, которую кто-то уже занял, значит мешать чаще, чем
   * помогать. Вызываются из палитры команд.
   */
  define({ id: 'editor.macroRecord', title: 'Макрос: начать или остановить запись', category: 'Редактор' }, () => {
    if (!editors.currentPath && !editors.isRecordingMacro()) {
      showToast('Нет открытого файла');
      return;
    }
    if (editors.isRecordingMacro()) {
      const steps = editors.stopMacro();
      showToast(macroRecordedNotice(steps.length));
      refreshStatus();
      return;
    }
    editors.startMacro();
    showToast('Запись макроса началась: остановить — той же командой');
    refreshStatus();
  });

  const playMacro = (times: number): void => {
    const steps = editors.macroSteps();
    const check = macroPlayCheck(steps.length, editors.currentPath !== null);
    if (check.kind === 'refused') {
      showToast(check.message);
      return;
    }
    let done = 0;
    for (let i = 0; i < times; i += 1) done += editors.playMacro(steps);
    showToast(macroPlayedNotice(times, done));
  };

  define({ id: 'editor.macroPlay', title: 'Макрос: выполнить', category: 'Редактор' }, () => playMacro(1));

  define({ id: 'editor.macroPlayCount', title: 'Макрос: выполнить несколько раз…', category: 'Редактор' }, async () => {
    const answer = await promptValue({
      title: 'Сколько раз выполнить макрос?',
      label: 'Число повторов',
      value: String(DEFAULT_MACRO_TIMES),
    });
    if (answer === null) return;
    const check = checkMacroTimes(answer);
    if (check.kind === 'refused') {
      showToast(check.message, 'error');
      return;
    }
    playMacro(check.times);
  });


  define({ id: 'settings.revealFile', title: 'Открыть settings.json', category: 'Настройки' }, async () => {
    const result = await rpc.request('settings.revealFile');
    showToast(`Настройки: ${result.path}`);
  });

  define({ id: 'lsp.restart', title: 'Языковые серверы: перезапустить', category: 'Языки' }, async () => {
    const result = await rpc.request('lsp.restart');
    // Состояние после перезапуска — оно же и сняло «не поднялось»: показываем чип сразу.
    applyLspStatus(result);
    showToast(
      result.running.length > 0
        ? `Серверы: ${result.servers.map((server) => server.label).join(', ')}`
        : 'Языковые серверы остановлены',
    );
    // Серверы поднимаются лениво, при открытии файлов: перепроверим, когда поднимутся.
    window.setTimeout(() => void refreshLspStatus(), 1500);
  });

  // Команды ассистента — `core/ai-commands.ts`: там три правила про гейт мастера
  // (вход в чат — спрашивает, диагностика — нет, остановка — всегда).
  // `ai.generateTest` остался здесь: у него 15 зависимостей (rpc, workspace, пути) —
  // вынос дал бы модулю больше связей, чем строк.
  registerAiCommands(define, {
    aiEnabled,
    warnAiDisabled,
    chat,
    revealChat,
    toggleChat,
    telemetryModal,
    diagnoseHighlighting,
    showToast,
  });

  /**
   * Тест к выделенному коду — мимо чата: один запрос, как у сообщения коммита. Код берём
   * из выделения, а если его нет — из активного файла; тест получаем кодом и кладём в
   * НОВЫЙ файл по предложенному пути (`shared/test-generation.ts`), чтобы человек его
   * посмотрел и поправил, как обычный код.
   */
  define(
    { id: 'ai.generateTest', title: 'Сгенерировать тест к коду', category: 'AI', keywords: ['тест', 'test'] },
    async () => {
      if (!aiEnabled()) {
        warnAiDisabled();
        return;
      }
      const path = editors.currentPath;
      if (!path) {
        showToast('Откройте файл', 'error');
        return;
      }
      const document = documents.get(path);
      const code = editors.selectedText().trim() || document?.value.trim() || '';
      if (!code) {
        showToast('Нечего тестировать: пустой файл', 'info');
        return;
      }

      const relative = workspace.relative(path);
      const testRelative = suggestTestPath(relative);
      if (!testRelative) {
        showToast('Это уже тест: файл теста к тесту не создаём', 'info');
        return;
      }
      const root = workspace.ownerOf(path)?.root ?? workspace.root;
      if (!root) {
        showToast('Сначала откройте проект', 'error');
        return;
      }

      const truncated = truncateTestCode(code);
      showToast('Пишу тест…', 'info');
      let result: { code: string };
      try {
        result = await rpc.request('ai.generateTest', {
          language: editors.activeLanguage(),
          relativePath: relative,
          code: truncated.text,
          testPath: testRelative,
        });
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), 'error');
        return;
      }
      if (isEmptyTest(result.code)) {
        showToast('Модель не предложила тест', 'info');
        return;
      }

      const target = joinPath(root, testRelative);
      try {
        await rpc.request('workspace.createFile', { path: target, contents: `${result.code}\n` });
      } catch (error) {
        // Файл уже есть — не перетираем чужой тест, а честно об этом говорим.
        showToast(error instanceof Error ? error.message : String(error), 'error');
        return;
      }

      explorer.scheduleRefresh();
      await openPath(target);
      showToast(`Тест создан: ${testRelative}`);
    },
  );

  /* ── реакция на события ────────────────────────────────────────────────── */

  /**
   * Состояние языковых серверов: чип в статусбаре и попап читают его отсюда. Свежесть
   * не критична (сервер поднимается лениво, при открытии файлов), поэтому спрашиваем не
   * на каждое движение курсора, а при старте, смене проекта, перезапуске и смене языка.
   */
  let lspStatus: LspStatus = NO_LSP_STATUS;
  /** Язык, для которого состояние уже спрашивали: не дёргаем main дважды на тот же файл. */
  let lspChipLanguage: string | null = null;

  /** Показать чип по уже известному состоянию — без нового запроса. */
  function applyLspStatus(status: LspStatus): void {
    lspStatus = status;
    statusBar.update({
      lsp: settings.lsp.enabled ? lspChipFor(openEditors.active?.languageId ?? null, lspStatus) : null,
    });
  }

  async function refreshLspStatus(): Promise<void> {
    const status = await rpc.request('lsp.status').catch(() => null);
    if (status) applyLspStatus(status);
  }

  /**
   * Чем занят языковой сервер: состояния по токенам — в `core/lsp-progress.ts`
   * (параллельные занятия, повторный `report`, забытый токен). Здесь — показ в статусбар.
   */
  const lspProgress = createLspProgressController({
    show: (view) => statusBar.update({ progress: view }),
  });

  const refreshStatus = (): void => {
    const active = openEditors.active;
    const projectTools = tools.get();
    // Картинка или Office — не язык: в чипе показываем формат (PNG, SVG).
    const activePath = active?.path ?? null;
    const format: 'image' | 'office' | null =
      activePath === null ? null : isImagePath(activePath) ? 'image' : isOfficePath(activePath) ? 'office' : null;
    const language = format === null ? (active?.languageId ?? null) : null;
    const indent = settings.editor.languageIndent && language ? languageIndent(language) : null;
    const inputs = {
      active: active
        ? {
            path: active.path,
            languageId: active.languageId ?? null,
            readOnly: active.readOnly ?? false,
            version: active.version ?? 0,
          }
        : null,
      format,
      formatLabel:
        format === 'image' && activePath !== null
          ? imageFormatLabel(activePath)
          : format === 'office' && activePath !== null
            ? officeFormatChip(activePath)
            : null,
      languageLabel: language ? languageLabel(language) : null,
      languageIndent: indent,
      settings: {
        tabSize: settings.editor.tabSize,
        insertSpaces: settings.editor.insertSpaces,
        lspEnabled: settings.lsp.enabled,
      },
      lspChip: lspChipFor(language, lspStatus),
      git: { branch: git.branch, changeCount: git.changeCount },
      projectKind: projectScan?.kind ?? null,
      problems: editors.problemCounts(),
      vim: settings.editor.vimMode ? editors.vimMode() : null,
      macro: editors.isRecordingMacro() ? { steps: editors.macroSteps().length } : null,
      tools: projectTools,
      configuredPython: settings.run.pythonPath,
    };
    // Язык сменился — перечитываем состав серверов: сервер поднимается лениво.
    if (needsLspRefresh(inputs, lspChipLanguage)) {
      lspChipLanguage = language;
      void refreshLspStatus();
    }
    statusBar.update(statusPatch(inputs));

    // Имя открытого файла — в центре шапки; его сменяет кнопка запуска, когда есть
    // что запускать, и оно остаётся запасным вариантом на пустом месте.
    const project = workspace.current?.name;
    // Имя файла и проекта — и в шапке, и в заголовке окна. Заголовок описывает
    // содержимое, а не повторяет имя приложения: оно тут только запасной вариант,
    // когда ничего не открыто.
    const title = active ? (project ? `${basename(active.path)} — ${project}` : basename(active.path)) : 'chui_iDE';
    topBarName.textContent = title;
    document.title = title;
    // Название приложения — моношрифтом, имя файла — интерфейсным.
    topBarName.classList.toggle('is-brand', !active);
    topBarName.title = active?.path ?? 'chui_iDE';
  };

  const syncEmptyState = (): void => emptyState.update(openEditors.paths.length > 0);

  const applySettings = (next: Settings): void => {
    const previous = settings;
    settings = next;
    // Что перестраивать, а что трогать незачем, решает чистый модуль
    // (`shared/settings-plan.ts`): тонкости сравнения закреплены тестами.
    const plan = settingsPlan(previous, next);
    applyUiScale(next.appearance.uiScale);
    editors.applyOptions({
      tabSize: next.editor.tabSize,
      fontSize: next.editor.fontSize,
      lineHeight: next.editor.lineHeight,
      cursorStyle: next.editor.cursorStyle,
      cursorBlink: next.editor.cursorBlink,
      rulers: next.editor.rulers,
      whitespace: next.editor.renderWhitespace,
      minimap: next.editor.minimap,
      wordWrap: next.editor.wordWrap,
      smoothScroll: next.editor.smoothScroll,
      vimMode: next.editor.vimMode,
      emacsMode: next.editor.emacsMode,
      ligatures: next.editor.fontLigatures,
      spellcheck: next.editor.spellcheck,
    });
    // Словарь человека изменили — пересобираем модель (она сама перепроверит текст).
    if (plan.spellWords) spell.setUserWords(next.editor.spellWords);
    // Автосохранение сменили — режим или паузу: снимаем уже назначенную запись или
    // ставим новую с новой задержкой. Иначе правка ждала бы прежней задержки.
    if (plan.autoSave) autoSave.settingsChanged();
    // Дерево получает настройки С УЧЁТОМ отличий активного корня: у каждой папки
    // области они свои (см. `shared/explorer-settings.ts`).
    explorer.applySettings(resolveExplorerSettings(next.explorer, workspace.root));
    // Избранное живёт в настройках: пришли новые — показываем их (список сверяется
    // у модели, поэтому писать его обратно по этому событию не нужно).
    explorer.setFavorites(next.workspace.favorites);
    // Лигатуры консоли следуют за лигатурами кода: вид обоих полотен остаётся единым.
    terminalPanel.setLigatures(next.editor.fontLigatures);
    chat.applySettings(next);
    settingsModal.applySettings(next);
    // Макет мог измениться (например, размеры панелей) — применяем без повторной записи.
    applyLayoutSettings(next.layout);
    // Ассистент выключили мастер-тумблером — закрываем его панель и обновляем шапку,
    // чтобы она не занимала место и не звала в выключенный чат. План считает чистый
    // модуль (`shared/ai-panel.ts`): тонкости порядка шагов закреплены тестами,
    // а не только этим комментарием.
    const panel = aiPanelPlan({
      wasEnabled: previous.ai.enabled,
      isEnabled: next.ai.enabled,
      rightVisible: layout.rightVisible,
      wantedRightVisible: next.layout.rightVisible,
    });
    // Свёрнутость — следствие тумблера, а не выбор человека: в настройки не пишем.
    if (panel.hide) withoutPersist(() => layout.setRightVisible(false));
    if (panel.toggle === 'enabled' && panel.show) {
      withoutPersist(() => layout.setRightVisible(true));
    }
    // Языковые серверы включили тумблером в настройках — подхватываем их и греем
    // сразу, не дожидаясь открытия файла: иначе подсказок не было бы до переоткрытия
    // файла. Выключение здесь ничего не делает: подъёмы прекращает сам main
    // (`startLanguage` смотрит на `lsp.enabled`).
    if (plan.warmLsp) refreshLsp();
    syncViewButtons();
    // Инструменты проекта зависят от настроек запуска: путь к интерпретатору
    // и менеджеру пакетов могли поменять — перепроверяем проект заново.
    void tools.refresh(workspace.root, true).then(() => {
      syncRunControl();
      refreshStatus();
    });
    // Сменили интерпретатор — перепроверяем импорты в открытых файлах. Сравнивается
    // весь блок `run`, а не только pythonPath: менеджер пакетов и venv меняют то же
    // самое окружение. Сравнение по значению, а не по ссылке (см. `settings-plan.ts`):
    // без этого смена темы заново обходила бы все открытые файлы.
    if (plan.imports) importChecker.refresh();
    // Схема могла прийти извне — догоняем редактор и терминал.
    theme.apply();
    refreshStatus();
  };

  dock.onVisibilityChange((visible) => {
    layout.setDockVisible(visible);
    if (visible) terminalPanel.fit();
    syncViewButtons();
  });

  /**
   * О расхождении с диском уже сказали: повторять на каждое событие наблюдателя
   * незачем. Из набора путь уходит, когда буфер снова совпал с диском, — тогда
   * следующий разлом стоит объяснить заново.
   */
  const diskDiffWarned = new Set<string>();
  documents.onDidChangeDirty((document) => {
    if (!document.dirty) diskDiffWarned.delete(document.path);
  });
  // Закрытая вкладка: набор не должен держать путь вечно — иначе после повторного
  // открытия о расхождении с диском уже не скажем.
  documents.onDidClose((document) => {
    diskDiffWarned.delete(document.path);
    // Режим разметки у закрытого файла больше не нужен.
    markdownPreviews.delete(document.path);
    // Прочитанную картинку и документ забываем: файл мог на диске и измениться.
    imageView.forget(document.path);
    docView.forget(document.path);
  });

  /**
   * Файл изменился на диске. Открытый документ перечитываем: иначе в редакторе
   * останется старая версия — например, после правки во внешнем инструменте или в
   * терминале. Несохранённые правки при этом НЕ теряются — решение принимает сам
   * `reloadFromDisk` (содержимое совпало — снимаем «грязность», разошлось — оставляем буфер).
   *
   * О разошедшемся буфере говорим вслух и сразу предлагаем перечитать: иначе пометка
   * «не сохранён» висит без объяснения, а Ctrl+S спрашивает про файл, которого человек
   * не трогал, — и непонятно, чьи правки в буфере и что с ними делать.
   */
  const reloadIfOpen = async (path: string): Promise<void> => {
    const document = documents.get(path);
    if (!document) return;
    // Картинка — не текст: перечитывать её в документ нельзя (в буфер попадёт
    // бинарь). Файл мог смениться на диске — об этом узнаёт вьюер, а не буфер.
    if (isImagePath(path)) {
      imageView.refresh(path);
      return;
    }
    // Документ Office — та же история: в буфер он не читается, обновится экран.
    if (isOfficePath(path)) {
      docView.refresh(path);
      return;
    }
    await edits.reloadFromDisk(path).catch(() => undefined);
    // Буфер остался правленым — значит версия на диске с ним разошлась: совпавший
    // текст снял бы «грязность» (см. `reloadFromDisk`).
    if (!document.dirty || diskDiffWarned.has(path)) return;
    diskDiffWarned.add(path);
    showToast(`Файл «${basename(path)}» изменился на диске: ваши правки в редакторе целы`, 'info', {
      action: {
        label: 'Перечитать',
        run: () => void commands.execute('file.revertFromDisk', path),
      },
    });
  };

  /**
   * Вернуть файлы к версии на диске: перечитать и отбросить правки в буфере.
   *
   * Спрашиваем всегда: правки в буфере — работа человека, терять их без спроса
   * нельзя. Файл, который и так равен диску, в список не идёт — там терять нечего.
   */
  const revertFilesToDisk = async (targets: readonly string[]): Promise<void> => {
    const dirty = targets.filter((target) => documents.get(target)?.dirty === true);
    if (dirty.length === 0) {
      showToast('Правок в буфере нет', 'info');
      return;
    }

    const prompt = revertPrompt(dirty);
    const { confirmed } = await rpc.request('dialog.confirm', {
      title: 'Перечитать с диска',
      message: prompt.message,
      detail: prompt.detail,
      confirmLabel: 'Отменить правки',
    });
    if (!confirmed) return;

    let done = 0;
    for (const target of dirty) {
      try {
        await edits.revertToDisk(target);
        done += 1;
      } catch {
        showToast(`Не удалось прочитать файл: ${basename(target)}`, 'error');
      }
    }
    if (done === 0) return;
    // Файл мог измениться и за пределами буфера (его переписал другой инструмент) —
    // поэтому вместе с документами обновляем и дерево.
    explorer.scheduleRefresh();
    showToast(done === 1 ? `Перечитано с диска: ${basename(dirty[0] ?? '')}` : `Перечитано с диска: файлов ${done}`);
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
        // Пометки TODO/FIXME могли появиться или пропасть — пересобираем список,
        // но только когда панель задач на виду: поиск по проекту — работа заметная.
        if (dock.visible && dock.activeId === 'todo') todoPanel.schedule();
        break;
      }
      case PushTopic.ApprovalReview: {
        // Проверка модели разрешила команду сама: строка в ленте говорит, что
        // спрашивать было некого, и почему команда прошла без карточки.
        const payload = message.payload as { command?: string; reason?: string };
        if (payload?.command) chat.noteApprovalReview(payload.command, payload.reason ?? '');
        break;
      }
      case PushTopic.SettingsChanged:
        baseSettings = message.payload as Settings;
        applySettings(rebuildSettings());
        break;
      case PushTopic.LspProgress:
        lspProgress.apply(message.payload as LspProgress);
        break;
      case PushTopic.BrowserNav: {
        const payload = message.payload as BrowserEventPayload;
        if (!payload || typeof payload !== 'object') break;
        // Страница просит новую вкладку (`_blank`, `window.open`): вторых окон у нас
        // нет — заводим вкладку в той же полосе.
        if (payload.kind === 'newTab') {
          browserTabs.open(payload.url);
          break;
        }
        // Страницу открыл агент: вложение уже есть, ключ дал main — забираем вкладку.
        if (payload.kind === 'opened') {
          browserTabs.adopt(payload.id, payload.url, true);
          break;
        }
        // Агент закончил: вкладка уходит вместе с вложением.
        if (payload.kind === 'closed') {
          browserPages.close(payload.id);
          break;
        }
        // Общий доступ к странице: агент работает в этой же вкладке.
        if (payload.kind === 'shared' || payload.kind === 'unshared') {
          browserView.setShared(payload.id, payload.kind === 'shared');
          break;
        }
        // Агент действует на странице: без метки его действия неотличимы от чужих.
        if (payload.kind === 'agent') {
          markAgentPage(payload.id, payload.action);
          break;
        }
        // Заголовок и адрес — в модель (их видит полоса), состояние — в шапку вкладки.
        browserTabs.update(payload.id, { url: payload.url, title: payload.title });
        browserView.update(payload.id, payload);
        break;
      }
      default:
        break;
    }
  });

  openEditors.onDidChange(() => {
    // Перешли к другому файлу: в этом режиме автосохранение пишет прежний прямо здесь.
    autoSave.activeDocumentChanged();
    refreshStatus();
    syncEmptyState();
    syncRunControl();
    // Файл стал активным — показываем его.
    if (openEditors.active) {
      // Страницы браузера тоже отступают: активен файл — показываем файл.
      browserTabs.deactivate();
    }
    // Активной могла стать картинка, документ Office или markdown в режиме разметки —
    // область пересчитывается целиком.
    applySurfaces();
    // Точки останова контроллер помнит по файлам, а редактор о них не знает:
    // при открытии вкладки отдаём ему набор — значки (с условиями) появятся сразу.
    for (const path of openEditors.paths) editors.setBreakpoints(path, debug.breakpointsOf(path));
    // Другая вкладка может быть другим кадром стека — значения в ней свои.
    void refreshDebugInlineValues();
  });
  // Счётчик правок и ветка в статусбаре живут по тому же снимку, что и дерево.
  git.onDidChange(refreshStatus);
  // История могла измениться (коммит, rebase) — кэш подписи blame устарел.
  git.onDidChange(() => blame.refresh());
  // Вместе с историей могли сдвинуться и полоски изменений: перечитываем HEAD.
  git.onDidChange(() => changeGutter.refresh());
  // Коммит и push, сделанные мимо IDE (в терминале или внешней программой),
  // меняют только `.git`, а рабочее дерево — нет: наблюдателя за этим может и
  // не быть. На возврат фокуса перечитываем состояние репозитория, чтобы пометки
  // в дереве и счётчик не отставали от жизни.
  window.addEventListener('focus', () => void git.refresh());
  /**
   * Автосохранение: пишет несохранённые файлы по режиму из настроек. Путь записи — тот же,
   * что у Ctrl+S (правки при сохранении и форматирование), но без вопроса и тостов на каждый
   * файл: пишет таймер, а не человек. Конфликт с диском автосохранение НЕ перезаписывает —
   * говорит один раз, что пропустило: молча терять чужую правку оно не вправе.
   */
  const autoSave = new AutoSave({
    mode: () => settings.editor.autoSave,
    delay: () => settings.editor.autoSaveDelayMs,
    save: async () => {
      const dirty = documents.dirty().filter((document) => !document.readOnly);
      if (dirty.length === 0) return;
      const skipped: string[] = [];
      for (const document of dirty) {
        const prepared = applySaveEdits(document.value, {
          trimTrailingWhitespace: settings.editor.trimTrailingWhitespace,
          insertFinalNewline: settings.editor.insertFinalNewline,
        });
        if (prepared !== document.value) document.setText(prepared, 'programmatic');
        if (settings.editor.formatOnSave) await formatDocument(document);
        try {
          const outcome = await edits.saveDocument(document);
          if (outcome === 'conflict') skipped.push(basename(document.path));
        } catch {
          // Не записалось — файл остался «грязным», следующая попытка повторит.
        }
      }
      if (skipped.length > 0) {
        showToast(`Автосохранение пропущено (файл изменён на диске): ${skipped.join(', ')}`, 'error');
      }
    },
  });
  // Реакция только на правку ЧЕЛОВЕКОМ: правки ассистента ложатся в буфер и пишутся своим
  // путём (см. «не записано на диск»), а загрузка с диска — не повод что-то записывать.
  documents.onDidChange(({ change }) => {
    if (change.source === 'user') autoSave.documentChanged();
  });
  // Окно ушло в фон: в этом режиме здесь и записываем — иначе работа останется в буфере.
  window.addEventListener('blur', () => autoSave.windowBlurred());

  documents.onDidChange(({ document }) => {
    refreshStatus();
    // Правка текста может добавить или убрать точку входа — значок запуска
    // обязан следовать за файлом, а не жить до перезапуска.
    syncRunControl();
    // Тестовый файл изменился — панель тестов сама решит, пересобирать ли дерево.
    testPanel.notifyChange(document.path);
    // Содержимое файла изменилось — полоски изменений в жёлобе пересчитываем.
    changeGutter.refreshContent();
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
      testTargetOf(tools.get(), node, selector, { platform: info.platform, disabledPlugins: pytestDisabledPlugins }),
    );
    showToast(`Запускаю тест ${name}`);
  });

  // Клик по полоске изменения в жёлобе: переходим на строку и показываем автора
  // (blame). Вместе со строкой blame это и есть «различие этой строки».
  editors.onChangeMarker(({ path, line }) => {
    if (!blame.enabled) blame.toggle();
    editors.reveal(path, line, 1);
  });

  // Клик по полю номеров строк — точка останова: контроллер держит набор, а
  // редактор рисует по нему значки. Один источник истины — контроллер.
  editors.onBreakpointToggle(({ path, line }) => {
    void debug.toggleBreakpoint(path, line).then((breakpoints) => editors.setBreakpoints(path, breakpoints));
  });

  // Меню жёлоба — точки останова и блоки изменений: состав и подтверждения
  // живут в `core/gutter-menus.ts`.
  const gutterMenus = createGutterMenus({
    git,
    debug,
    workspace,
    explorer,
    editors,
    documents,
    changeGutter,
    conditionInput,
    saveDocument,
    reloadIfOpen,
    confirm: (options) => rpc.request('dialog.confirm', options),
  });
  // Место последнего нажатия — для меню жёлоба: у события контекстного меню нет
  // координат окна, а меню ставится по месту нажатия.
  document.addEventListener('mousedown', (event) => gutterMenus.trackPointer(event.clientX, event.clientY), true);

  editors.onBreakpointMenu(gutterMenus.openBreakpointMenu);
  // Правый клик по полоске изменения: меню блока (индексировать, убрать, откатить).
  editors.onChangeStripMenu((hit) => void gutterMenus.openChangeStripMenu(hit));

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
    // Значения переменных в строках: на новом останове и шаге они пересчитываются.
    void refreshDebugInlineValues();
  });
  tools.onDidChange(() => {
    syncRunControl();
    refreshStatus();
  });
  workspace.onDidChange(({ info, reason }) => {
    refreshStatus();
    syncEmptyState();

    // Другая рабочая папка в ТОЙ ЖЕ области (добавили, убрали или переключили):
    // проект тот же, вкладки закрывать нельзя. Обновляем то, что считается по
    // активному корню, — окружение, структуру и запуск.
    if (reason === 'roots') {
      void (async () => {
        await tools.refresh(workspace.root);
        syncRunControl();
        await refreshScan();
        preloadEnvironment();
        // Смена активного корня может сменить языки проекта — греем их серверы.
        await lspServers.ensure();
        void lspServers.prewarm();
      })();
      // Активный корень сменился — у него может быть свой набор настроек дерева.
      explorer.applySettings(resolveExplorerSettings(settings.explorer, workspace.root));
      return;
    }

    // Новый проект виден только после кадра: два rAF — это «уже нарисовано»,
    // первый же срабатывает до отрисовки. Замер открыт в `workspace.open`.
    requestAnimationFrame(() => requestAnimationFrame(() => perf.end('project:paint')));

    // Сменился ПРОЕКТ: окружение нового греем сразу (попап открывается без ожидания).
    void (async () => {
      await tools.refresh(workspace.root);
      syncRunControl();
      await refreshScan();
      preloadEnvironment();
      // У нового проекта мог появиться свой сервер в окружении (pylsp в его venv):
      // сначала подхватываем серверы, затем греем языки проекта.
      await lspServers.ensure();
      lspServers.prewarm();
    })();
    // Другой проект — другое рабочее место: восстанавливаем его из сессии,
    // затем накладываем настройки и макет проекта из .chui_ide.
    if (info) {
      void session.restore(info.root).then(() => loadProjectConfig(info.root));
    } else {
      session.setRoot(null);
      resetProjectConfig();
    }
  });
  editors.onCursorChange((state) => {
    statusBar.update({ line: state.line, column: state.column });
    // Строка под курсором сменилась — обновляем подпись blame (если показ включён).
    blame.update(state.path, state.line);
    // Смена файла — повод пересчитать его полоски изменений (содержимое — ниже).
    if (state.path !== gutterPath) {
      gutterPath = state.path;
      changeGutter.refreshContent();
    }
  });
  // Разделение меняют и кнопка, и команда — подсветка кнопки идёт за состоянием.
  editors.onDidChangeSplit(() => {
    syncViewButtons();
    // Во второй панели может оказаться другой файл — его полоски тоже нужны.
    changeGutter.refresh();
  });
  // Счётчик проблем: пометки приходят из нескольких источников (LSP,
  // проверка импортов), поэтому слушаем одно событие сервиса и пересчитываем всё.
  editors.onDidChangeMarkers(() => {
    statusBar.update({ problems: editors.problemCounts() });
    // Значок вкладки и список проблем читают те же пометки: обновляем их вместе.
    dock.refreshBadges();
    if (dock.visible && dock.activeId === 'problems') problemPanel.refresh();
  });

  theme.onDidChange(() => {
    editors.refreshTheme();
    terminalPanel.refreshTheme();
    refreshHighlight();
  });
  theme.apply();
  // Полоски изменений для уже открытых файлов — если при старте что-то открыто.
  changeGutter.refresh();

  new KeybindingService(commands, DEFAULT_KEYBINDINGS, () => settings.keybindings.overrides).attach(window);

  // Проект мог быть открыт ещё в стартовом окне: main помнит корень, и окно IDE
  // забирает его себе, чтобы не спрашивать папку второй раз. Делаем это после
  // подписок — иначе дерево, панель изменений и статусбар не узнают об открытии.
  const current = await rpc.request('workspace.current');
  if (current.root) await workspace.open(current.root);

  await tools.refresh(workspace.root);
  await refreshScan();
  await lspServers.ensure();
  // Состав серверов читаем сразу: чип в статусбаре покажет, что поднято и откуда.
  void refreshLspStatus();
  // И греем серверы языков проекта, не дожидаясь открытия файлов: подсказки,
  // переходы и поиск по символам готовы сразу (см. `prewarmLsp`).
  lspServers.prewarm();
  // Карта символов могла начать собираться ещё до окна (проект открыли раньше) — спросим
  // о ней сразу, не дожидаясь прогрева серверов: виджет в полосе состояния не должен
  // появляться только по счастливой случайности.
  refreshSymbolIndex();
  syncRunControl();
  // Окружение читаем тут же: к первому клику по чипу попап уже наполнен.
  preloadEnvironment();

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
      tools,
    };
  }
}

/**
 * Конец текста в понятиях «строка и столбец» (оба с единицы) — для диапазона запросов,
 * которым серверу нужен весь документ (подсказки-вставки). Строк n, столбец — за
 * последним знаком последней строки.
 */
function endOfText(text: string): { line: number; column: number } {
  const lines = text.split('\n');
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}
