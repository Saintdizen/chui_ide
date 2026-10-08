import { PushTopic, type Settings } from '../shared/api';
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
import { OpenEditors } from './core/open-editors';
import { ProjectToolsModel, type ProjectTools } from './core/project-tools';
import { RpcClient } from './core/rpc';
import { collectRunTargets, entryLine, type RunTarget, type RunnableFile } from './core/run-config';
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
import { closePopupMenu, isPopupOpen, showPopupMenu } from './ui/popup-menu';
import { createRunButton } from './ui/run-button';
import { createSearchView } from './ui/search';
import { createSourceControl } from './ui/source-control';
import { createStatusBar } from './ui/statusbar';
import { createSettingsModal } from './ui/settings-modal';
import { createTabs } from './ui/tabs';
import { createTerminalPanel } from './ui/terminal';
import { showToast } from './ui/toast';

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
  const statusBar = createStatusBar(commands);
  layout.statusBarHost.appendChild(statusBar.element);

  let settings = await rpc.request('settings.get');
  const info = await rpc.request('app.info');
  console.info(`[chui] Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node} · ${info.platform}`);

  // Тема: main — источник истины, сервис знает и выбор пользователя, и фактическую схему.
  const theme = new ThemeService(rpc, settings.appearance.theme);

  const editors = new EditorService(layout.editorHost, documents, settings.editor, theme.monacoThemeId);
  const edits = new EditService({ documents, editors, rpc });
  // Приёмник обратных вызовов из main: правки агента приходят сюда.
  const host = new HostService();

  // Настройки — модальное окно поверх всего: и шапка, и панель AI открывают одно и то же.
  const settingsModal = createSettingsModal({ rpc, commands, theme });
  document.body.appendChild(settingsModal.element);

  /* ── панели ────────────────────────────────────────────────────────────── */

  const explorer = createExplorer({ workspace, rpc, commands, openEditors, git });
  layout.sidebarBody.appendChild(explorer.element);

  const sourceControl = createSourceControl({ git, workspace, commands });
  const diffView = createDiffView({ createDiff: (container) => editors.createDiff(container), git });
  layout.editorHost.appendChild(diffView.element);

  const searchView = createSearchView({ rpc, commands, workspace });
  const terminalPanel = createTerminalPanel({ rpc, cwd: () => workspace.root, scheme: theme.resolved });

  const dock = createDock();
  dock.register({ id: 'search', title: 'Поиск', element: searchView.element, onShow: () => searchView.focus() });
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

  const chat = createChatPanel({
    rpc,
    documents,
    editors,
    edits,
    commands,
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
    return collectRunTargets(runnableFileOf(document), tools.get());
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
    viewButtons.get('ai')?.classList.toggle('is-active', layout.rightVisible);
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

  const saveDocument = async (document: TextDocument): Promise<void> => {
    await rpc.request('workspace.writeFile', { path: document.path, text: document.value });
    document.markSaved();
    showToast(`Сохранено: ${basename(document.path)}`);
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
    const target = targetsFor(openEditors.active)[0];
    if (!target) {
      showToast('Запускать нечего: нужен скрипт или задача в package.json', 'error');
      return;
    }
    await runTarget(target);
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
    layout.setRightVisible(!layout.rightVisible);
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
      },
      () => menuButton.classList.remove('is-menu-open'),
    );
  });

  define({ id: 'palette.open', title: 'Палитра команд', category: 'Вид', keybinding: 'Ctrl+Shift+P' }, () => {
    palette.open();
  });

  define({ id: 'settings.open', title: 'Настройки', category: 'Настройки', keybinding: 'Ctrl+,' }, () => settingsModal.open());

  define({ id: 'settings.revealFile', title: 'Открыть settings.json', category: 'Настройки' }, async () => {
    const result = await rpc.request('settings.revealFile');
    showToast(`Настройки: ${result.path}`);
  });

  // Диагностика нужна, когда приходит «в чате не подсвечивается код»:
  // отчёт в консоли показывает, какие языки дают токены и с каким цветом.
  define({ id: 'ai.highlightProbe', title: 'AI: диагностика подсветки кода', category: 'AI' }, async () => {
    const report = await diagnoseHighlighting();
    console.info(`[chui] подсветка кода\n${report}`);
    showToast('Отчёт о подсветке — в консоли (Ctrl+Shift+I)');
  });

  define({ id: 'ai.newChat', title: 'Новый диалог', category: 'AI' }, () => {
    layout.setRightVisible(true);
    syncViewButtons();
    chat.newChat();
  });

  define({ id: 'ai.stop', title: 'Остановить генерацию', category: 'AI' }, () => chat.stop());

  define({ id: 'ai.openInEditor', title: 'Перенести чат в окно редактора', category: 'AI', keybinding: 'Ctrl+Alt+E' }, () =>
    showChatTab(),
  );

  define({ id: 'ai.backToPanel', title: 'Вернуть чат в боковую панель', category: 'AI' }, () => setChatInEditor(false));

  define({ id: 'ai.explainSelection', title: 'Объяснить выделение', category: 'AI' }, async () => {
    layout.setRightVisible(true);
    syncViewButtons();
    await chat.askAboutSelection('explain');
  });

  define({ id: 'ai.fixSelection', title: 'Исправить выделение', category: 'AI' }, async () => {
    layout.setRightVisible(true);
    syncViewButtons();
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
    // Инструменты проекта зависят от настроек запуска: путь к интерпретатору
    // и менеджеру пакетов могли поменять — перепроверяем проект заново.
    void tools.refresh(workspace.root, true).then(() => {
      syncRunControl();
      refreshStatus();
    });
    // Схема могла прийти извне — догоняем Monaco и xterm.
    theme.apply();
    refreshStatus();
  };

  dock.onVisibilityChange((visible) => {
    layout.setDockVisible(visible);
    if (visible) terminalPanel.fit();
    syncViewButtons();
  });

  rpc.onPush((message) => {
    switch (message.topic) {
      case PushTopic.MenuCommand: {
        const payload = message.payload as { command?: string };
        if (payload?.command) void commands.execute(payload.command);
        break;
      }
      case PushTopic.WorkspaceChanged:
        explorer.scheduleRefresh();
        break;
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
  });
  // Счётчик правок и ветка в статусбаре живут по тому же снимку, что и дерево.
  git.onDidChange(refreshStatus);
  documents.onDidChange(() => {
    refreshStatus();
    // Правка текста может добавить или убрать точку входа — значок запуска
    // обязан следовать за файлом, а не жить до перезапуска.
    syncRunControl();
  });
  // Значок ▶ в жёлобе: запускаем тот файл, в котором на него нажали.
  editors.onRunMarker(({ path }) => {
    const target = targetsFor(documents.get(path) ?? null).find((item) => item.id === `file:${path}`);
    if (target) void runTarget(target);
  });
  tools.onDidChange(() => {
    syncRunControl();
    refreshStatus();
  });
  workspace.onDidChange(() => {
    refreshStatus();
    syncEmptyState();
    void tools.refresh(workspace.root).then(() => syncRunControl());
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
    { combo: 'Ctrl+,', command: 'settings.open' },
    { combo: 'Ctrl+Shift+G', command: 'view.showChanges' },
    { combo: 'Ctrl+`', command: 'view.showTerminal' },
    { combo: 'Ctrl+Alt+E', command: 'ai.openInEditor' },
    // Запуск — как в PyCharm (Shift+F10) и VS Code (Ctrl+F5): обе привычки живут рядом.
    { combo: 'Ctrl+F5', command: 'run.file' },
    { combo: 'Shift+F10', command: 'run.choose' },
    // Меню — как в приложениях KDE: Alt+F10 открывает его с клавиатуры.
    { combo: 'Alt+F10', command: 'app.showMenu' },
  ]).attach(window);

  // Проект мог быть открыт ещё в стартовом окне: main помнит корень, и окно IDE
  // забирает его себе, чтобы не спрашивать папку второй раз. Делаем это после
  // подписок — иначе дерево, панель изменений и статусбар не узнают об открытии.
  const current = await rpc.request('workspace.current');
  if (current.root) await workspace.open(current.root);

  await tools.refresh(workspace.root);
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
 */
function toolLabel(language: string | null, project: ProjectTools): string | null {
  if (!language || !project.root) return null;
  if (language === 'python') return project.pythonLabel;
  if (language === 'javascript' || language === 'typescript') {
    return project.hasPackageJson ? `${project.packageManager}` : 'node';
  }
  return null;
}
