import type {
  BreakpointRecord,
  DebugLaunchOptions,
  SessionState,
  UnsavedBuffer,
  WorkspaceInfo,
} from "../../shared/api";
import { sanitizeMacroSteps } from "../editor/input/macro";
import { selectUnsavedBuffers } from "../../shared/session";
import type { BookmarkRecord } from "../../shared/bookmarks";
import type { NotesState } from '../../shared/notes';
import type { FileLabelRecord } from "../../shared/file-labels";
import type { WorkspaceRoot } from "../../shared/workspace-roots";
import type { DockView } from "../ui/dock";
import type { DebugController } from "./debug";
import type { DocumentStore } from "./document-store";
import type { EditorApi } from "./editor-api";
import type { OpenEditors } from "./open-editors";
import type { RpcClient } from "./rpc";

/** Проводник в той части, что нужна сессии: какие папки раскрыты и что закреплено. */
export interface ExpandedTree {
  expandedPaths(): string[];
  restoreExpanded(paths: readonly string[]): void;
  /** Прокрутка дерева, px: место, где человек работал в проекте. */
  scrollTop(): number;
  restoreScroll(top: number): void;
  /** Закреплённые файлы и папки дерева — их рабочее место тоже помнит. */
  pinnedPaths(): string[];
  restorePinned(paths: readonly string[]): void;
  /** Метки файлов в дереве — цветные ярлыки; тоже часть рабочего места проекта. */
  labels(): FileLabelRecord[];
  restoreLabels(records: unknown): void;
  /** Заметки человека: пишутся в сессию и возвращаются из неё при запуске. */
  notesOf?(): NotesState;
  restoreNotes?(notes: NotesState): void;
}

/**
 * Рабочая область в той части, что нужна сессии: её корни. Несколько папок в одном
 * окне — часть рабочего места, а не общий макет, поэтому помнит их сессия проекта.
 */
export interface WorkspaceRoots {
  readonly roots: WorkspaceRoot[];
  addRoot(root: string): Promise<WorkspaceInfo>;
  setActiveRoot(root: string): Promise<WorkspaceInfo>;
}

/** Панель отладки в той части, что нужна сессии: наблюдаемые выражения. */
export interface WatchPanel {
  getWatch(): string[];
  setWatch(expressions: readonly string[]): void;
}

/** Закладки в той части, что нужна сессии: отдать список и принять его обратно. */
export interface BookmarkSource {
  records(): BookmarkRecord[];
  restore(records: unknown): void;
}

/** Макет в той части, что нужна сессии: видимость правой и нижней панелей. */
export interface LayoutVisibility {
  readonly rightVisible: boolean;
  readonly dockVisible: boolean;
  setRightVisible(visible: boolean): void;
}

/** Есть ли что писать: пустые заметки в файл сессии не кладём. */
function hasNotes(state: NotesState): boolean {
  return (state.project ?? '').length > 0 || state.files.length > 0;
}

export interface SessionDeps {
  rpc: RpcClient;
  documents: DocumentStore;
  openEditors: OpenEditors;
  editors: EditorApi;
  debug: DebugController;
  explorer: ExpandedTree;
  /** Заметки: читаются при запуске, пишутся при изменении. */
  notesOf?(): NotesState;
  restoreNotes?(notes: NotesState): void;
  /**
   * Вкладки терминала: их каталоги и та, что на экране. Необязательно — без этого
   * терминал не входит в сессию проекта.
   */
  terminalTabs?: {
    state(): { cwd: string[]; active: number };
    restore(cwd: readonly string[], active: number): Promise<void>;
  };
  /** Группа вкладок на экране — чтобы сессия её записала (читается при сохранении). */
  tabGroup?: () => "editor" | "terminal";
  /** Вернуть группу прошлой сессии: показать терминал вместо редактора (только вид). */
  restoreTabGroup?: (group: "editor" | "terminal") => void;
  workspace: WorkspaceRoots;
  dock: DockView;
  debugPanel: WatchPanel;
  bookmarks: BookmarkSource;
  layout: LayoutVisibility;
  /** Показан ли ассистент: место правой панели занимается только под него. */
  aiEnabled: () => boolean;
  openPath: (path: string) => Promise<void>;
  withoutPersist: (run: () => void) => void;
  syncViewButtons: () => void;
  getDebugOptions: () => DebugLaunchOptions;
  setDebugOptions: (options: DebugLaunchOptions) => void;
}

export interface SessionControl {
  /** Ключ текущего проекта — по нему кладётся сессия. `null`, пока проект не открыт. */
  root(): string | null;
  setRoot(root: string | null): void;
  restore(root: string): Promise<void>;
  scheduleSave(): void;
  /**
   * Записать после ДЛИННОЙ паузы: правка текста, каретка, прокрутка, раскрытая папка.
   * Такие события идут потоком, а в записи лежит в том числе несохранённый текст.
   */
  scheduleDeepSave(): void;
  /** Сохранить немедленно, без отложенного таймера — на закрытии окна. */
  saveNow(): void;
}

/** Задержка отложенной записи: серия быстрых изменений пишет файл один раз. */
const SAVE_DEBOUNCE_MS = 400;

/**
 * Пауза перед «глубокой» записью — с несохранённым текстом и тихими изменениями места
 * (каретка, прокрутка, раскрытая папка). Такие события идут потоком: текст меняется на
 * каждое нажатие, а сессия — файл целиком. Дольше, чем у вкладок, чтобы набор не тормозил.
 */
const DEEP_SAVE_DEBOUNCE_MS = 2000;

/**
 * Рабочее место проекта: что открыто, что раскрыто и какие точки останова стоят.
 * Живёт отдельно от сборки окна — приложению о нём напоминают только две вещи:
 * восстановить место при открытии проекта и попросить сохранить при изменении.
 */
export function createSessionControl(deps: SessionDeps): SessionControl {
  const {
    rpc,
    documents,
    openEditors,
    editors,
    debug,
    explorer,
    workspace,
    dock,
    debugPanel,
    layout,
  } = deps;
  /** Вкладки терминала без доступа к нему нет: тогда это поле сессии просто не пишется. */
  const terminal = deps.terminalTabs;

  /** Какой проект сейчас восстановлен: ключ, по которому кладётся сессия. */
  let root: string | null = null;
  /** Пока идёт восстановление, сохранять нельзя — иначе затрём файл пустотой. */
  let restoring = false;
  let saveTimer = 0;
  /** Свой таймер для тихих изменений (текст, каретка, прокрутка) — они чаще состава вкладок. */
  let deepTimer = 0;

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
      Array<{
        line: number;
        condition?: string;
        hitCondition?: string;
        logMessage?: string;
      }>
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
    for (const [path, list] of debug.allBreakpoints())
      editors.setBreakpoints(path, list);
  };

  /**
   * Вернуть несохранённые правки в буферы. Текст ставится источником `programmatic`:
   * это не ввод человека, но и не диск — правка обязана остаться «не сохранённой»,
   * а буфер редактора обязан её подхватить (за это отвечает реестр документов).
   *
   * Возвращает пути, которые действительно получили текст: по ним видно, какие
   * вкладки надо показать, если их нет в списке открытых.
   */
  const restoreUnsaved = async (
    buffers: readonly UnsavedBuffer[],
  ): Promise<string[]> => {
    const restored: string[] = [];
    for (const item of buffers) {
      try {
        // Файла может не быть (удалили) — тогда возвращать правку некуда: вкладку
        // открывать нечем, а держать текст «в воздухе» незачем.
        if (!documents.get(item.path)) await deps.openPath(item.path);
      } catch {
        continue;
      }
      const document = documents.get(item.path);
      // Большой файл править нельзя — и вернуть в него правку тоже нечего.
      if (!document || document.readOnly) continue;
      // Место последней правки — до `setText`: правка может быть в конце файла,
      // а без курсора буфер откроется на первой строке, и человек будет искать
      // свою работу глазами. Восстановленный буфер — это «дочитал до этого места».
      // Место последней правки берём у документа: он помнит его с момента правки.
      const lastEdit = document.lastEdit;
      if (document.setText(item.text, "programmatic")) restored.push(item.path);
      else if (document.dirty) restored.push(item.path);
      if (lastEdit) editors.restoreCursorPositions({ [item.path]: lastEdit });
    }
    return restored;
  };

  /** Текущее рабочее место: что открыто, что раскрыто, какие панели видны. */
  const capture = (): SessionState => {
    const breakpoints = captureBreakpoints();
    const bookmarks = deps.bookmarks.records();
    const watch = debugPanel.getWatch();
    const exceptions = debug.exceptionFilters();
    const options = deps.getDebugOptions();
    const cursors = editors.cursorPositions();
    // Верхние строки — отдельно от каретки: см. `scrollPositions` редактора.
    const scrollTops = editors.scrollPositions();
    // Свёрнутое — тоже место работы: файл, где всё раскрыто, читается иначе.
    const foldedBlocks = editors.foldPositions();
    // Несохранённые правки — часть рабочего места: без них перезапуск (и любое
    // закрытие окна) терял бы работу, которую человек ещё не записал.
    const unsaved = selectUnsavedBuffers(
      documents
        .dirty()
        .map((document) => ({ path: document.path, text: document.value })),
    );
    // Записанный макрос — тоже часть рабочего места: его повторяют и после перезапуска.
    const macro = editors.macroSteps();
    const roots = workspace.roots.map((item) => item.root);
    return {
      // Корни области — только когда папок больше одной: обычный проект дублировать незачем.
      ...(roots.length > 1 ? { roots } : {}),
      tabs: [...openEditors.paths],
      ...(openEditors.active ? { activeTab: openEditors.active.path } : {}),
      // Порядок использования — отдельно от полосы: `Ctrl+Tab` после перезапуска должен
      // вести туда же, куда вёл до него.
      ...(openEditors.recent.length > 0
        ? { mru: [...openEditors.recent] }
        : {}),
      expanded: explorer.expandedPaths(),
      // Где стояла прокрутка дерева. Ноль не пишем: свежий проект начинается сверху.
      ...(explorer.scrollTop() > 0
        ? { explorerScroll: explorer.scrollTop() }
        : {}),
      pinned: explorer.pinnedPaths(),
      ...(explorer.labels().length > 0 ? { labels: explorer.labels() } : {}),
      // Заметки пишем только когда они есть: пустой блок в файле сессии —
      // мусор, который пережил бы сотню проектов.
      ...(deps.notesOf && hasNotes(deps.notesOf()) ? { notes: deps.notesOf() } : {}),
      ...(dock.activeId ? { dockActive: dock.activeId } : {}),
      // Вкладки терминала — часть рабочего места проекта: они открываются в его папках,
      // и человек возвращается к тому же. Оболочки живут только в текущем окне, поэтому
      // пишем каталоги, а восстанавливаем сессии заново.
      // Группа вкладок: фиксируем только терминал — «редактор» и есть умолчание.
      ...(deps.tabGroup && deps.tabGroup() === "terminal"
        ? { activeTabGroup: "terminal" as const }
        : {}),
      ...(terminal && terminal.state().cwd.length > 0
        ? {
            terminalTabs: terminal.state().cwd,
            terminalActive: terminal.state().active,
          }
        : {}),
      // Видимость панелей сюда не входит: это общий макет (settings), а не
      // свойство проекта. Рабочее место конкретной папки — вкладки и папки.
      // Параметры запуска, наблюдение и точки останова отладки — часть рабочего места:
      // пустые не пишем, чтобы файл не разрастался полями-пустышками.
      ...(Object.keys(options).length > 0 ? { debugLaunch: options } : {}),
      ...(watch.length > 0 ? { debugWatch: watch } : {}),
      ...(exceptions.uncaught || exceptions.caught
        ? { debugExceptions: exceptions }
        : {}),
      ...(breakpoints.length > 0 ? { breakpoints } : {}),
      // Закладки — тоже рабочее место: пустые не пишем, чтобы файл не пух полями-пустышками.
      ...(bookmarks.length > 0 ? { bookmarks } : {}),
      // Место работы в каждом файле — часть рабочего места: без него после
      // перезапуска вкладки те же, а курсор в начале файла.
      ...(Object.keys(cursors).length > 0 ? { cursors } : {}),
      // Прокрутка — та же часть рабочего места: курсор в начале файла — не то, что ждёшь.
      ...(Object.keys(scrollTops).length > 0 ? { scrollTops } : {}),
      ...(Object.keys(foldedBlocks).length > 0 ? { foldedBlocks } : {}),
      ...(unsaved.length > 0 ? { unsaved } : {}),
      ...(macro.length > 0 ? { macro: [...macro] } : {}),
    };
  };

  /** Записать сессию сейчас, если есть проект и не идёт восстановление. */
  const persist = (): void => {
    if (!root || restoring) return;
    // не сохранилось — не повод мешать работе
    void rpc
      .request("session.save", { root, state: capture() })
      .catch(() => undefined);
  };

  /**
   * Записать сессию после длинной паузы. Годится и для правок текста, и для тихих
   * изменений места — каретка, прокрутка, раскрытая папка: они входят в ту же запись, а
   * идут потоком, поэтому писать файл на каждое движение ни к чему.
   */
  const scheduleDeepSave = (): void => {
    if (!root || restoring) return;
    if (deepTimer) window.clearTimeout(deepTimer);
    deepTimer = window.setTimeout(() => {
      deepTimer = 0;
      persist();
    }, DEEP_SAVE_DEBOUNCE_MS);
  };

  const scheduleSave = (): void => {
    if (!root || restoring) return;
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      persist();
    }, SAVE_DEBOUNCE_MS);
  };

  /**
   * Восстановление рабочего места при открытии проекта: вкладки, раскрытые
   * папки, видимость панелей. Файлы могли исчезнуть — открытие каждого в `try`,
   * чтобы один пропавший не сорвал восстановление остальных.
   */
  const restore = async (target: string): Promise<void> => {
    if (root === target) return;
    root = target;
    restoring = true;
    try {
      openEditors.closeAll();
      const state = await rpc.request("session.load", { root: target });

      // Макрос из прошлой сессии: повтор доступен сразу, без новой записи.
      editors.restoreMacro(sanitizeMacroSteps(state.macro));

      // Несохранённые правки возвращаем ДО открытия вкладок: `open` подхватит готовый
      // текст из документа, и на экране сразу будет то, что человек не успел сохранить.
      const dirtyPaths = await restoreUnsaved(state.unsaved ?? []);

      // Позиции курсоров ставим ДО открытия файлов: `open` подхватит их при показе.
      editors.restoreCursorPositions(state.cursors ?? {});
      // Верхние строки — там же: `open` встанет на них тем же показом.
      editors.restoreScrollPositions(state.scrollTops ?? {});
      // Свёртка — до открытия вкладок: вид применит её, когда придут диапазоны.
      editors.restoreFoldPositions(state.foldedBlocks ?? {});

      for (const path of state.tabs) {
        try {
          await deps.openPath(path);
        } catch {
          // файла больше нет — просто пропускаем
        }
      }
      // Буфер мог быть открыт ради правки, а вкладки в списке не оказаться: показываем
      // его, иначе работа вернулась бы «в никуда».
      for (const path of dirtyPaths) {
        if (openEditors.has(path)) continue;
        try {
          await deps.openPath(path);
        } catch {
          // файла нет — правку вернуть некуда, и вкладку открывать нечем
        }
      }
      if (state.activeTab && openEditors.has(state.activeTab)) {
        openEditors.activate(state.activeTab);
        const document = documents.get(state.activeTab);
        if (document) editors.open(document);
      }
      // После показа активной: порядок использования начинается с неё.
      openEditors.restoreRecent(state.mru ?? []);

      explorer.restoreExpanded(state.expanded);
      // Прокрутка — ПОСЛЕ раскрытия: до него дерево короче, и браузер обрезал бы её до нуля.
      explorer.restoreScroll(state.explorerScroll ?? 0);
      explorer.restorePinned(state.pinned ?? []);
      explorer.restoreLabels(state.labels ?? []);
      // Заметки — в своё состояние хозяина: дерево их только читает.
      deps.restoreNotes?.(state.notes ?? { project: null, files: [] });
      // Корни области: открываем заново те, что были, и возвращаем активный. Сбой на
      // одном (папку могли удалить) не отменяет остальные.
      for (const extra of state.roots ?? []) {
        if (extra === target) continue;
        await workspace.addRoot(extra).catch(() => undefined);
      }
      await workspace.setActiveRoot(target).catch(() => undefined);
      // Параметры запуска, наблюдение и точки останова — из прошлой сессии проекта.
      deps.setDebugOptions(state.debugLaunch ?? {});
      debugPanel.setWatch(state.debugWatch ?? []);
      if (state.debugExceptions)
        void debug.setExceptionFilters(state.debugExceptions);
      restoreBreakpoints(state.breakpoints ?? []);
      // Закладки: список восстанавливает модель, а редактор рисует значки по её событию.
      deps.bookmarks.restore(state.bookmarks ?? []);
      // Видимость панелей — из общего макета (settings), а не из сессии проекта.
      // Из сессии берём только то, какая вкладка нижней панели была открыта.
      deps.withoutPersist(() => {
        // Панель ассистента не показываем, если AI выключен: её место свободно.
        layout.setRightVisible(layout.rightVisible && deps.aiEnabled());
        // Нижняя панель: видимость — из макета, а какая вкладка открыта — из сессии.
        const dockTab = state.dockActive ?? dock.activeId;
        if (layout.dockVisible && dockTab) dock.show(dockTab);
        else if (!layout.dockVisible) dock.hide();
      });
      // Вкладки терминала — последними: их создание ждёт pty, а место в окне уже собрано.
      // Ждать не надо: панель дополняется сама, по мере создания сессий.
      if (terminal && state.terminalTabs && state.terminalTabs.length > 0) {
        void terminal.restore(state.terminalTabs, state.terminalActive ?? 0);
      }
      // Группа — последней: восстановление вкладок терминала само делает его активным.
      if (state.activeTabGroup === "terminal")
        deps.restoreTabGroup?.("terminal");
    } catch {
      // повреждённый файл сессии не должен мешать — начинаем с чистого места
    } finally {
      restoring = false;
    }
    deps.syncViewButtons();
    scheduleSave();
  };

  openEditors.onDidChange(scheduleSave);
  // Правка текста — тоже повод записать сессию: несохранённое должно пережить перезапуск.
  documents.onDidChange(scheduleDeepSave);
  dock.onVisibilityChange(scheduleSave);
  // Точки останова — тоже часть рабочего места: поставили или сняли — сохраняем.
  debug.onDidChangeBreakpoints(scheduleSave);

  return {
    root: () => root,
    setRoot: (value) => {
      root = value;
    },
    restore,
    scheduleSave,
    scheduleDeepSave,
    saveNow: persist,
  };
}
