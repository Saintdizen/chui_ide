import {
  PushTopic,
  type DebugLaunchOptions,
  type LayoutSettings,
  type LspServerConfig,
  type Settings,
  type SettingsPatch,
  type WorkspaceChangedPayload,
} from '../shared/api';
import { PROJECT_SETTINGS_SECTIONS, mergeDeep, type ProjectSettings } from '../shared/project-config';
import { menuChecks } from '../shared/app-menu';
import { lspLanguagesForKind, mergeLspServers } from '../shared/lsp-presets';
import { lspChipFor, NO_LSP_STATUS, type LspStatus } from '../shared/lsp-status';
import type { FileOperation } from '../shared/lsp-workspace-edit';
import { progressLabel, type LspProgress, type WorkProgress } from '../shared/lsp-progress';
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
import { BookmarkModel } from './core/bookmarks';
import { SpellCheck } from './core/spellcheck';
import { ProjectPackagesModel } from './core/project-packages';
import { parseCoverageJson } from '../shared/coverage-json';
import { parseNodeCoverage } from '../shared/node-coverage';
import { diagnoseHighlighting, setHighlightScheme } from './core/highlight';
import { KeybindingService } from './core/keybindings';
import { DEFAULT_KEYBINDINGS } from './core/default-keybindings';
import { languageFromPath, languageLabel, languageIndent } from './core/languages';
import { ImportChecker } from './core/import-check';
import { LspClient } from './core/lsp';
import { fetchCallHierarchy, type CallDirection } from './core/call-hierarchy';
import { fetchTypeHierarchy, type TypeDirection } from './core/type-hierarchy';
import { OpenEditors } from './core/open-editors';
import { AutoPanelLayout } from './core/panel-layout';
import { ProjectToolsModel } from './core/project-tools';
import { envWidgetLabel } from './core/env-widget';
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
import { codeActionKindLabel, type CodeActionItem } from '../shared/lsp-code-actions';
import { refactorLabel, type RefactorAction } from '../shared/lsp-refactor';
import { installSuggestions } from '../shared/import-install';
import { indentFoldRanges, mergeFoldRanges } from '../shared/fold-ranges';
import { surroundOptions } from './editor/input/surround';
import { semanticFoldRanges } from './editor/highlight/folds';
import { packageForModule } from '../shared/python-packages';
import { fetchResultsSummary } from '../shared/git-multiroot';
import { toWorkspaceFileEdits } from '../shared/lsp-workspace-edit';
import { applySaveEdits } from '../shared/save-edits';
import { applyTextEdits, fromOffset } from '../shared/edits';
import { decideSaveAs } from '../shared/save-as';
import { isEmptyCommitMessage } from '../shared/commit-message';
import { pairFromSelection } from './core/file-compare';
import { hunkAtLine } from '../shared/hunk-lines';
import { isInsidePath, joinPath, pathAfter, separatorOf, splitPath } from '../shared/paths';
import { copyPlan, movePlan } from './core/tree-move';
import { ThemeService } from './core/theme-service';
import { WindowFrame } from './core/window-frame';
import { WorkspaceModel } from './core/workspace-model';
import { showApplicationMenu } from './ui/app-menu';
import { showContextMenu } from './ui/context-menu';
import { createBreadcrumbs } from './ui/breadcrumbs';
import { createChatPanel } from './ui/chat';
import { createDock } from './ui/dock';
import { createConflictView } from './ui/conflict-view';
import { createDiffView } from './ui/diff-view';
import { basename, clear, h, svgIcon, type IconName } from './ui/dom';
import { createEmptyState } from './ui/empty-state';
import { createExplorer } from './ui/explorer';
import { createLaunchOptionsModal } from './ui/launch-options-modal';
import { createLayout } from './ui/layout';
import { createLspPopover, type LspPopoverView } from './ui/lsp-popover';
import { createMarkdownPreview } from './ui/markdown-preview';
import { createNotebookPanel } from './ui/notebook-panel';
import { logoMark } from './ui/logo';
import { createNodeEnvPopover, type NodeEnvPopoverView } from './ui/node-env-popover';
import { createOutline } from './ui/outline';
import { createProblemPanel } from './ui/problem-panel';
import { problemBadgeText } from '../shared/problem-list';
import { formatDuration, highlightedLines, hottestLines, profileSummary } from '../shared/line-profile';
import { TODO_QUERY, toTodoItems } from '../shared/todo-list';
import { createPalette } from './ui/palette';
import { createPopover, type PopoverView } from './ui/popover';
import { createPythonEnvPopover, type PythonEnvPopoverView } from './ui/python-env-popover';
import { createMeaningSearch } from './ui/meaning-search';
import { createQuickOpen } from './ui/quick-open';
import { createSymbolPicker } from './ui/symbol-picker';
import { isEmptyTest, suggestTestPath, truncateTestCode } from '../shared/test-generation';
import { closePopupMenu, isPopupOpen, showPopupMenu, type PopupMenuItem } from './ui/popup-menu';
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
import { createForgeModal } from './ui/forge-modal';
import { createIssuesModal } from './ui/issues-modal';
import { createPipelinesModal } from './ui/pipelines-modal';
import { createTextModal } from './ui/text-modal';
import { createStatusBar } from './ui/statusbar';
import { createSettingsModal } from './ui/settings-modal';
import { createTabs } from './ui/tabs';
import { createTerminalPanel } from './ui/terminal';
import { createDebugPanel } from './ui/debug-panel';
import { createTestPanel } from './ui/test-panel';
import { createTodoPanel } from './ui/todo-panel';
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
  // Версию приложения печатаем при старте: по ней видно, на чём воспроизводят проблему.
  console.info(
    `[chui] v${info.appVersion} · Electron ${info.electron} · Chromium ${info.chrome}`,
    `· Node ${info.node} · ${info.platform}`,
  );

  // Тема: main — источник истины, сервис знает и выбор пользователя, и фактическую схему.
  const theme = new ThemeService(rpc, settings.appearance.theme, settings.appearance.customTheme ?? null);

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
   * Редактор — своё ядро (`src/renderer/editor/`), без Monaco. Всё, что раньше навешивалось
   * на движок (подсказки LSP, inline-AI, сниппеты, Ctrl+Click), приходит сюда опциями:
   * у рабочего места для каждого из них есть шов.
   */
  const editors = new EditorWorkspace(layout.editorHost, new DocumentRegistry(documents), {
    scheme: theme.resolved,
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
      enabled: () => settings.ai.inlineCompletion.enabled,
      debounceMs: () => settings.ai.inlineCompletion.debounceMs,
      complete: async ({ path, language, prefix, suffix }) => {
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
    codeActions: (path, position) => void runCodeActions(path, position),
    // Свёртка: диапазоны берём у сервера, а если он их не умеет — считаем по отступам.
    // Свёртка: сперва сервер (он видит блоки смыслово). Нет сервера — считаем сами:
    // по грамматике (скобки, блочные комментарии, длинные строки) и по отступам.
    // Два своих источника складываем: скобки накрывают C-подобный код, отступы —
    // то, что блоками не описано (Python, YAML, тексты).
    foldRanges: async (path, text) => {
      const fromServer = await lsp.foldingRanges(path);
      if (fromServer.length > 0) return fromServer;
      const grammar = semanticFoldRanges(text, languageFromPath(path));
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
    // Правый клик по тексту: меню собираем здесь, а не в панели, — пункты это команды
    // приложения (отмена, буфер обмена, поиск, переходы), и реестр команд у него.
    contextMenu: (info, event) => {
      const items: PopupMenuItem[] = [
        { label: 'Отменить', hint: 'Ctrl+Z', onSelect: () => editors.runAction('editor.undo') },
        { label: 'Повторить', hint: 'Ctrl+Y', onSelect: () => editors.runAction('editor.redo') },
        { separator: true },
      ];
      if (info.hasSelection) {
        items.push(
          { label: 'Вырезать', hint: 'Ctrl+X', onSelect: () => editors.cutToClipboard() },
          { label: 'Копировать', hint: 'Ctrl+C', onSelect: () => editors.copyToClipboard() },
        );
      }
      items.push(
        { label: 'Вставить', hint: 'Ctrl+V', onSelect: () => editors.pasteFromClipboard() },
        { separator: true },
        { label: 'Выделить всё', hint: 'Ctrl+A', onSelect: () => editors.runAction('editor.selectAll') },
        { separator: true },
        { label: 'Увеличить отступ', hint: 'Tab', onSelect: () => editors.runAction('editor.indent') },
        { label: 'Уменьшить отступ', hint: 'Shift+Tab', onSelect: () => editors.runAction('editor.outdent') },
        { separator: true },
        { label: 'Найти', hint: 'Ctrl+F', onSelect: () => editors.runAction('editor.find') },
        { label: 'Найти и заменить', hint: 'Ctrl+H', onSelect: () => editors.runAction('editor.replace') },
        { label: 'Перейти к строке', hint: 'Ctrl+G', onSelect: () => editors.runAction('editor.gotoLine') },
      );
      // Переходы по символу и переименование доступны только с языковым сервером:
      // без него этих команд в каталоге редактора нет — и пункты не показываем.
      if (editors.listActions().some((action) => action.id === 'editor.goToDefinition')) {
        items.push(
          { separator: true },
          { label: 'Перейти к определению', onSelect: () => editors.runAction('editor.goToDefinition') },
          { label: 'Заглянуть в определение', onSelect: () => editors.runAction('editor.peekDefinition') },
          { label: 'Найти все ссылки', onSelect: () => editors.runAction('editor.references') },
          { label: 'Переименовать символ', onSelect: () => editors.runAction('editor.renameSymbol') },
        );
        // Рефакторинги тоже делает сервер. Извлечение — только по выделению: пункт есть,
        // когда есть что выносить.
        const refactorPath = info.path;
        if (refactorPath) {
          items.push({ label: 'Рефакторинг…', onSelect: () => void runRefactorMenu(refactorPath) });
          if (info.hasSelection) {
            items.push({ label: 'Извлечь…', onSelect: () => void runRefactor(refactorPath, 'extract') });
          }
          items.push({ label: 'Развернуть (inline)…', onSelect: () => void runRefactor(refactorPath, 'inline') });
        }
      }
      // Закладка ставится на конкретную строку, поэтому и пункт есть только у файла.
      const bookmarkPath = info.path;
      if (bookmarkPath) {
        const bookmarked = bookmarks.isBookmarked(bookmarkPath, info.line);
        items.push(
          { separator: true },
          {
            label: bookmarked ? 'Убрать закладку' : 'Поставить закладку',
            onSelect: () => bookmarks.toggle(bookmarkPath, info.line),
          },
          { label: 'Закладки…', hint: 'Ctrl+Alt+B', onSelect: () => bookmarksModal.open() },
        );
      }
      // Орфография: пункты есть, только когда под курсором слово с ошибкой.
      if (editors.spellingWordAtCursor()) {
        items.push(
          { separator: true },
          { label: 'Добавить в словарь', onSelect: () => editors.addSpellingWordToDictionary() },
          { label: 'Пропустить слово', onSelect: () => editors.ignoreSpellingWord() },
        );
      }
      // Быстрые исправления: пункт есть там, где он что-то даст — с языковым сервером.
      if (info.path && editors.listActions().some((action) => action.id === 'editor.codeActions')) {
        items.push({
          label: 'Быстрые исправления…',
          hint: 'Ctrl+.',
          onSelect: () => void runCodeActions(info.path!, { line: info.line, column: info.column }),
        });
      }
      showContextMenu(items, event.clientX, event.clientY);
    },
  });
  const edits = new EditService({ documents, editors, rpc });

  /**
   * Наши быстрые правки: поставить не установленный пакет. Своя проверка импортов
   * (`core/import-check.ts`) знает, чего не хватает, а перевод «модуль → пакет» — таблица
   * Python (`yaml` → `PyYAML`). У языков разные пути установки: Python идёт `pip` в своё
   * окружение, Node — менеджером проекта в терминале.
   */
  const importInstallActions = (path: string, position: { line: number; column: number }): PopupMenuItem[] => {
    const language = documents.get(path)?.languageId ?? '';
    const python = language === 'python';
    if (!python && language !== 'javascript' && language !== 'typescript') return [];
    const refs = importChecker.missingFor(path);
    if (refs.length === 0) return [];
    // Ориентируемся на строку под курсором: имя модуля берём из импорта, а не из позиции.
    const suggestions = installSuggestions(refs, new Set([position.line]), python ? packageForModule : undefined);
    return suggestions.map((item) => ({
      label: `Установить пакет «${item.package}»`,
      hint: 'быстрое исправление',
      onSelect: () => void (python ? installPythonPackages([item.package]) : installNodePackages([item.package])),
    }));
  };

  /**
   * Быстрые исправления под курсором: спросить сервер, показать список у каретки,
   * применить выбранное. Правки идут через документную модель — значит с undo; команда
   * сервера выполняется там, где он живёт.
   */
  const runCodeActions = async (path: string, position: { line: number; column: number }): Promise<void> => {
    // Контекст запроса — пометки ЭТОЙ строки: сервер отвечает исправлениями на них.
    const diagnostics = editors.lspDiagnostics(path).filter((item) => item.line === position.line);
    const actions = await lsp.codeActions(path, position, diagnostics);
    // Свои правки идут вперёд: они отвечают на наши же пометки и понятнее серверных.
    const items: PopupMenuItem[] = [
      ...importInstallActions(path, position),
      ...actions.map((action) => ({
        label: action.title,
        hint: codeActionKindLabel(action.kind),
        onSelect: () => void applyCodeAction(path, action),
      })),
    ];
    if (items.length === 0) {
      showToast('Быстрых исправлений здесь нет');
      return;
    }
    // Список ставим у каретки — как список подсказок: глаз уже там, где он печатает.
    const point = editors.caretPoint();
    showPopupMenu(items, point?.left ?? 0, (point?.bottom ?? 0) + 2);
  };

  /** Применить выбранное действие: его правки и/или команду сервера. */
  const applyCodeAction = async (path: string, action: CodeActionItem): Promise<void> => {
    if (action.edits) {
      const result = await edits.applyFileEdits(action.edits);
      if (result.failed.length > 0) showToast(result.failed[0]!.message, 'error');
    }
    if (!action.command) return;
    await runLensCommand(path, action.command);
  };

  /**
   * Упорядочить импорты файла: сервер один знает, что лишнее и чего не хватает, —
   * просим действие `source.organizeImports` и применяем его правки обычным путём.
   */
  const runOrganizeImports = async (path: string): Promise<void> => {
    const document = documents.get(path);
    if (!document) return;
    const actions = await lsp.organizeImports(path, { line: document.lineCount, column: 1 });
    const action = actions.find((item) => item.edits);
    if (!action) {
      showToast('Упорядочить импорты сервер не предложил');
      return;
    }
    await applyCodeAction(path, action);
  };

  /**
   * Извлечение и «разворачивание» (inline) — рефакторинги, которые умеет только языковой
   * сервер. Просим у него действие нужного вида и применяем выбранное: извлечение — по
   * выделению, разворачивание — по символу под кареткой.
   */
  const runRefactor = async (path: string, action: RefactorAction): Promise<void> => {
    const document = documents.get(path);
    if (!document) return;
    if (document.readOnly) {
      showToast('Файл открыт только для чтения — рефакторинг не применить');
      return;
    }
    const range = editors.selectionRange();
    // Извлечению нужен участок: по пустому выделению выносить нечего.
    const empty = range.startLine === range.endLine && range.startColumn === range.endColumn;
    if (action === 'extract' && empty) {
      showToast('Выделите выражение, которое надо извлечь');
      return;
    }
    const actions = await lsp.refactor(path, range, action);
    if (actions.length === 0) {
      showToast(`Сервер ${refactorLabel(action)} не предложил`);
      return;
    }
    // Одно действие — применяем сразу; несколько (в переменную и в функцию) — выбираем.
    const [first] = actions;
    if (actions.length === 1 && first) {
      await applyCodeAction(path, first);
      return;
    }
    const point = editors.caretPoint();
    showPopupMenu(
      actions.map((entry) => ({
        label: entry.title,
        hint: codeActionKindLabel(entry.kind),
        onSelect: () => void applyCodeAction(path, entry),
      })),
      point?.left ?? 0,
      (point?.bottom ?? 0) + 2,
    );
  };

  /**
   * Общий список рефакторингов: что сервер предлагает для выделения или символа под
   * кареткой, то и показываем — извлечение, разворачивание и всё прочее из раздела
   * `refactor` (вынести в файл, преобразовать…). Отдельные команды для извлечения и
   * inline при этом остаются: они сразу прыгают в конкретный подвид, минуя выбор.
   */
  const runRefactorMenu = async (path: string): Promise<void> => {
    const document = documents.get(path);
    if (!document) return;
    if (document.readOnly) {
      showToast('Файл открыт только для чтения — рефакторинг не применить');
      return;
    }
    const actions = await lsp.refactorActions(path, editors.selectionRange());
    if (actions.length === 0) {
      showToast('Сервер рефакторингов не предложил');
      return;
    }
    // Один — применяем сразу, без списка из одной строки; несколько — выбираем.
    const [first] = actions;
    if (actions.length === 1 && first) {
      await applyCodeAction(path, first);
      return;
    }
    const point = editors.caretPoint();
    showPopupMenu(
      actions.map((entry) => ({
        label: entry.title,
        hint: codeActionKindLabel(entry.kind),
        onSelect: () => void applyCodeAction(path, entry),
      })),
      point?.left ?? 0,
      (point?.bottom ?? 0) + 2,
    );
  };

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
   * Попап Python-окружения у кнопки в статусбаре: что выбрано и откуда. Создаём
   * лениво, но прогреваем снимок при открытии проекта (см. preloadEnvironment);
   * список обновляем ещё и при каждом открытии — попап мог провисеть долго.
   */
  let pythonEnvPopover: PopoverView | null = null;
  let pythonEnvView: PythonEnvPopoverView | null = null;

  function ensurePythonEnv(): PythonEnvPopoverView {
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
          // Сервер подсказок поднят со старым интерпретатором — перезапускаем; у
          // выбранного окружения могло найтись и своё (pylsp в его `bin`).
          refreshLsp();
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
    return pythonEnvView;
  }

  function openPythonEnv(anchor: HTMLElement): void {
    // Снимок обновляем при каждом открытии: попап мог провисеть долго (см. refresh).
    void ensurePythonEnv().refresh();
    pythonEnvPopover?.toggle(anchor);
  }

  /**
   * Попап Node-окружения по клику на чип «Node.js»: чем запускается код, чем
   * ставятся зависимости и всё ли из `package.json` на месте. Снимок греем при
   * открытии проекта (см. preloadEnvironment), а при открытии попапа обновляем.
   */
  let nodeEnvPopover: PopoverView | null = null;
  let nodeEnvView: NodeEnvPopoverView | null = null;

  function ensureNodeEnv(): NodeEnvPopoverView {
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
    return nodeEnvView;
  }

  function openNodeEnv(anchor: HTMLElement): void {
    void ensureNodeEnv().refresh();
    nodeEnvPopover?.toggle(anchor);
  }

  /**
   * Попап языковых серверов по клику на чип в статусбаре: какой сервер обслуживает
   * язык, откуда он взят и что не поднялось. Так «почему нет подсказок» видно сразу.
   */
  let lspPopover: PopoverView | null = null;
  let lspPopoverView: LspPopoverView | null = null;

  function ensureLspPopover(): LspPopoverView {
    if (!lspPopover || !lspPopoverView) {
      lspPopoverView = createLspPopover({
        rpc,
        onRestart: () => {
          lspPopover?.close();
          void commands.execute('lsp.restart');
        },
        onOpenSettings: () => {
          lspPopover?.close();
          settingsModal.open('lsp');
        },
      });
      lspPopover = createPopover(lspPopoverView.element, { width: 340, align: 'end' });
      lspPopover.element.classList.add('popover-lsp-status');
    }
    return lspPopoverView;
  }

  function openLsp(anchor: HTMLElement): void {
    void ensureLspPopover().refresh();
    lspPopover?.toggle(anchor);
  }

  /**
   * Окружение проекта читаем при его открытии, а не только по клику на чип: иначе
   * попап открывался бы с пустым телом, пока данные едут. Греем ровно то, что
   * может открыться: чип в статусбаре один — у Node-проекта он про Node, иначе про
   * интерпретатор Python (см. envWidgetLabel). Попап обновляет снимок сам при
   * открытии, поэтому устаревания тут не боимся — прогрев лишь убирает ожидание.
   */
  let preloadedProject = '';

  function preloadEnvironment(): void {
    const kind = projectScan?.kind.id ?? null;
    if (!envWidgetLabel(kind, tools.get(), settings.run.pythonPath)) return;
    // Прогрев — один на проект: открытие стартового проекта приходит и подпиской
    // на workspace, и начальным кодом, и без этой метки окружение читалось бы дважды.
    const signature = `${workspace.root ?? ''}|${kind ?? ''}`;
    if (signature === preloadedProject) return;
    preloadedProject = signature;
    if (kind === 'node') void ensureNodeEnv().refresh();
    else void ensurePythonEnv().refresh();
  }

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
    scheme: theme.resolved,
    // Лигатуры консоли — те же, что у кода: единый вид обоих полотен.
    ligatures: () => settings.editor.fontLigatures,
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
    return pytestTarget(tools.get(), selector, {
      ...options,
      platform: info.platform,
      disabledPlugins: pytestDisabledPlugins,
    });
  };

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
  // Предпросмотр Markdown: разметка активного файла. Рисует её тот же разборщик,
  // что ленту чата, — безопасно (без `innerHTML`) и с той же подсветкой кода.
  const markdownPreview = createMarkdownPreview({
    openEditors,
    documents,
    insertCode: (code) => editors.insertAtCursor(code),
    relativePath: (path) => workspace.relative(path),
    isVisible: () => dock.activeId === 'preview',
  });
  dock.register({
    id: 'preview',
    title: 'Markdown',
    element: markdownPreview.element,
    onShow: () => markdownPreview.refresh(),
  });

  // Ячейки ноутбука: `.ipynb` показан ячейками (markdown отрисован, код — блоком),
  // а «Сравнить с HEAD» сопоставляет их с версией из git по ячейкам, не по строкам JSON.
  const notebookPanel = createNotebookPanel({
    activePath: () => editors.currentPath,
    readText: (path) => documents.get(path)?.value ?? null,
    readHead: (path) => git.headText(path),
    relativePath: (path) => workspace.relative(path),
    isVisible: () => dock.activeId === 'notebooks',
  });
  dock.register({
    id: 'notebooks',
    title: 'Ячейки',
    element: notebookPanel.element,
    onShow: () => notebookPanel.refresh(),
  });
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
    // Открытие файла — тем же путём, что у дерева и быстрого открытия: клик по
    // файлу в ленте чата открывает вкладку, а не только ставит курсор.
    openFile: (path) => openPath(path),
    toggleEditor: () => setChatInEditor(!chatInEditor),
    isInEditor: () => chatInEditor,
  });
  layout.rightBody.appendChild(chat.element);
  // Статус ассистента (режим и заполнение контекста) живёт в общей полосе окна:
  // композер отдаёт готовую строку, статус-бар принимает её в свой слот.
  statusBar.chatSlot.appendChild(chat.statusElement);

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

  // Путь к файлу живёт в строке состояния: крошки рисуют его сегментами и
  // заменяют прежнюю ссылку на файл — одно дублировало другое.
  const breadcrumbs = createBreadcrumbs({ openEditors, documents, workspace, commands });
  statusBar.fileSlot.appendChild(breadcrumbs);

  const runControl = createRunButton((target) => void runTarget(target));
  // Имя открытого файла в центре шапки: показывается, когда кнопки запуска нет.
  const topBarName = h('span', { class: 'topbar-name' });

  /* ── запуск ────────────────────────────────────────────────────────────── */

  /** Чем запускать код и какие задачи есть в проекте: спрашиваем один раз на корень. */
  const tools = new ProjectToolsModel(rpc, () => settings.run, info.platform);
  /** Подпись последнего нарисованного значка запуска: не трогаем украшения зря. */
  let runMarkerSignature = '';
  /** Про выключенные подсказки говорим один раз за сеанс — иначе это стал бы шум. */
  let lspHintShown = false;
  /** Подсказку «сервера для языка проекта нет» показываем один раз за сеанс. */
  let lspMissingHintShown = false;

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
   * Языковые серверы: дополнить настроенные найденными.
   *
   * Список может пополниться не только «с нуля»: сервер появляется позже — его
   * поставили в только что созданное окружение проекта. Поэтому выходим не на
   * непустом списке, а сверяем языки: чего в списке нет, а в системе нашлось —
   * добавляем (`mergeLspServers`). Настроенные записи не трогаем: в них решения
   * человека — свой путь, свои аргументы, выключенный сервер.
   *
   * Ничего не запускаем: только проверяем, что команда есть (PATH и главное
   * окружение проекта).
   *
   * Возвращает признак «список пополнился»: после этого серверы нужно
   * перезапустить, иначе новый так и не поднимется.
   */
  /**
   * Сервера для языка проекта нет — сказать об этом и предложить настройку.
   * Один раз за сеанс: на каждое обновление окружения это стало бы шумом.
   *
   * Молчать тут нельзя: без сервера не работают подсказки, переход к определению
   * и подсветка пометок, а человек считает, что «IDE не умеет» вместо «нет сервера».
   */
  function suggestLspIfMissing(found: LspServerConfig[]): void {
    if (lspMissingHintShown) return;
    const kind = projectScan?.kind.id ?? null;
    const languages = lspLanguagesForKind(kind);
    if (!languages) return;
    if (found.some((server) => languages.includes(server.language))) return;
    lspMissingHintShown = true;
    showToast(
      kind === 'python'
        ? 'Языковой сервер для Python не найден: переходы и подсказки работать не будут'
        : 'Языковой сервер для JS/TS не найден: переходы и подсказки работать не будут',
      'info',
      { action: { label: 'Поставить', run: () => settingsModal.open('lsp') } },
    );
  }

  async function ensureLspServers(): Promise<boolean> {
    // Мастер-тумблер — решение человека: в обход него серверы не подставляем и не
    // запускаем. Но если серверы в проекте есть, а подсказки выключены, сказать об
    // этом стоит — иначе причину ищут в окружении, а не в настройке. Один раз за
    // сеанс: на каждое окружение это стало бы шумом.
    if (!settings.lsp.enabled) {
      if (!lspHintShown) {
        // Флаг занимаем ДО await: два вызова накладываются (загрузка и смена проекта),
        // и если ставить его после ответа, оба успеют показать по уведомлению.
        lspHintShown = true;
        const available = await rpc.request('lsp.detect').catch(() => []);
        if (available.length > 0) {
          showToast('Языковые серверы установлены, но выключены в настройках', 'info', {
            action: { label: 'Открыть', run: () => settingsModal.open('lsp') },
          });
        } else {
          // Серверов нет — уведомления не было; пусть скажем позже, когда появятся.
          lspHintShown = false;
        }
      }
      return false;
    }

    const found = await rpc.request('lsp.detect').catch(() => []);
    suggestLspIfMissing(found);
    const configured = settings.lsp.servers;
    const merged = mergeLspServers(configured, found);
    if (merged.length === configured.length) return false;

    // Дописанное всегда идёт в хвосте (см. `mergeLspServers`) — по длине исходного
    // списка видно, что именно подключилось, и об этом стоит сказать.
    const added = merged.slice(configured.length).map((server) => server.language);
    await rpc.request('settings.update', { lsp: { servers: merged } }).catch(() => undefined);
    showToast(`Языковые серверы подключены: ${added.join(', ')}`);
    return true;
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
      .then((status) => {
        // Перезапуск снял и «не поднялось» — обновляем чип сразу ответом, а серверы
        // поднимутся следом, когда уйдут `lsp.open` (тогда переспросим ещё раз).
        applyLspStatus(status);
        for (const document of documents.all()) {
          void rpc.request('lsp.open', {
            path: document.path,
            languageId: document.languageId,
            text: document.value,
          });
        }
        window.setTimeout(() => void refreshLspStatus(), 1500);
      })
      .catch(() => undefined);
  }

  /**
   * Подхватить появившиеся серверы и перезапустить уже настроенные.
   *
   * Одно без другого бессмысленно: без перезапуска новый сервер не поднимется, а
   * без перезапуска со сменившимся окружением старый останется с прошлым
   * интерпретатором. Поэтому порядок один и тот же во всех случаях, когда
   * окружение могло измениться: сначала дополнить список, потом перезапуск.
   */
  function refreshLsp(): void {
    void ensureLspServers().then(() => reopenLsp());
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
    viewButtons.get('split')?.classList.toggle('is-active', editors.isSplit);
    // Выключенный AI прячем из шапки: неактивная кнопка всё равно звала бы в чат.
    const aiButton = viewButtons.get('ai');
    if (aiButton) {
      aiButton.hidden = !aiEnabled();
      aiButton.classList.toggle('is-active', aiEnabled() && chatVisible());
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
  // Переключатель боковой панели стоит рядом с меню: он про то же — что открыто слева.
  // Раньше для него была отдельная полоса иконок у края окна.
  addTopButton(layout.topBarLeft, 'project', 'panel', 'Боковая панель (Ctrl+B)', 'view.toggleSidebar');

  // Действия шапки. Слева — то, что показывает содержимое: файлы, поиск,
  // терминал. Справа — служебное: ассистент, палитра, настройки, тема.
  addTopButton(layout.topBarLeft, 'save', 'save', 'Сохранить всё (Ctrl+Shift+S)', 'file.saveAll');
  addTopButton(layout.topBarLeft, 'search', 'search', 'Поиск по проекту (Ctrl+Shift+F)', 'search.project');
  addTopButton(layout.topBarLeft, 'terminal', 'terminal', 'Терминал (Alt+F12)', 'view.showTerminal');
  // Разделение области редактора: два файла рядом. Кнопка помнит состояние.
  addTopButton(layout.topBarLeft, 'split', 'split', 'Разделить редактор (Ctrl+\\)', 'view.splitEditor');

  // Центр шапки отдан главному: кнопке запуска, а когда запускать нечего — имени
  // открытого файла (см. syncRunControl). Одно сменяет другое, пустоты не бывает.
  layout.topBarTitle.append(topBarName, runControl.element);

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

  const openPath = async (path: string, options: { preview?: boolean } = {}): Promise<void> => {
    const document = await edits.ensureDocument(path);
    openEditors.open(document, options);
    editors.open(document);
    explorer.reveal(path);
    // Открыли файл — на экране он, вкладка чата ждёт в полосе.
    hideChatTab();
  };

  /**
   * Клик по ссылке в коде. Адрес ведёт наружу (системным обработчиком), файл — в редактор;
   * относительный путь считаем от папки файла, где стоит ссылка.
   */
  /**
   * Применить операции с файлами из `WorkspaceEdit` сервера (создать, переименовать,
   * удалить) — по порядку. Возвращает текст ошибки или null. «Пропустить молча» уважаем:
   * сервер этим говорит, что отсутствие файла/существование цели — не беда.
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
        if (operation.kind === 'create' && operation.ignoreIfExists) continue;
        if (operation.kind === 'delete' && operation.ignoreIfNotExists) continue;
        const what = operation.kind === 'rename' ? `${operation.from} → ${operation.to}` : operation.path;
        return `Не удалось выполнить операцию с файлом ${what}: ${String(error)}`;
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
    // Настройку могли ещё не прочитать: отсутствие значения — это «сохранять»,
    // как и умолчание main, а не «не сохранять».
    if (settings.git.saveBeforeCommit === false) return true;
    const dirty = documents.dirty();
    if (dirty.length === 0) return true;
    for (const document of dirty) {
      if (!(await saveDocument(document))) return false;
    }
    // Файлы на диске только что изменились, а снимок статуса git у нас ещё прежний:
    // без пересчёта коммит решил бы, что правок нет (его модель помнит старый ответ).
    await git.refresh().catch(() => undefined);
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
   */
  let closing = false;
  const confirmClose = async (): Promise<void> => {
    closing = true;
    try {
      const files = documents.dirty();
      if (files.length === 0) return;
      const { choice } = await rpc.request('dialog.confirmClose', { files: files.map((file) => file.path) });
      if (choice === 'cancel') return;
      if (choice === 'save') {
        for (const file of files) {
          // Отмена перезаписи — окно оставляем: правки ещё в редакторе.
          if (!(await saveDocument(file))) return;
        }
      }
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
    editorActionDisposers = editors.listActions().map((action) =>
      commands.register(
        {
          id: `editor.${action.id}`,
          title: action.label,
          category: 'Редактор',
          keywords: [action.id, action.alias].filter(Boolean),
        },
        async () => {
          try {
            editors.runAction(action.id);
          } catch (error) {
            console.error(`[chui] действие ${action.id} упало:`, error);
            showToast(error instanceof Error ? error.message : String(error), 'error');
          }
        },
      ),
    );
  };

  define({ id: 'workspace.openFolder', title: 'Открыть папку', category: 'Файл', keybinding: 'Ctrl+O' }, async () => {
    const path = await workspace.pick();
    if (!path) return;
    void commands.execute('view.showExplorer');
    showToast(`Открыт проект ${basename(path)}`);
  });

  // Добавить папку в рабочую область: несколько папок в одном окне (см. workspace-model).
  // Активной становится только что добавленная — туда идут git и поиск.
  define({ id: 'workspace.addFolder', title: 'Добавить папку в рабочую область', category: 'Файл' }, async () => {
    if (!workspace.current) {
      showToast('Сначала откройте папку проекта', 'error');
      return;
    }
    const result = await rpc.request('dialog.pickFolder', { title: 'Добавить папку в рабочую область' });
    if (!result.path) return;
    await workspace.addRoot(result.path);
    explorer.render();
    showToast(`В рабочую область добавлена папка ${basename(result.path)}`);
  });

  define({ id: 'workspace.refresh', title: 'Обновить дерево', category: 'Файл' }, async () => {
    await workspace.refresh();
    explorer.render();
  });

  define({ id: 'workspace.revealPath', title: 'Показать в проводнике', category: 'Навигация' }, (path) => {
    if (typeof path === 'string') explorer.reveal(path);
  });

  define({ id: 'file.open', title: 'Открыть файл', category: 'Файл' }, async (path, options) => {
    if (typeof path !== 'string') return;
    const preview = (options as { preview?: boolean } | undefined)?.preview === true;
    await openPath(path, { preview });
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

  define(
    {
      id: 'file.close',
      title: 'Закрыть вкладку',
      category: 'Файл',
      keybinding: 'Ctrl+W',
      enabled: () => openEditors.active !== null,
    },
    (path) => {
      const target = typeof path === 'string' ? path : (openEditors.active?.path ?? null);
      if (!target) return;
      openEditors.close(target);
      const next = openEditors.active;
      if (next) editors.open(next);
    },
  );

  // Закрепление вкладки: закреплённую не вытесняет предпросмотр, и её не трогает
  // «закрыть другие». Тумблер — одна команда и в меню вкладки, и в палитре.
  define({ id: 'file.togglePin', title: 'Закрепить/открепить вкладку', category: 'Файл' }, (path) => {
    const target = typeof path === 'string' ? path : (openEditors.active?.path ?? null);
    if (!target) return;
    if (openEditors.isPinned(target)) openEditors.unpin(target);
    else openEditors.pin(target);
  });

  define(
    {
      id: 'file.closeOthers',
      title: 'Закрыть другие вкладки',
      category: 'Файл',
      enabled: () => openEditors.paths.length > 1,
    },
    (path) => {
      const target = typeof path === 'string' ? path : (openEditors.active?.path ?? null);
      if (target) openEditors.closeOthers(target);
    },
  );

  define(
    {
      id: 'file.save',
      title: 'Сохранить',
      category: 'Файл',
      keybinding: 'Ctrl+S',
      enabled: () => openEditors.active !== null,
    },
    async () => {
      const document = openEditors.active;
      if (!document) {
        showToast('Нет открытого файла');
        return;
      }
      await saveDocument(document);
    },
  );

  define(
    {
      id: 'file.saveAs',
      title: 'Сохранить как…',
      category: 'Файл',
      keybinding: 'Ctrl+Shift+S',
      enabled: () => openEditors.active !== null,
    },
    // Путь приходит из меню вкладки: сохраняем тот файл, по которому кликнули,
    // а не активный. Без аргумента — активный (палитра, горячая клавиша).
    async (path) => {
      const target = typeof path === 'string' ? path : (openEditors.active?.path ?? null);
      const document = target ? (documents.get(target) ?? null) : null;
      if (!document) {
        showToast('Нет открытого файла');
        return;
      }
      await saveDocumentAs(document);
    },
  );

  define(
    {
      id: 'file.saveAll',
      title: 'Сохранить всё',
      category: 'Файл',
      // Ctrl+Shift+S отдано «Сохранить как…» — привычке из VS Code и PyCharm.
      keybinding: 'Ctrl+Alt+S',
      enabled: () => documents.dirty().length > 0,
    },
    async () => {
      const dirty = documents.dirty();
      if (dirty.length === 0) {
        showToast('Все файлы уже сохранены');
        return;
      }
      for (const document of dirty) await saveDocument(document);
    },
  );

  // Возврат к версии на диске. Нужен там, где буфер разошёлся с файлом: правки
  // записал другой инструмент или они легли мимо. Без этой команды такой документ
  // оставался бы «не сохранён» до самого закрытия вкладки.
  define(
    {
      id: 'file.revertFromDisk',
      title: 'Перечитать с диска (отменить правки в буфере)',
      category: 'Файл',
      // Доступна, пока есть хоть один правленый буфер: команда умеет и путь в аргументе
      // (правый клик по вкладке), и активный файл — гасить её по одному файлу незачем.
      enabled: () => documents.dirty().length > 0,
    },
    (pathArg) => {
      const target = typeof pathArg === 'string' ? pathArg : (openEditors.active?.path ?? null);
      if (!target) return;
      return revertFilesToDisk([target]);
    },
  );

  // То же для всех разом: файлов в буфере бывает несколько, и закрывать окно,
  // отвечая по одному, — лишняя работа.
  define(
    {
      id: 'file.revertAllFromDisk',
      title: 'Перечитать все файлы с диска',
      category: 'Файл',
      enabled: () => documents.dirty().length > 0,
    },
    () => revertFilesToDisk(documents.dirty().map((document) => document.path)),
  );

  define({ id: 'file.createFile', title: 'Создать файл', category: 'Файл' }, async (path) => {
    if (typeof path !== 'string') return undefined;
    const created = await rpc.request('workspace.createFile', { path });
    await openPath(created.path);
    explorer.scheduleRefresh();
    // Сразу предлагаем отменить: файл могли создать по ошибке в неверной папке.
    showToast(`Создан файл ${basename(created.path)}`, 'info', {
      action: {
        label: 'Отменить',
        run: async () => {
          await commands.execute('file.close', created.path);
          await rpc.request('workspace.trash', { path: created.path });
          explorer.scheduleRefresh();
        },
      },
    });
    return created.path;
  });

  define({ id: 'file.createFolder', title: 'Создать папку', category: 'Файл' }, async (path) => {
    if (typeof path !== 'string') return undefined;
    const created = await rpc.request('workspace.createDir', { path });
    explorer.scheduleRefresh();
    showToast(`Создана папка ${basename(created.path)}`, 'info', {
      action: {
        label: 'Отменить',
        run: async () => {
          await rpc.request('workspace.trash', { path: created.path });
          explorer.scheduleRefresh();
        },
      },
    });
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
    // Переименование ломает ссылки на файл — правим их сразу, пока человек ещё
    // ждёт ответа. Настройкой это можно выключить: тогда останется только то, что
    // путь в проекте придётся поправить руками.
    const touched = settings.explorer.updateImportsOnRename
      ? (
          await rpc
            .request('workspace.updateImports', { oldPath: from, newPath: renamed.path })
            .catch(() => ({ files: [] }))
        ).files.length
      : 0;
    if (wasActive) await openPath(renamed.path);
    explorer.scheduleRefresh();
    showToast(
      touched > 0
        ? `Переименовано: ${basename(renamed.path)} · обновлено ссылок: ${touched}`
        : `Переименовано: ${basename(renamed.path)}`,
      'info',
      {
        action: {
          label: 'Отменить',
          run: async () => {
            // Возвращаем прежнее имя и, если файл был открыт, открываем его там же.
            await commands.execute('file.close', renamed.path);
            await rpc.request('workspace.rename', { from: renamed.path, to: from });
            // Ссылки возвращаются к прежнему имени тем же путём — иначе отмена
            // переименования оставила бы в проекте ссылки на исчезнувший путь.
            if (touched > 0) {
              await rpc
                .request('workspace.updateImports', { oldPath: renamed.path, newPath: from })
                .catch(() => undefined);
            }
            if (wasActive) await openPath(from);
            explorer.scheduleRefresh();
          },
        },
      },
    );
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

  /** Слово к числу: 1 объект, 2 объекта, 5 объектов. */
  const objectsWord = (count: number): string => {
    const tail = count % 100;
    if (tail >= 11 && tail <= 14) return 'объектов';
    const last = count % 10;
    if (last === 1) return 'объект';
    if (last >= 2 && last <= 4) return 'объекта';
    return 'объектов';
  };

  define({ id: 'file.deleteMany', title: 'Удалить выделенное в корзину', category: 'Файл' }, async (paths) => {
    if (!Array.isArray(paths)) return;
    const list = paths.filter((item): item is string => typeof item === 'string');
    if (list.length === 0) return;

    // Вопрос один на всю пачку: спрашивать по разу на файл — то самое раздражение,
    // ради ухода от которого и делают групповое выделение.
    if (settings.explorer.confirmDelete) {
      const { confirmed } = await rpc.request('dialog.confirm', {
        title: 'Удалить в корзину',
        message: `Переместить в корзину ${list.length} ${objectsWord(list.length)}?`,
        detail: 'Файлы и папки можно вернуть из корзины системы.',
        confirmLabel: 'Удалить',
      });
      if (!confirmed) return;
    }

    let removed = 0;
    for (const path of list) {
      try {
        if (openEditors.has(path)) openEditors.close(path);
        await rpc.request('workspace.trash', { path });
        removed += 1;
      } catch {
        // Одного неудачного объекта мало, чтобы отменить удаление остальных.
      }
    }
    explorer.scheduleRefresh();
    showToast(`В корзине: ${removed} ${objectsWord(removed)}`);
  });

  define({ id: 'file.moveInto', title: 'Переместить в папку', category: 'Файл' }, async (paths, targetDir) => {
    if (!Array.isArray(paths) || typeof targetDir !== 'string') return;
    const list = paths.filter((item): item is string => typeof item === 'string');
    const steps = movePlan(list, targetDir);
    if (steps.length === 0) return;

    // Открытые вкладки переезжают вместе с файлом: закрываем и открываем по новому
    // пути. Активную возвращаем на экран — иначе перенос выглядел бы как закрытие.
    const moved: Array<{ from: string; to: string; active: boolean }> = [];
    for (const step of steps) {
      const wasActive = openEditors.active?.path === step.from;
      try {
        if (openEditors.has(step.from)) openEditors.close(step.from);
        await rpc.request('workspace.rename', { from: step.from, to: step.to });
        moved.push({ ...step, active: wasActive });
      } catch {
        // Имя в целевой папке занято — этот объект пропускаем, остальные переносим.
      }
    }

    explorer.scheduleRefresh();
    if (moved.length === 0) {
      showToast('Перенести не удалось: в целевой папке уже есть такое имя', 'error');
      return;
    }
    for (const step of moved) if (step.active) await openPath(step.to);

    showToast(
      moved.length === 1
        ? `Перенесено: ${basename(moved[0]!.to)}`
        : `Перенесено: ${moved.length} ${objectsWord(moved.length)}`,
      'info',
      {
        action: {
          label: 'Отменить',
          run: async () => {
            for (const step of moved) {
              if (openEditors.has(step.to)) openEditors.close(step.to);
              await rpc.request('workspace.rename', { from: step.to, to: step.from }).catch(() => undefined);
            }
            for (const step of moved) if (step.active) await openPath(step.from);
            explorer.scheduleRefresh();
          },
        },
      },
    );
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

  define({ id: 'file.copyInto', title: 'Скопировать в папку', category: 'Файл' }, async (paths, targetDir) => {
    if (!Array.isArray(paths) || typeof targetDir !== 'string') return;
    const list = paths.filter((item): item is string => typeof item === 'string');
    const steps = copyPlan(list, targetDir);
    if (steps.length === 0) return;

    const copied: string[] = [];
    for (const step of steps) {
      try {
        const result = await rpc.request('workspace.copy', { from: step.from, to: step.to });
        copied.push(result.path);
      } catch {
        // Имя в целевой папке занято — копию пропускаем, остальные делаем.
      }
    }

    explorer.scheduleRefresh();
    if (copied.length === 0) {
      showToast('Скопировать не удалось: в целевой папке уже есть такое имя', 'error');
      return;
    }
    showToast(
      copied.length === 1
        ? `Скопировано: ${basename(copied[0]!)}`
        : `Скопировано: ${copied.length} ${objectsWord(copied.length)}`,
      'info',
      {
        action: {
          label: 'Отменить',
          run: async () => {
            // Отмена копии — вернуть её в корзину: исходный объект мы не трогали.
            for (const path of copied) await rpc.request('workspace.trash', { path }).catch(() => undefined);
            explorer.scheduleRefresh();
          },
        },
      },
    );
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

  // Набор значков дерева из файла: правила приносит человек или сторонний набор.
  define({ id: 'explorer.importBadges', title: 'Набор значков дерева из файла…', category: 'Вид' }, async () => {
    const result = await rpc.request('explorer.importBadges', undefined).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : 'Не удалось прочитать набор значков', 'error');
      return null;
    });
    if (!result) return;
    applySettings(result.settings);
    showToast(result.count > 0 ? `Значков дерева: ${result.count}` : 'Набор значков пуст');
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

  // Избранное: то же, что пункт меню дерева, но по текущему файлу или папке.
  define({ id: 'explorer.favorite', title: 'В избранное / убрать', category: 'Файл' }, async (path) => {
    const target = typeof path === 'string' && path !== '' ? path : (editors.currentPath ?? workspace.root);
    if (!target) return;
    const wasFavorite = explorer.favorites().includes(target);
    explorer.toggleFavorite(target);
    showToast(wasFavorite ? 'Убрано из избранного' : 'Добавлено в избранное');
  });

  // Закреплённое сверху дерева: то же, что пункт меню, но по текущему файлу.
  define({ id: 'explorer.togglePin', title: 'Закрепить файл в дереве', category: 'Файл' }, async (path) => {
    const target = typeof path === 'string' ? path : editors.currentPath;
    if (!target) return;
    const wasPinned = explorer.pinnedPaths().includes(target);
    explorer.togglePin(target);
    showToast(wasPinned ? 'Откреплено сверху дерева' : 'Закреплено сверху дерева');
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

  define(
    {
      id: 'run.file',
      title: 'Запустить файл',
      category: 'Запуск',
      keybinding: 'Ctrl+F5',
      enabled: () => targetsFor(openEditors.active).some((item) => item.source === 'file'),
    },
    async () => {
      // Именно файл, а не первая цель из набора: у Python первыми могли оказаться
      // тесты, и Ctrl+F5 запускал бы их вместо самого файла.
      const target = targetsFor(openEditors.active).find((item) => item.source === 'file');
      if (!target) {
        showToast('Запускать нечего: нужен скрипт или задача в package.json', 'error');
        return;
      }
      await runTarget(target);
    },
  );

  define(
    { id: 'run.tests', title: 'Запустить тесты', category: 'Запуск', enabled: () => testTarget() !== undefined },
    async () => {
      const target = testTarget();
      if (!target) {
        showToast('Тесты не найдены: нужен pytest, vitest, jest или файлы для `node --test`', 'error');
        return;
      }
      await runTarget(target);
    },
  );

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
        session.scheduleSave();
        void startDebug(options);
      },
      onReset: () => {
        debugOptions = {};
        session.scheduleSave();
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

  define(
    {
      id: 'run.choose',
      title: 'Запустить…',
      category: 'Запуск',
      keybinding: 'Shift+F10',
      enabled: () => targetsFor(openEditors.active).length > 0,
    },
    () => {
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
    },
  );

  define({ id: 'view.showExplorer', title: 'Показать проводник', category: 'Вид', keybinding: 'Alt+1' }, () => {
    layout.setSidebarVisible(true);
    syncViewButtons();
  });

  /* ── git ───────────────────────────────────────────────────────────────── */

  /** Путь приходит аргументом команды: так её можно вызвать из палитры и от ассистента. */
  const asPath = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

  /** Первая содержательная строка ответа git — для уведомления: целиком оно не влезет. */
  const firstLine = (text: string): string =>
    text
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? text;

  define({ id: 'git.refresh', title: 'Обновить состояние репозитория', category: 'Git' }, async () => {
    await git.refresh();
  });

  define(
    {
      id: 'git.init',
      title: 'Создать репозиторий git',
      category: 'Git',
      enabled: () => workspace.root !== null && !git.isRepository,
    },
    async () => {
      await git.init();
      showToast('Репозиторий git создан');
    },
  );

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

    // Правки в буферах git ещё не видит: он смотрит рабочее дерево, а не экран.
    // Сохраняем ДО индексации — иначе и в индекс, и в коммит ушло бы старое содержимое.
    if (!(await saveDirtyForGit())) return undefined;

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

  /**
   * Сообщение коммита по diff: модель читает правки и предлагает текст.
   *
   * Это не агент и не беседа — один запрос, короткий ответ (`ai.commitMessage`).
   * Текст кладём В ПОЛЕ, а не коммитим сразу: сообщение правят и дополняют, а
   * кнопка «Закоммитить» рядом. Diff собирает main (`git.commitDiff`): в renderer
   * рабочего дерева нет, а обрезать и склеить правки — работа для того, у кого git.
   */
  define({ id: 'git.generateCommitMessage', title: 'Сообщение коммита по diff (AI)', category: 'Git' }, async () => {
    if (!git.isRepository) {
      showToast('Рабочая папка не в репозитории git', 'error');
      return;
    }
    if (!aiEnabled()) {
      warnAiDisabled();
      return;
    }

    const context = await git.commitDiff();
    if (!context.diff.trim() && context.untracked.length === 0) {
      showToast('Правок нет — сообщение писать не по чему', 'error');
      return;
    }

    try {
      const { message } = await rpc.request('ai.commitMessage', {
        diff: context.diff,
        staged: context.staged,
        branch: git.branch,
        untracked: context.untracked,
      });
      if (isEmptyCommitMessage(message)) {
        showToast('Модель вернула пустое сообщение — попробуйте ещё раз', 'error');
        return;
      }
      sourceControl.setMessage(message);
      // Диф обрезан — предупреждаем: модель видела не всю правку, тему стоит проверить.
      showToast(context.truncated ? 'Сообщение готово (diff был обрезан — проверьте)' : 'Сообщение готово');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  /**
   * Исправить последний коммит (amend). Пустое сообщение — оставить прежнее:
   * так можно просто добавить в него дозревшие правки.
   */
  define(
    { id: 'git.amendCommit', title: 'Исправить последний коммит (amend)', category: 'Git' },
    async (messageArg) => {
      const text = typeof messageArg === 'string' ? messageArg : '';
      if (!git.repository || git.repository.head === null) {
        showToast('Исправлять нечего: коммитов ещё нет', 'error');
        return undefined;
      }
      if (!(await saveDirtyForGit())) return undefined;
      const info = await git.commit(text, undefined, true);
      showToast(`Коммит ${info.hash} исправлен: ${info.summary}`);
      return info;
    },
  );

  define({ id: 'git.showDiff', title: 'Показать различия файла', category: 'Git' }, async (path, staged) => {
    const target = asPath(path);
    if (target) await diffView.open(target, staged === true);
  });

  /** Замечания к коду: сравнение файла и лента замечаний сбоку. */
  define({ id: 'git.reviewComments', title: 'Замечания к коду в сравнении', category: 'Git' }, async () => {
    const path = editors.currentPath;
    if (!path) {
      showToast('Откройте файл, чтобы оставить замечание', 'error');
      return;
    }
    const staged = git.statusOf(path)?.staged === true;
    if (!diffView.isOpen) await diffView.open(path, staged);
    diffView.showComments();
  });

  /** Показать или скрыть автора строки у курсора (blame). */
  define({ id: 'git.toggleBlame', title: 'Автор строки (blame): показать/скрыть', category: 'Git' }, () => {
    const on = blame.toggle();
    showToast(on ? 'Blame включён: у строки под курсором видно автора' : 'Blame выключен');
  });

  /** Подписи blame у всех строк файла: разом видно, кто и когда писал каждую строку. */
  define({ id: 'git.toggleFileBlame', title: 'Blame всего файла: показать/скрыть', category: 'Git' }, () => {
    const on = blame.toggleFile();
    showToast(on ? 'Подписи у всех строк файла включены' : 'Подписи у всех строк файла выключены');
  });

  /** Перейти к коммиту, изменившему строку под курсором. */
  define({ id: 'git.showLineCommit', title: 'Коммит строки под курсором', category: 'Git' }, async () => {
    const path = editors.currentPath;
    if (!path) {
      showToast('Откройте файл, строку которого смотрите', 'error');
      return;
    }
    const at = editors.cursor();
    const lines = await git.blame(path, { startLine: at.line, endLine: at.line }).catch(() => []);
    const line = lines[0];
    if (!line) {
      showToast('У этой строки нет истории: файл не в git или строка не менялась', 'error');
      return;
    }
    await diffView.open(path, false, line.hash);
  });

  /** История в виде графа веток — текстом, как её рисует git. */
  define({ id: 'git.logGraph', title: 'История с графом веток', category: 'Git' }, async () => {
    if (!git.isRepository) {
      showToast('Рабочая папка не в репозитории git', 'error');
      return;
    }
    const text = await git.logGraph(100);
    if (!text.trim()) {
      showToast('Истории ещё нет');
      return;
    }
    textModal.open('История (граф веток)', text);
  });

  /** Показать или скрыть полоски изменений в жёлобе редактора. */
  define(
    { id: 'git.toggleChangeGutter', title: 'Полоски изменений в жёлобе: показать/скрыть', category: 'Git' },
    () => {
      const on = changeGutter.toggle();
      showToast(on ? 'Полоски изменений включены' : 'Полоски изменений скрыты');
    },
  );

  /** Отложенные изменения (stash): список записей и действия над ними. */
  define({ id: 'git.openStash', title: 'Отложенные изменения (stash)', category: 'Git' }, async () => {
    if (!git.isRepository) {
      showToast('Рабочая папка не в репозитории git', 'error');
      return;
    }
    await stashModal.open();
  });

  /**
   * Итог операции с историей одним сообщением. Rebase может не закончиться: он
   * останавливается на конфликте или на шаге правки — об этом говорим отдельно,
   * а не показываем текст git как ошибку.
   */
  const reportRebase = (result: { ok: boolean; inProgress: boolean; conflict: boolean; message: string }): void => {
    if (result.conflict) showToast('Есть конфликты — разрешите их и продолжите rebase', 'error');
    else if (result.inProgress) showToast('Rebase идёт: исправьте коммит и продолжите', 'info');
    else if (result.ok) showToast('Rebase завершён');
    else showToast(result.message, 'error');
  };

  /** Пошаговый поиск багованного коммита (bisect). */
  define(
    {
      id: 'git.bisect',
      title: 'Найти багованный коммит (bisect)',
      category: 'Git',
      keywords: ['bisect', 'бисект', 'плохой коммит', 'поиск'],
      enabled: () => git.isRepository,
    },
    async () => {
      if (!git.isRepository) {
        showToast('Рабочая папка не в репозитории git', 'error');
        return;
      }
      await bisectModal.open();
    },
  );

  /** Дополнительные рабочие каталоги одного репозитория (worktree). */
  define(
    {
      id: 'git.worktrees',
      title: 'Рабочие каталоги (worktree)',
      category: 'Git',
      keywords: ['worktree', 'каталог', 'ветка', 'ворктри'],
      enabled: () => git.isRepository,
    },
    async () => {
      if (!git.isRepository) {
        showToast('Рабочая папка не в репозитории git', 'error');
        return;
      }
      await worktreeModal.open();
    },
  );

  /** Запросы на слияние площадки (PR/MR) через `gh`/`glab`. */
  define(
    {
      id: 'git.pullRequests',
      title: 'Запросы на слияние (PR/MR)',
      category: 'Git',
      keywords: ['pr', 'mr', 'pull request', 'merge request', 'github', 'gitlab', 'запрос', 'слияние'],
      enabled: () => git.isRepository,
    },
    async () => {
      if (!git.isRepository) {
        showToast('Рабочая папка не в репозитории git', 'error');
        return;
      }
      await forgeModal.open();
    },
  );

  /** Задачи площадки (issues) через `gh`/`glab`. */
  define(
    {
      id: 'git.issues',
      title: 'Задачи площадки (issues)',
      category: 'Git',
      keywords: ['issue', 'issues', 'задача', 'задачи', 'github', 'gitlab', 'ticket'],
      enabled: () => git.isRepository,
    },
    async () => {
      if (!git.isRepository) {
        showToast('Рабочая папка не в репозитории git', 'error');
        return;
      }
      await issuesModal.open();
    },
  );

  /** Прогоны CI площадки (Actions/Pipelines) через `gh`/`glab`. */
  define(
    {
      id: 'git.pipelines',
      title: 'Прогоны CI (Actions/Pipelines)',
      category: 'Git',
      keywords: ['ci', 'actions', 'pipelines', 'прогон', 'сборка', 'github', 'gitlab'],
      enabled: () => git.isRepository,
    },
    async () => {
      if (!git.isRepository) {
        showToast('Рабочая папка не в репозитории git', 'error');
        return;
      }
      await pipelinesModal.open();
    },
  );

  /** Личность и подпись: имя, почта, GPG/SSH-подпись коммитов и тегов, ключи. */
  define(
    {
      id: 'git.identity',
      title: 'Личность и подпись коммитов',
      category: 'Git',
      keywords: ['подпись', 'gpg', 'ssh', 'signing', 'key', 'author', 'имя', 'почта', 'co-authored-by'],
      enabled: () => git.isRepository,
    },
    async () => {
      if (!git.isRepository) {
        showToast('Рабочая папка не в репозитории git', 'error');
        return;
      }
      await identityModal.open();
    },
  );

  /** Большие файлы (Git LFS): шаблоны, файлы под хранилищем и их подтягивание. */
  define(
    {
      id: 'git.lfs',
      title: 'Большие файлы (Git LFS)',
      category: 'Git',
      keywords: ['lfs', 'большие файлы', 'хранилище', 'gitattributes'],
      enabled: () => git.isRepository,
    },
    async () => {
      if (!git.isRepository) {
        showToast('Рабочая папка не в репозитории git', 'error');
        return;
      }
      await lfsModal.open();
    },
  );

  /** Разреженный рабочий каталог (sparse checkout): какие папки выложены на диск. */
  define(
    {
      id: 'git.sparse',
      title: 'Разреженный рабочий каталог…',
      category: 'Git',
      keywords: ['sparse', 'разреженный', 'sparse-checkout', 'монорепо', 'папки'],
      enabled: () => git.isRepository,
    },
    async () => {
      if (!git.isRepository) {
        showToast('Рабочая папка не в репозитории git', 'error');
        return;
      }
      await sparseModal.open();
    },
  );

  /** Подмодули: в дереве помечены значком, а забрать их код можно этой командой. */
  define(
    {
      id: 'git.submoduleUpdate',
      title: 'Обновить подмодули',
      category: 'Git',
      keywords: ['submodule', 'подмодуль', 'init', 'update'],
      enabled: () => git.isRepository,
    },
    async () => {
      if (!git.isRepository) {
        showToast('Рабочая папка не в репозитории git', 'error');
        return;
      }
      showToast('Забираю подмодули…');
      try {
        await git.submoduleUpdate();
        showToast('Подмодули обновлены');
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  );

  /** Сравнение веток: список различий и просмотр отдельного файла. */
  define(
    {
      id: 'git.compareBranches',
      title: 'Сравнить ветки',
      category: 'Git',
      keywords: ['diff', 'ветки', 'сравнить', 'различия'],
      enabled: () => git.isRepository,
    },
    async () => {
      if (!git.isRepository) {
        showToast('Рабочая папка не в репозитории git', 'error');
        return;
      }
      await refDiffModal.open();
    },
  );

  /** Интерактивный rebase: список коммитов собирает своё окно. */
  define(
    {
      id: 'git.rebase',
      title: 'Перестроить историю (interactive rebase)',
      category: 'Git',
      keywords: ['rebase', 'squash', 'fixup', 'склеить', 'переставить'],
      enabled: () => git.isRepository,
    },
    async () => {
      if (!git.isRepository) {
        showToast('Рабочая папка не в репозитории git', 'error');
        return;
      }
      await rebaseModal.open();
    },
  );

  define({ id: 'git.rebaseContinue', title: 'Rebase: продолжить', category: 'Git' }, async () => {
    try {
      reportRebase(await git.rebaseContinue());
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  define({ id: 'git.rebaseSkip', title: 'Rebase: пропустить коммит', category: 'Git' }, async () => {
    try {
      reportRebase(await git.rebaseSkip());
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  define({ id: 'git.rebaseAbort', title: 'Rebase: прервать', category: 'Git' }, async () => {
    try {
      await git.rebaseAbort();
      showToast('Rebase прерван, ветка на прежнем месте');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  /* ── отдельные коммиты и теги ─────────────────────────────────────────── */

  /** Сбросить ветку на коммит. Режим выбирает, что будет с правками; спрашиваем всегда. */
  const resetTo = async (mode: 'soft' | 'mixed' | 'hard', hash: string, summary: string): Promise<void> => {
    const detail =
      mode === 'hard'
        ? 'Правки в рабочем дереве и индексе будут потеряны безвозвратно.'
        : mode === 'mixed'
          ? 'Индекс сбросится, правки в файлах останутся.'
          : 'Правки останутся и в файлах, и в индексе — они не пропадут.';
    const { confirmed } = await rpc.request('dialog.confirm', {
      title: 'Сброс ветки',
      message: `Сбросить ${git.branch ?? 'ветку'} на ${hash}?`,
      detail: `${summary}\n${detail}`,
      confirmLabel: mode === 'hard' ? 'Сбросить жёстко' : 'Сбросить',
    });
    if (!confirmed) return;
    try {
      await git.reset(mode, hash);
      showToast(`Ветка сброшена на ${hash}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  /** Действия над одним коммитом: перенос, откат и сброс ветки на него. */
  const commitActions = (hash: string, summary: string): PopupMenuItem[] => [
    {
      label: 'Перенести в текущую ветку (cherry-pick)',
      onSelect: () => {
        void git.cherryPick(hash).then(
          () => showToast(`Коммит ${hash} перенесён`),
          (error: unknown) => showToast(error instanceof Error ? error.message : String(error), 'error'),
        );
      },
    },
    {
      label: 'Отменить коммит (revert)',
      onSelect: () => {
        void git.revert(hash).then(
          () => showToast(`Коммит ${hash} отменён`),
          (error: unknown) => showToast(error instanceof Error ? error.message : String(error), 'error'),
        );
      },
    },
    { separator: true },
    {
      label: 'Сбросить ветку на этот коммит',
      submenu: [
        { label: 'Мягкий (soft) — правки в индексе', onSelect: () => void resetTo('soft', hash, summary) },
        { label: 'Смешанный (mixed) — индекс чист', onSelect: () => void resetTo('mixed', hash, summary) },
        {
          label: 'Жёсткий (hard) — правки теряются',
          danger: true,
          onSelect: () => void resetTo('hard', hash, summary),
        },
      ],
    },
  ];

  /** История коммитов репозитория: у каждого — действия над этим коммитом. */
  define({ id: 'git.showLog', title: 'История коммитов', category: 'Git' }, async () => {
    if (!git.isRepository) {
      showToast('Рабочая папка не в репозитории git', 'error');
      return;
    }
    const commits = await git.log(undefined, 50);
    if (commits.length === 0) {
      showToast('Коммитов ещё нет');
      return;
    }
    const rect = layout.editorHost.getBoundingClientRect();
    showPopupMenu(
      commits.map((commit) => ({
        label: `${commit.hash} ${commit.date} ${commit.author}`,
        hint: commit.summary,
        submenu: commitActions(commit.hash, commit.summary),
      })),
      rect.left + 40,
      rect.top + 40,
      { anchor: layout.editorHost },
    );
  });

  /** Создать тег на текущем коммите. */
  define({ id: 'git.createTag', title: 'Создать тег', category: 'Git' }, async () => {
    if (!git.isRepository) {
      showToast('Рабочая папка не в репозитории git', 'error');
      return;
    }
    const name = await promptValue({ title: 'Создать тег', label: 'Имя тега', value: '' });
    if (!name) return;
    try {
      await git.createTag(name);
      showToast(`Тег ${name} создан`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  /** Теги: список с действиями и создание нового. */
  define({ id: 'git.tags', title: 'Теги', category: 'Git' }, async () => {
    if (!git.isRepository) {
      showToast('Рабочая папка не в репозитории git', 'error');
      return;
    }
    const tags = await git.tags();
    const items: PopupMenuItem[] = [
      { label: 'Создать тег…', onSelect: () => void commands.execute('git.createTag') },
      { separator: true },
    ];
    if (tags.length === 0) {
      items.push({ label: 'Тегов нет', hint: 'поставьте первый', onSelect: () => undefined });
    }
    for (const tag of tags) {
      items.push({
        label: tag.name,
        hint: tag.commit,
        submenu: [
          {
            label: 'Переключиться на тег',
            onSelect: () => {
              void rpc
                .request('dialog.confirm', {
                  title: 'Переключение на тег',
                  message: `Перейти на тег ${tag.name}?`,
                  detail: 'Ветка станет отсоединённой (detached HEAD): новые коммиты в неё не попадут.',
                  confirmLabel: 'Перейти',
                })
                .then(({ confirmed }) => (confirmed ? git.checkout(tag.name) : undefined))
                .catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error), 'error'));
            },
          },
          {
            label: 'Отправить в origin',
            onSelect: () => {
              void git.pushTag(tag.name).then(
                (result) => showToast(result.message),
                (error: unknown) => showToast(error instanceof Error ? error.message : String(error), 'error'),
              );
            },
          },
          { separator: true },
          {
            label: 'Удалить тег',
            danger: true,
            onSelect: () => {
              void rpc
                .request('dialog.confirm', {
                  title: 'Удалить тег',
                  message: `Удалить тег ${tag.name}?`,
                  detail: 'Удалённый тег останется в origin — там его нужно убирать отдельно.',
                  confirmLabel: 'Удалить',
                })
                .then(({ confirmed }) => (confirmed ? git.deleteTag(tag.name) : undefined))
                .then(() => undefined)
                .catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error), 'error'));
            },
          },
        ],
      });
    }
    const rect = layout.editorHost.getBoundingClientRect();
    showPopupMenu(items, rect.left + 40, rect.top + 40, { anchor: layout.editorHost });
  });

  /** Отменить последний коммит, оставив его правки в индексе (reset --soft HEAD~1). */
  define({ id: 'git.undoCommit', title: 'Отменить последний коммит (правки остаются)', category: 'Git' }, async () => {
    if (!git.repository?.head) {
      showToast('Коммитов ещё нет', 'error');
      return;
    }
    const { confirmed } = await rpc.request('dialog.confirm', {
      title: 'Отменить коммит',
      message: 'Отменить последний коммит?',
      detail: 'Коммит уйдёт из истории, а его правки останутся в индексе — их можно поправить и закоммитить заново.',
      confirmLabel: 'Отменить коммит',
    });
    if (!confirmed) return;
    try {
      await git.reset('soft', 'HEAD~1');
      showToast('Последний коммит отменён, правки в индексе');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  /** Журнал ссылок: сюда смотрят, чтобы откатить неудачный merge, rebase или reset. */
  define({ id: 'git.reflog', title: 'Журнал ссылок (reflog)', category: 'Git' }, async () => {
    if (!git.isRepository) {
      showToast('Рабочая папка не в репозитории git', 'error');
      return;
    }
    const entries = await git.reflog(50);
    if (entries.length === 0) {
      showToast('Журнал ссылок пуст');
      return;
    }
    const rect = layout.editorHost.getBoundingClientRect();
    showPopupMenu(
      entries.map((entry) => ({
        label: `${entry.ref} → ${entry.hash}`,
        hint: entry.action,
        submenu: [
          {
            label: 'Перенести в текущую ветку (cherry-pick)',
            onSelect: () => {
              void git.cherryPick(entry.hash).then(
                () => showToast(`Коммит ${entry.hash} перенесён`),
                (error: unknown) => showToast(error instanceof Error ? error.message : String(error), 'error'),
              );
            },
          },
          { separator: true },
          {
            label: 'Сбросить ветку сюда (soft) — правки в индексе',
            onSelect: () => void resetTo('soft', entry.hash, entry.action),
          },
          { label: 'Сбросить ветку сюда (mixed)', onSelect: () => void resetTo('mixed', entry.hash, entry.action) },
          {
            label: 'Сбросить ветку сюда (hard) — правки теряются',
            danger: true,
            onSelect: () => void resetTo('hard', entry.hash, entry.action),
          },
        ],
      })),
      rect.left + 40,
      rect.top + 40,
      { anchor: layout.editorHost },
    );
  });

  /** Удалить ветку. Имя можно передать аргументом, иначе спрашиваем. */
  define({ id: 'git.deleteBranch', title: 'Удалить ветку', category: 'Git' }, async (nameArg) => {
    if (!git.isRepository) {
      showToast('Рабочая папка не в репозитории git', 'error');
      return;
    }
    const name =
      typeof nameArg === 'string' && nameArg
        ? nameArg
        : await promptValue({ title: 'Удалить ветку', label: 'Имя ветки', value: '' });
    if (!name) return;
    try {
      await git.deleteBranch(name);
      showToast(`Ветка ${name} удалена`);
    } catch (error) {
      // git не даёт удалить невлитую ветку — предложим сделать это силой.
      const { confirmed } = await rpc.request('dialog.confirm', {
        title: 'Ветка не влита',
        message: `Удалить ветку ${name} принудительно?`,
        detail: error instanceof Error ? error.message : String(error),
        confirmLabel: 'Удалить принудительно',
      });
      if (!confirmed) return;
      try {
        await git.deleteBranch(name, true);
        showToast(`Ветка ${name} удалена принудительно`);
      } catch (forced) {
        showToast(forced instanceof Error ? forced.message : String(forced), 'error');
      }
    }
  });

  /** Переименовать текущую ветку. */
  define({ id: 'git.renameBranch', title: 'Переименовать текущую ветку', category: 'Git' }, async () => {
    const from = git.branch;
    if (!git.isRepository || !from) {
      showToast('Мы не на ветке — переименовывать нечего', 'error');
      return;
    }
    const to = await promptValue({ title: 'Переименовать ветку', label: `Новое имя для «${from}»`, value: from });
    if (!to || to === from) return;
    try {
      await git.renameBranch(from, to);
      showToast(`Ветка переименована в ${to}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  /** Добавить файл (или файлы) в .gitignore. Пути принимаем аргументом команды. */
  define({ id: 'git.ignore', title: 'Добавить в .gitignore', category: 'Git' }, async (pathArg) => {
    const paths = Array.isArray(pathArg)
      ? (pathArg as unknown[]).filter((item): item is string => typeof item === 'string')
      : typeof pathArg === 'string'
        ? [pathArg]
        : [];
    if (paths.length === 0) {
      showToast('Нечего добавлять: файл не выбран', 'error');
      return;
    }
    try {
      await git.ignore(paths);
      showToast(paths.length === 1 ? 'Добавлено в .gitignore' : `В .gitignore добавлено файлов: ${paths.length}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  /** История коммитов файла: выбор записи открывает сравнение с текущим текстом. */
  define({ id: 'git.fileHistory', title: 'История файла', category: 'Git' }, async (path) => {
    const target = asPath(path) ?? editors.currentPath;
    if (!target) {
      showToast('Откройте файл, историю которого хотите посмотреть', 'error');
      return;
    }

    const commits = await git.log(target, 50);
    if (commits.length === 0) {
      showToast('Истории нет: файл не в git или коммитов ещё нет');
      return;
    }

    // Команда может прийти и из палитры, поэтому якоря под курсором нет —
    // отсчитываем панель от угла самой области редактора.
    const rect = layout.editorHost.getBoundingClientRect();
    showPopupMenu(
      commits.map((commit) => ({
        label: `${commit.hash} ${commit.date} ${commit.author}`,
        hint: commit.summary,
        onSelect: () => void diffView.open(target, false, commit.hash),
      })),
      rect.left + 40,
      rect.top + 40,
      { anchor: layout.editorHost },
    );
  });

  /**
   * Иерархия вызовов символа: кто его вызывает или кого вызывает он. Показываем
   * списком (Monaco такой панели не даёт) — тем же попапом, что и прочие переходы.
   */
  const openCallHierarchy = async (direction: CallDirection): Promise<void> => {
    const path = editors.currentPath;
    if (!path) {
      showToast('Откройте файл', 'error');
      return;
    }
    const position = editors.cursor();
    const result = await fetchCallHierarchy(rpc, path, position, direction).catch(() => null);
    if (!result) {
      showToast('Сервер символов не отвечает: нужен языковой сервер для этого языка', 'error');
      return;
    }
    if (result.calls.length === 0) {
      showToast(
        direction === 'incoming'
          ? `Никто не вызывает ${result.symbol.name}`
          : `${result.symbol.name} ничего не вызывает`,
      );
      return;
    }

    const rect = layout.editorHost.getBoundingClientRect();
    const heading = direction === 'incoming' ? `Вызывают ${result.symbol.name}` : `${result.symbol.name} вызывает`;
    showPopupMenu(
      result.calls.map((target) => ({
        label: target.name,
        hint: `${workspace.relative(target.path)}:${target.line}`,
        onSelect: () => void openPath(target.path).then(() => editors.reveal(target.path, target.line, target.column)),
      })),
      rect.left + 40,
      rect.top + 40,
      { anchor: layout.editorHost },
    );
    showToast(`${heading}: ${result.calls.length}`);
  };

  define(
    { id: 'editor.callers', title: 'Кто вызывает символ', category: 'Навигация' },
    () => void openCallHierarchy('incoming'),
  );
  define(
    { id: 'editor.callees', title: 'Кого вызывает символ', category: 'Навигация' },
    () => void openCallHierarchy('outgoing'),
  );

  /**
   * Иерархия типов символа: от кого наследует и кто наследует от него. Показываем
   * тем же списком, что вызовы: своего дерева у нас нет, а список читается и так.
   */
  const openTypeHierarchy = async (direction: TypeDirection): Promise<void> => {
    const path = editors.currentPath;
    if (!path) {
      showToast('Откройте файл', 'error');
      return;
    }
    const position = editors.cursor();
    const result = await fetchTypeHierarchy(rpc, path, position, direction).catch(() => null);
    if (!result) {
      showToast('Сервер символов не отвечает: нужен языковой сервер для этого языка', 'error');
      return;
    }
    if (result.types.length === 0) {
      showToast(
        direction === 'supertypes'
          ? `У ${result.symbol.name} нет надтипов`
          : `От ${result.symbol.name} никто не наследует`,
      );
      return;
    }

    const rect = layout.editorHost.getBoundingClientRect();
    showPopupMenu(
      result.types.map((target) => ({
        label: target.name,
        hint: target.detail ?? `${workspace.relative(target.path)}:${target.line}`,
        onSelect: () => void openPath(target.path).then(() => editors.reveal(target.path, target.line, target.column)),
      })),
      rect.left + 40,
      rect.top + 40,
      { anchor: layout.editorHost },
    );
    const heading = direction === 'supertypes' ? `Надтипы ${result.symbol.name}` : `Подтипы ${result.symbol.name}`;
    showToast(`${heading}: ${result.types.length}`);
  };

  define(
    { id: 'editor.supertypes', title: 'Иерархия типов: надтипы', category: 'Навигация' },
    () => void openTypeHierarchy('supertypes'),
  );
  define(
    { id: 'editor.subtypes', title: 'Иерархия типов: подтипы', category: 'Навигация' },
    () => void openTypeHierarchy('subtypes'),
  );

  /**
   * Где имя экспортируется: по имени под кареткой обходим проект и показываем файлы, где
   * оно объявлено экспортом. Список — тем же попапом, что и ссылки: у нас нет ни языкового
   * сервера в этом месте (в LSP такого запроса нет), ни дерева разбора — только разбор
   * строк по языку (`shared/symbol-exports.ts`).
   */
  const openFindExports = async (): Promise<void> => {
    const path = editors.currentPath;
    if (!path) {
      showToast('Откройте файл', 'error');
      return;
    }
    // Имя — из выделения, а если выделения нет, из слова под кареткой.
    const name = editors.selectedText().trim() || editors.wordAtCursor() || '';
    if (!name) {
      showToast('Поставьте курсор на имя', 'info');
      return;
    }

    const result = await rpc.request('workspace.findExports', { name }).catch(() => null);
    if (!result) {
      showToast('Не удалось искать по проекту', 'error');
      return;
    }
    if (result.total === 0) {
      showToast(`${name}: экспортов не найдено`);
      return;
    }

    const rect = layout.editorHost.getBoundingClientRect();
    showPopupMenu(
      result.files.flatMap((file) =>
        file.entries.map((entry) => ({
          label: `${workspace.relative(file.path)}:${entry.line}`,
          hint: exportKindLabel(entry.kind),
          onSelect: () => void openPath(file.path).then(() => editors.reveal(file.path, entry.line, 1)),
        })),
      ),
      rect.left + 40,
      rect.top + 40,
      { anchor: layout.editorHost },
    );
    showToast(`Экспортов ${name}: ${result.total}`);
  };

  define(
    { id: 'search.findExports', title: 'Где экспортируется', category: 'Поиск', keywords: ['export', 'экспорт'] },
    () => void openFindExports(),
  );

  define(
    {
      id: 'search.meaning',
      title: 'Поиск по смыслу',
      category: 'Поиск',
      keybinding: 'Ctrl+Shift+M',
      keywords: ['смысл', 'словами', 'meaning', 'semantic'],
    },
    () => meaningSearch.open(),
  );

  /**
   * Наследование имени под кареткой по проекту: кто наследует (subtypes) или от кого
   * наследует (supertypes). Тем же списком, что экспорты: свой разбор строк, без сервера
   * (иерархию типов сервер показывает лишь для символа под курсором).
   */
  const openInheritance = async (direction: 'subtypes' | 'supertypes'): Promise<void> => {
    const path = editors.currentPath;
    if (!path) {
      showToast('Откройте файл', 'error');
      return;
    }
    const name = editors.selectedText().trim() || editors.wordAtCursor() || '';
    if (!name) {
      showToast('Поставьте курсор на имя типа', 'info');
      return;
    }

    const result = await rpc.request('workspace.findInheritance', { name, direction }).catch(() => null);
    if (!result) {
      showToast('Не удалось искать по проекту', 'error');
      return;
    }
    const empty = direction === 'subtypes' ? `${name}: наследников не найдено` : `${name}: объявлений не найдено`;
    if (result.total === 0) {
      showToast(empty);
      return;
    }

    const rect = layout.editorHost.getBoundingClientRect();
    showPopupMenu(
      result.files.flatMap((file) =>
        file.entries.map((entry) => ({
          label: `${workspace.relative(file.path)}:${entry.line}`,
          hint: describeType(entry),
          onSelect: () => void openPath(file.path).then(() => editors.reveal(file.path, entry.line, 1)),
        })),
      ),
      rect.left + 40,
      rect.top + 40,
      { anchor: layout.editorHost },
    );
    showToast(direction === 'subtypes' ? `Наследуют ${name}: ${result.total}` : `${name}: ${result.total}`);
  };

  define(
    { id: 'search.findSubtypes', title: 'Кто наследует тип', category: 'Поиск', keywords: ['наслед', 'subclass'] },
    () => void openInheritance('subtypes'),
  );
  define(
    {
      id: 'search.findSupertypes',
      title: 'От кого наследует тип',
      category: 'Поиск',
      keywords: ['родител', 'superclass'],
    },
    () => void openInheritance('supertypes'),
  );

  /**
   * Моникер символа под курсором: устойчивое имя, по которому символ связывается с тем же
   * символом в других инструментах. Показываем список (схем бывает несколько), а первый
   * сразу копируем в буфер — чаще всего его и нужно вставить в другой инструмент.
   */
  const showMoniker = async (): Promise<void> => {
    const path = editors.currentPath;
    if (!path) {
      showToast('Откройте файл', 'error');
      return;
    }
    const monikers = await lsp.monikers(path, editors.cursor()).catch(() => []);
    if (monikers.length === 0) {
      showToast('Моникер не найден: сервер этого не умеет или символа под курсором нет');
      return;
    }
    const copy = (identifier: string): void => {
      void navigator.clipboard.writeText(identifier).catch(() => undefined);
      showToast('Моникер скопирован');
    };
    const rect = layout.editorHost.getBoundingClientRect();
    showPopupMenu(
      monikers.map((item) => ({
        label: item.identifier,
        hint: `${item.scheme}${item.unique ? ' · уникальный' : ''}`,
        onSelect: () => copy(item.identifier),
      })),
      rect.left + 40,
      rect.top + 40,
      { anchor: layout.editorHost },
    );
    copy(monikers[0]!.identifier);
  };

  define({ id: 'editor.moniker', title: 'Моникер символа', category: 'Навигация' }, () => void showMoniker());

  /** Разрешить конфликт слияния: экран с обеими сторонами и выбором по блокам. */
  define({ id: 'git.resolveConflicts', title: 'Разрешить конфликт слияния', category: 'Git' }, async (path) => {
    const target = asPath(path) ?? editors.currentPath;
    if (!target) {
      showToast('Откройте файл с конфликтом', 'error');
      return;
    }
    if (!(await conflictView.open(target))) showToast('В этом файле нет конфликтов слияния');
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

  // Синхронизация с удалённым репозиторием. Нажатие кнопки — уже решение человека,
  // поэтому отдельного вопроса не задаём; об исходе говорит уведомление, а провал
  // (нет remote, отказ авторизации, конфликт) приходит текстом от git.
  define(
    { id: 'git.fetch', title: 'Забрать изменения (fetch)', category: 'Git', enabled: () => git.isRepository },
    async () => {
      const result = await git.fetch();
      showToast(`fetch: ${firstLine(result.message)}`, result.ok ? 'info' : 'error');
    },
  );

  // Многообласть: папок несколько, у каждой свой репозиторий — обновляем все разом.
  define(
    {
      id: 'git.fetchRoots',
      title: 'Забрать изменения во всех папках (fetch)',
      category: 'Git',
      enabled: () => workspace.isMultiRoot,
    },
    async () => {
      const results = await git.fetchRoots();
      const summary = fetchResultsSummary(results);
      showToast(summary.text, summary.ok ? 'info' : 'error');
    },
  );

  // Режим pull берём из настроек (проектных): у команд разные привычки — кому слияние,
  // кому перебазирование. `default` не подсказывает флагов, и git ведёт себя как настроен.
  define(
    { id: 'git.pull', title: 'Влить изменения (pull)', category: 'Git', enabled: () => git.isRepository },
    async () => {
      const result = await git.pull(settings.git.pullMode);
      showToast(`pull: ${firstLine(result.message)}`, result.ok ? 'info' : 'error');
    },
  );

  // То же слиянием или перебазированием — разово, поверх настройки: иногда нужно
  // именно так, не меняя поведение по умолчанию.
  define(
    {
      id: 'git.pullRebase',
      title: 'Влить изменения (pull) с перебазированием',
      category: 'Git',
      enabled: () => git.isRepository,
    },
    async () => {
      const result = await git.pull('rebase');
      showToast(`pull --rebase: ${firstLine(result.message)}`, result.ok ? 'info' : 'error');
    },
  );

  define(
    { id: 'git.push', title: 'Отправить коммиты (push)', category: 'Git', enabled: () => git.isRepository },
    async () => {
      const result = await git.push();
      showToast(`push: ${firstLine(result.message)}`, result.ok ? 'info' : 'error');
    },
  );

  define(
    {
      id: 'git.stageAll',
      title: 'Проиндексировать все изменения',
      category: 'Git',
      enabled: () => git.unstaged.length > 0,
    },
    async () => {
      const paths = git.unstaged.map((file) => file.path);
      if (paths.length === 0) {
        showToast('Нет изменений для индексации', 'error');
        return;
      }
      await git.stage(paths);
    },
  );

  define(
    { id: 'git.unstageAll', title: 'Убрать всё из индекса', category: 'Git', enabled: () => git.staged.length > 0 },
    async () => {
      const paths = git.staged.map((file) => file.path);
      if (paths.length === 0) {
        showToast('Индекс уже пуст', 'error');
        return;
      }
      await git.unstage(paths);
    },
  );

  define(
    { id: 'git.discardAll', title: 'Откатить все правки', category: 'Git', enabled: () => git.unstaged.length > 0 },
    async () => {
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
    },
  );

  define({ id: 'view.showChanges', title: 'Показать изменения', category: 'Вид', keybinding: 'Ctrl+Shift+G' }, () => {
    dock.show('git');
  });

  define({ id: 'view.toggleSidebar', title: 'Боковая панель', category: 'Вид', keybinding: 'Ctrl+B' }, () => {
    layout.setSidebarVisible(!layout.sidebarVisible);
    syncViewButtons();
  });

  // Режим дзен: прячем всю обвязку — панели, нижний док, строку состояния и шапку — и
  // оставляем только редактор. Что было видно, ЗАПОМИНАЕМ и возвращаем на выходе;
  // спрятанный макет сохранять нельзя, поэтому прячем внутри `withoutPersist`.
  let zenSaved: { sidebar: boolean; right: boolean; dock: boolean } | null = null;
  define({ id: 'view.zen', title: 'Режим дзен', category: 'Вид', keywords: ['zen', 'фокус'] }, () => {
    if (zenSaved) {
      const saved = zenSaved;
      zenSaved = null;
      withoutPersist(() => {
        layout.setSidebarVisible(saved.sidebar);
        layout.setRightVisible(saved.right);
        layout.setDockVisible(saved.dock);
      });
      layout.root.classList.remove('is-zen');
    } else {
      zenSaved = { sidebar: layout.sidebarVisible, right: layout.rightVisible, dock: layout.dockVisible };
      withoutPersist(() => {
        layout.setSidebarVisible(false);
        layout.setRightVisible(false);
        layout.setDockVisible(false);
      });
      layout.root.classList.add('is-zen');
    }
    syncViewButtons();
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

  define({ id: 'view.showTerminal', title: 'Терминал', category: 'Вид', keybinding: 'Alt+F12' }, () => {
    dock.toggle('terminal');
  });

  define({ id: 'view.showOutline', title: 'Структура файла', category: 'Вид' }, () => {
    dock.toggle('outline');
  });

  define({ id: 'view.notebooks', title: 'Ячейки ноутбука', category: 'Вид' }, () => {
    dock.show('notebooks');
  });

  define({ id: 'view.showMarkdownPreview', title: 'Предпросмотр Markdown', category: 'Вид' }, () => {
    dock.toggle('preview');
  });

  define({ id: 'view.regexTester', title: 'Отладчик регулярных выражений', category: 'Вид' }, () => {
    regexTester.open();
  });

  define({ id: 'editor.structuralReplace', title: 'Заменить по структуре', category: 'Рефакторинг' }, () => {
    structuralSearch.open();
  });

  define({ id: 'view.showProblems', title: 'Проблемы', category: 'Вид', keywords: ['ошибки', 'warning'] }, () => {
    dock.show('problems');
  });

  // Задачи: список пометок TODO/FIXME/HACK/XXX по проекту — как панель «Проблемы»,
  // только источник у списка другой (поиск по проекту).
  define(
    { id: 'view.showTodos', title: 'Задачи (TODO/FIXME)', category: 'Вид', keywords: ['todo', 'fixme', 'пометки'] },
    () => {
      dock.show('todo');
    },
  );

  define({ id: 'view.toggleDock', title: 'Свернуть нижнюю панель', category: 'Вид' }, () => {
    if (dock.visible) dock.hide();
    else dock.show(dock.activeId ?? 'terminal');
  });

  define({ id: 'view.toggleRight', title: 'Панель AI', category: 'Вид', keybinding: 'Ctrl+Shift+A' }, () => {
    toggleChat();
  });

  // Разделение области редактора: одна кнопка включает и выключает, как и у панелей.
  define({ id: 'view.splitEditor', title: 'Разделить редактор', category: 'Вид', keybinding: 'Ctrl+\\' }, () => {
    if (editors.isSplit) editors.closeSplit();
    else editors.splitEditor();
    syncViewButtons();
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
          aiPanel: aiEnabled() && chatVisible(),
          terminal: layout.dockVisible && dock.activeId === 'terminal',
          theme: theme.selected,
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

  // Профиль строк: свой профилировщик исполняет файл и говорит, где прошло время.
  // Перед запуском сохраняем правленое: профилировщик исполняет файл С ДИСКА, и без
  // сохранения профиль был бы про старую версию — то есть про не то, что на экране.
  define(
    {
      id: 'python.profileLines',
      title: 'Python: профиль строк',
      category: 'Python',
      keywords: ['профилировщик', 'profile', 'производительность', 'горячие строки', 'узкое место'],
    },
    async () => {
      const path = editors.currentPath;
      if (!path) {
        showToast('Нет открытого файла', 'error');
        return;
      }
      if (!path.toLowerCase().endsWith('.py')) {
        showToast('Профилировать можно файл Python (.py)', 'error');
        return;
      }
      for (const document of documents.dirty()) await saveDocument(document);
      showToast('Профилирую: файл исполняется медленно, это нормально');
      const result = await rpc.request('python.profileLines', { path }).catch(() => null);
      if (!result) {
        showToast('Профилирование не запустилось', 'error');
        return;
      }
      if (result.failed) {
        showToast(result.message ?? 'Профилирование не удалось', 'error');
        return;
      }
      const { profile } = result;
      editors.setLineProfile(profile.files.map((file) => [file.path, highlightedLines(file)] as const));
      if (profile.error) {
        // Строки профиля всё же показываем: до падения программа что-то успела сделать.
        showToast(`Программа упала: ${profile.error.trim().split('\n').at(-1) ?? 'см. вывод'}`, 'error');
        return;
      }
      const top = hottestLines(profile, 1)[0];
      const hot = top
        ? ` · горячее всего: ${basename(top.path)}:${top.line.line} (${formatDuration(top.line.timeNs)})`
        : '';
      showToast(`${profileSummary(profile)}${hot}`);
    },
  );

  define({ id: 'python.clearProfileLines', title: 'Python: убрать подсветку профиля', category: 'Python' }, () => {
    editors.setLineProfile([]);
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
  define(
    {
      id: 'format.selection',
      title: 'Форматировать выделение',
      category: 'Файл',
      keybinding: 'Ctrl+K Ctrl+F',
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
      // Выделения нет — форматируем весь файл: как в VS Code, где команда участка без
      // выделения берёт документ целиком. Иначе команда молчала бы о «нечего делать».
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
  define(
    {
      id: 'editor.organizeImports',
      title: 'Упорядочить импорты',
      category: 'Редактор',
      keybinding: 'Shift+Alt+O',
      keywords: ['imports', 'import', 'импорт', 'organize'],
    },
    () => {
      const path = editors.currentPath;
      if (!path) {
        showToast('Нет открытого файла');
        return;
      }
      void runOrganizeImports(path);
    },
  );

  // Общий список рефакторингов от сервера: что он предложит для выделения (или символа
  // под кареткой) — извлечение, inline, вынести в файл и прочее. Это ответ на
  // «какие тут вообще есть рефакторинги» без угадывания подвида.
  define(
    {
      id: 'editor.refactor',
      title: 'Рефакторинг…',
      category: 'Редактор',
      keybinding: 'Ctrl+Shift+R',
      keywords: ['refactor', 'рефакторинг', 'все действия'],
    },
    () => {
      const path = editors.currentPath;
      if (!path) {
        showToast('Нет открытого файла');
        return;
      }
      void runRefactorMenu(path);
    },
  );

  // Извлечение в переменную или функцию — рефакторинг от сервера: у нас только запрос,
  // список предложенного и применение. Выделение задаёт, что именно выносить.
  define(
    {
      id: 'editor.extractSymbol',
      title: 'Извлечь в переменную или функцию',
      category: 'Редактор',
      keywords: ['refactor', 'extract', 'извлечь', 'переменная', 'функция'],
    },
    () => {
      const path = editors.currentPath;
      if (!path) {
        showToast('Нет открытого файла');
        return;
      }
      void runRefactor(path, 'extract');
    },
  );

  // «Разворачивание» (inline) — обратный рефакторинг: тело символа встаёт на место вызова.
  define(
    {
      id: 'editor.inlineSymbol',
      title: 'Развернуть (inline)',
      category: 'Редактор',
      keywords: ['refactor', 'inline', 'развернуть', 'встроить'],
    },
    () => {
      const path = editors.currentPath;
      if (!path) {
        showToast('Нет открытого файла');
        return;
      }
      void runRefactor(path, 'inline');
    },
  );

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
      showToast(steps.length > 0 ? `Макрос записан: действий ${steps.length}` : 'Макрос пуст: ни одного действия');
      refreshStatus();
      return;
    }
    editors.startMacro();
    showToast('Запись макроса началась: остановить — той же командой');
    refreshStatus();
  });

  const playMacro = (times: number): void => {
    const steps = editors.macroSteps();
    if (steps.length === 0) {
      showToast('Макрос не записан');
      return;
    }
    if (!editors.currentPath) {
      showToast('Откройте файл: макрос выполняется в редакторе');
      return;
    }
    let done = 0;
    for (let i = 0; i < times; i += 1) done += editors.playMacro(steps);
    showToast(times > 1 ? `Макрос выполнен ${times} раз (шагов: ${done})` : `Макрос выполнен: шагов ${done}`);
  };

  define({ id: 'editor.macroPlay', title: 'Макрос: выполнить', category: 'Редактор' }, () => playMacro(1));

  define({ id: 'editor.macroPlayCount', title: 'Макрос: выполнить несколько раз…', category: 'Редактор' }, async () => {
    const answer = await promptValue({
      title: 'Сколько раз выполнить макрос?',
      label: 'Число повторов',
      value: '5',
    });
    if (answer === null) return;
    const times = Number(answer.trim());
    if (!Number.isInteger(times) || times < 1 || times > 1000) {
      showToast('Число повторов — целое от 1 до 1000', 'error');
      return;
    }
    playMacro(times);
  });

  /**
   * Vim-режим: модальное управление клавишами. Настройка переживает перезапуск, а
   * состояние (текущий режим) живёт в вводе редактора. Переключение применяется сразу,
   * не дожидаясь повторного чтения настроек.
   */
  define({ id: 'editor.toggleVim', title: 'Vim-режим: включить или выключить', category: 'Редактор' }, () => {
    const next = !settings.editor.vimMode;
    settings = { ...settings, editor: { ...settings.editor, vimMode: next } };
    editors.setVimMode(next);
    refreshStatus();
    showToast(next ? 'Vim-режим включён' : 'Vim-режим выключен');
    void saveSettingsPatch({ editor: { vimMode: next } }).catch(() => undefined);
  });

  /**
   * Emacs-режим: сочетания Ctrl/Alt поверх обычного ввода. Переключение применяется
   * сразу (и к уже открытым панелям), а не дожидается повторного чтения настроек.
   */
  define({ id: 'editor.toggleEmacs', title: 'Emacs-режим: включить или выключить', category: 'Редактор' }, () => {
    const next = !settings.editor.emacsMode;
    settings = { ...settings, editor: { ...settings.editor, emacsMode: next } };
    editors.setEmacsMode(next);
    showToast(next ? 'Emacs-режим включён' : 'Emacs-режим выключен');
    void saveSettingsPatch({ editor: { emacsMode: next } }).catch(() => undefined);
  });

  // Орфография: добавить слово под курсором в словарь или пропустить его на сеанс.
  define(
    {
      id: 'editor.addToDictionary',
      title: 'Орфография: добавить слово в словарь',
      category: 'Редактор',
      keywords: ['spell', 'dictionary', 'орфография', 'словарь'],
    },
    () => {
      if (!editors.addSpellingWordToDictionary()) showToast('Под курсором нет слова с ошибкой');
    },
  );

  define(
    {
      id: 'editor.ignoreSpelling',
      title: 'Орфография: пропустить слово',
      category: 'Редактор',
      keywords: ['spell', 'ignore', 'орфография', 'пропустить'],
    },
    () => {
      if (!editors.ignoreSpellingWord()) showToast('Под курсором нет слова с ошибкой');
    },
  );

  define(
    {
      id: 'editor.toggleSpellcheck',
      title: 'Орфография: включить или выключить проверку',
      category: 'Редактор',
      keywords: ['spell', 'spellcheck', 'орфография'],
    },
    () => {
      void saveSettingsPatch({ editor: { spellcheck: !settings.editor.spellcheck } });
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
        showToast('Сначала откройте папку проекта', 'error');
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

  define({ id: 'view.toggleTheme', title: 'Переключить тему', category: 'Вид' }, async () => {
    await theme.toggle();
    showToast(`Тема: ${theme.resolved === 'dark' ? 'тёмная' : 'светлая'}`);
  });

  define({ id: 'view.theme.dark', title: 'Тема: тёмная', category: 'Вид' }, () => theme.set('dark'));
  define({ id: 'view.theme.light', title: 'Тема: светлая', category: 'Вид' }, () => theme.set('light'));
  define({ id: 'view.theme.system', title: 'Тема: как в системе', category: 'Вид' }, () => theme.set('system'));

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
   * Чем занят языковой сервер: состояния по токенам. Сервер шлёт `begin`/`report`/`end`
   * (`$/progress`); показываем последнее начатое занятие, при `end` убираем. Токенов бывает
   * несколько сразу (индексация и поиск параллельно), поэтому их и держим списком.
   */
  const lspProgress = new Map<string, WorkProgress>();

  function applyLspProgress(progress: LspProgress): void {
    if (progress.kind !== 'work') return;
    const key = String(progress.token);
    if (progress.phase === 'end') lspProgress.delete(key);
    else lspProgress.set(key, progress);
    const active = [...lspProgress.values()].at(-1) ?? null;
    statusBar.update({
      progress: active ? { label: progressLabel(active), percentage: active.percentage ?? null } : null,
    });
  }

  const refreshStatus = (): void => {
    const active = openEditors.active;
    const projectTools = tools.get();
    // Отступ и язык — свойства файла: у Python четыре пробела, у Makefile таб,
    // поэтому в статусбаре видно ФАКТИЧЕСКОЕ значение, а не общее из настроек.
    const language = active?.languageId ?? null;
    const indent = settings.editor.languageIndent && language ? languageIndent(language) : null;
    // Язык сменился — перечитываем состав серверов: сервер поднимается при первом
    // открытии файла языка, и до этого про него ничего не известно.
    if (settings.lsp.enabled && language && language !== lspChipLanguage) {
      lspChipLanguage = language;
      void refreshLspStatus();
    }
    statusBar.update({
      readOnly: active?.readOnly ?? false,
      language: language ? languageLabel(language) : null,
      lsp: settings.lsp.enabled ? lspChipFor(language, lspStatus) : null,
      version: active?.version ?? 0,
      tabSize: indent?.tabSize ?? settings.editor.tabSize,
      useTabs: indent ? !indent.insertSpaces : !settings.editor.insertSpaces,
      branch: git.branch,
      changes: git.changeCount,
      projectKindId: projectScan && projectScan.kind.source !== 'none' ? projectScan.kind.id : null,
      problems: editors.problemCounts(),
      // Vim-режим: значок в строке состояния, когда режим включён.
      vim: settings.editor.vimMode ? editors.vimMode() : null,
      // Идёт запись макроса — точка и число действий: забыть про запись легко.
      macro: editors.isRecordingMacro() ? { steps: editors.macroSteps().length } : null,
      // Виджет окружения говорит на языке проекта: у Node — версия и менеджер,
      // у Python — интерпретатор. Раньше в Node-проекте тут висел Python.
      env: envWidgetLabel(projectScan?.kind.id ?? null, projectTools, settings.run.pythonPath),
    });

    // Имя открытого файла — в центре шапки; его сменяет кнопка запуска, когда есть
    // что запускать, и оно остаётся запасным вариантом на пустом месте.
    const project = workspace.current?.name;
    // Имя файла и проекта — и в шапке, и в заголовке окна. Заголовок описывает
    // содержимое, а не повторяет имя приложения: оно тут только запасной вариант,
    // когда ничего не открыто.
    const title = active ? (project ? `${basename(active.path)} — ${project}` : basename(active.path)) : 'chui_iDE';
    topBarName.textContent = title;
    document.title = title;
    // Название приложения — моношрифтом (JetBrains Mono), имя файла — интерфейсным.
    topBarName.classList.toggle('is-brand', !active);
    topBarName.title = active?.path ?? 'chui_iDE';
  };

  const syncEmptyState = (): void => emptyState.update(openEditors.paths.length > 0);

  const applySettings = (next: Settings): void => {
    const previous = settings;
    settings = next;
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
    if (previous.editor.spellWords !== next.editor.spellWords) spell.setUserWords(next.editor.spellWords);
    // Автосохранение сменили — режим или паузу: снимаем уже назначенную запись или
    // ставим новую с новой задержкой. Иначе правка ждала бы прежней задержки.
    if (
      previous.editor.autoSave !== next.editor.autoSave ||
      previous.editor.autoSaveDelayMs !== next.editor.autoSaveDelayMs
    ) {
      autoSave.settingsChanged();
    }
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
  documents.onDidClose((document) => diskDiffWarned.delete(document.path));

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
      case PushTopic.SettingsChanged:
        baseSettings = message.payload as Settings;
        applySettings(rebuildSettings());
        break;
      case PushTopic.LspProgress:
        applyLspProgress(message.payload as LspProgress);
        break;
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
    // Файл стал активным — показываем его, а вкладка чата просто ждёт в полосе.
    if (openEditors.active) hideChatTab();
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
      node
        ? nodeTestsTarget(tools.get(), node, selector, { platform: info.platform })
        : pytestTarget(tools.get(), selector, { disabledPlugins: pytestDisabledPlugins }),
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
  // события контекстного меню нет координат окна, а меню ставится по месту нажатия.
  const lastPointer = { x: 0, y: 0 };

  /**
   * Правый клик по полоске изменения: меню одного БЛОКА правок.
   *
   * Работаем по строке, а строки у полосок и у diff согласуются только с рабочим
   * деревом: полоски считаются по тексту редактора, а git про буфер не знает. Чтобы
   * они не разъехались, сперва сохраняем файл — иначе `git apply` приложил бы блок
   * к другой версии файла. Не сохранилось (отказ от перезаписи) — меню не показываем.
   *
   * Блоков два набора: неиндексированные (`unstaged`) можно проиндексировать или
   * откатить, проиндексированные (`staged`) — убрать из индекса. Что под строкой,
   * решает `hunkAtLine` (общая граница блоков с `git-hunks`).
   */
  const openChangeStripMenu = async ({ path, line }: { path: string; line: number }): Promise<void> => {
    const document = documents.get(path) ?? null;
    if (document?.dirty) {
      if (!(await saveDocument(document))) return;
    }

    const hunks = await git.fileHunks(path).catch(() => ({ unstaged: [], staged: [] }));
    const unstagedIndex = hunkAtLine(hunks.unstaged, line);
    const stagedIndex = hunkAtLine(hunks.staged, line);

    if (unstagedIndex === null && stagedIndex === null) {
      showToast('Правок в этой строке нет', 'info');
      return;
    }

    /** После правки блока: полоски пересчитать, файл (если менялся на диске) перечитать. */
    const after = (reload: boolean): void => {
      changeGutter.refreshContent();
      if (reload) void reloadIfOpen(path);
      explorer.scheduleRefresh();
    };

    const items: PopupMenuItem[] = [];
    if (unstagedIndex !== null) {
      items.push({
        label: 'Проиндексировать это изменение',
        onSelect: () => void git.stageHunk(path, unstagedIndex).then(() => after(false)),
      });
    }
    if (stagedIndex !== null) {
      items.push({
        label: 'Убрать это изменение из индекса',
        onSelect: () => void git.unstageHunk(path, stagedIndex).then(() => after(false)),
      });
    }
    if (unstagedIndex !== null) {
      // Откат теряет правки безвозвратно — спрашиваем системным диалогом, как и у отката файла.
      items.push({ separator: true });
      items.push({
        label: 'Откатить это изменение',
        danger: true,
        onSelect: () => {
          void (async () => {
            const { confirmed } = await rpc.request('dialog.confirm', {
              title: 'Откатить изменение',
              message: `Вернуть строку к состоянию индекса?`,
              detail: `${workspace.relative(path)} — блок изменений у строки ${line}. Правки в этом блоке будут потеряны.`,
              confirmLabel: 'Откатить',
            });
            if (!confirmed) return;
            await git.discardHunk(path, unstagedIndex);
            after(true);
          })();
        },
      });
    }

    showPopupMenu(items, lastPointer.x, lastPointer.y);
  };
  document.addEventListener(
    'mousedown',
    (event) => {
      lastPointer.x = event.clientX;
      lastPointer.y = event.clientY;
    },
    true,
  );
  editors.onBreakpointMenu(openBreakpointMenu);
  // Правый клик по полоске изменения: меню блока (индексировать, убрать, откатить).
  editors.onChangeStripMenu((hit) => void openChangeStripMenu(hit));

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
      })();
      void ensureLspServers();
      // Активный корень сменился — у него может быть свой набор настроек дерева.
      explorer.applySettings(resolveExplorerSettings(settings.explorer, workspace.root));
      return;
    }

    // Сменился ПРОЕКТ: окружение нового греем сразу (попап открывается без ожидания).
    void (async () => {
      await tools.refresh(workspace.root);
      syncRunControl();
      await refreshScan();
      preloadEnvironment();
    })();
    // Новый проект — могли появиться свои серверы в окружении (pylsp в venv).
    void ensureLspServers();
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

  theme.onDidChange((scheme) => {
    editors.setTheme(scheme);
    terminalPanel.setScheme(scheme);
    setHighlightScheme(scheme);
    syncThemeButton();
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
  await ensureLspServers();
  // Состав серверов читаем сразу: чип в статусбаре покажет, что поднято и откуда.
  void refreshLspStatus();
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
      theme,
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

/** Подпись вида экспорта для списка мест: коротко и по-русски. */
function exportKindLabel(kind: string): string {
  if (kind === 'default') return 'по умолчанию';
  if (kind === 'star') return 'звёздочкой';
  if (kind === 'named') return 'списком';
  return 'объявлением';
}

/** Подпись объявления типа для списка: вид и его прямые родители. */
function describeType(entry: { kind: string; bases: string[] }): string {
  if (entry.bases.length === 0) return entry.kind;
  return `${entry.kind} · ${entry.bases.join(', ')}`;
}
