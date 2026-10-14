import type {
  BreakpointRecord,
  DebugLaunchOptions,
  SessionState,
  UnsavedBuffer,
  WorkspaceInfo,
} from '../../shared/api';
import { sanitizeMacroSteps } from '../editor/input/macro';
import { selectUnsavedBuffers } from '../../shared/session';
import type { BookmarkRecord } from '../../shared/bookmarks';
import type { FileLabelRecord } from '../../shared/file-labels';
import type { WorkspaceRoot } from '../../shared/workspace-roots';
import type { DockView } from '../ui/dock';
import type { DebugController } from './debug';
import type { DocumentStore } from './document-store';
import type { EditorApi } from './editor-api';
import type { OpenEditors } from './open-editors';
import type { RpcClient } from './rpc';

/** Проводник в той части, что нужна сессии: какие папки раскрыты и что закреплено. */
export interface ExpandedTree {
  expandedPaths(): string[];
  restoreExpanded(paths: readonly string[]): void;
  /** Закреплённые файлы и папки дерева — их рабочее место тоже помнит. */
  pinnedPaths(): string[];
  restorePinned(paths: readonly string[]): void;
  /** Метки файлов в дереве — цветные ярлыки; тоже часть рабочего места проекта. */
  labels(): FileLabelRecord[];
  restoreLabels(records: unknown): void;
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

export interface SessionDeps {
  rpc: RpcClient;
  documents: DocumentStore;
  openEditors: OpenEditors;
  editors: EditorApi;
  debug: DebugController;
  explorer: ExpandedTree;
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
  /** Сохранить немедленно, без отложенного таймера — на закрытии окна. */
  saveNow(): void;
}

/** Задержка отложенной записи: серия быстрых изменений пишет файл один раз. */
const SAVE_DEBOUNCE_MS = 400;

/**
 * Пауза перед записью несохранённых правок: текст меняется на каждое нажатие, а
 * сессия — файл целиком. Дольше, чем у вкладок, чтобы набор не тормозил записью.
 */
const HOT_EXIT_DEBOUNCE_MS = 2000;

/**
 * Рабочее место проекта: что открыто, что раскрыто и какие точки останова стоят.
 * Живёт отдельно от сборки окна — приложению о нём напоминают только две вещи:
 * восстановить место при открытии проекта и попросить сохранить при изменении.
 */
export function createSessionControl(deps: SessionDeps): SessionControl {
  const { rpc, documents, openEditors, editors, debug, explorer, workspace, dock, debugPanel, layout } = deps;

  /** Какой проект сейчас восстановлен: ключ, по которому кладётся сессия. */
  let root: string | null = null;
  /** Пока идёт восстановление, сохранять нельзя — иначе затрём файл пустотой. */
  let restoring = false;
  let saveTimer = 0;
  /** Свой таймер для несохранённого текста: он меняется чаще, чем состав вкладок. */
  let hotExitTimer = 0;

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

  /**
   * Вернуть несохранённые правки в буферы. Текст ставится источником `programmatic`:
   * это не ввод человека, но и не диск — правка обязана остаться «не сохранённой»,
   * а буфер редактора обязан её подхватить (за это отвечает реестр документов).
   *
   * Возвращает пути, которые действительно получили текст: по ним видно, какие
   * вкладки надо показать, если их нет в списке открытых.
   */
  const restoreUnsaved = async (buffers: readonly UnsavedBuffer[]): Promise<string[]> => {
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
      if (document.setText(item.text, 'programmatic')) restored.push(item.path);
      else if (document.dirty) restored.push(item.path);
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
    // Несохранённые правки — часть рабочего места: без них перезапуск (и любое
    // закрытие окна) терял бы работу, которую человек ещё не записал.
    const unsaved = selectUnsavedBuffers(
      documents.dirty().map((document) => ({ path: document.path, text: document.value })),
    );
    // Записанный макрос — тоже часть рабочего места: его повторяют и после перезапуска.
    const macro = editors.macroSteps();
    const roots = workspace.roots.map((item) => item.root);
    return {
      // Корни области — только когда папок больше одной: обычный проект дублировать незачем.
      ...(roots.length > 1 ? { roots } : {}),
      tabs: [...openEditors.paths],
      ...(openEditors.active ? { activeTab: openEditors.active.path } : {}),
      expanded: explorer.expandedPaths(),
      pinned: explorer.pinnedPaths(),
      ...(explorer.labels().length > 0 ? { labels: explorer.labels() } : {}),
      ...(dock.activeId ? { dockActive: dock.activeId } : {}),
      // Видимость панелей сюда не входит: это общий макет (settings), а не
      // свойство проекта. Рабочее место конкретной папки — вкладки и папки.
      // Параметры запуска, наблюдение и точки останова отладки — часть рабочего места:
      // пустые не пишем, чтобы файл не разрастался полями-пустышками.
      ...(Object.keys(options).length > 0 ? { debugLaunch: options } : {}),
      ...(watch.length > 0 ? { debugWatch: watch } : {}),
      ...(exceptions.uncaught || exceptions.caught ? { debugExceptions: exceptions } : {}),
      ...(breakpoints.length > 0 ? { breakpoints } : {}),
      // Закладки — тоже рабочее место: пустые не пишем, чтобы файл не пух полями-пустышками.
      ...(bookmarks.length > 0 ? { bookmarks } : {}),
      // Место работы в каждом файле — часть рабочего места: без него после
      // перезапуска вкладки те же, а курсор в начале файла.
      ...(Object.keys(cursors).length > 0 ? { cursors } : {}),
      ...(unsaved.length > 0 ? { unsaved } : {}),
      ...(macro.length > 0 ? { macro: [...macro] } : {}),
    };
  };

  /** Записать сессию сейчас, если есть проект и не идёт восстановление. */
  const persist = (): void => {
    if (!root || restoring) return;
    // не сохранилось — не повод мешать работе
    void rpc.request('session.save', { root, state: capture() }).catch(() => undefined);
  };

  /**
   * Записать сессию с несохранённым текстом. Задержка своя, и она длиннее: правка
   * приходит на каждое нажатие, а писать файл сессии так часто ни к чему.
   */
  const scheduleHotExit = (): void => {
    if (!root || restoring) return;
    if (hotExitTimer) window.clearTimeout(hotExitTimer);
    hotExitTimer = window.setTimeout(() => {
      hotExitTimer = 0;
      persist();
    }, HOT_EXIT_DEBOUNCE_MS);
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
      const state = await rpc.request('session.load', { root: target });

      // Макрос из прошлой сессии: повтор доступен сразу, без новой записи.
      editors.restoreMacro(sanitizeMacroSteps(state.macro));

      // Несохранённые правки возвращаем ДО открытия вкладок: `open` подхватит готовый
      // текст из документа, и на экране сразу будет то, что человек не успел сохранить.
      const dirtyPaths = await restoreUnsaved(state.unsaved ?? []);

      // Позиции курсоров ставим ДО открытия файлов: `open` подхватит их при показе.
      editors.restoreCursorPositions(state.cursors ?? {});

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

      explorer.restoreExpanded(state.expanded);
      explorer.restorePinned(state.pinned ?? []);
      explorer.restoreLabels(state.labels ?? []);
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
      if (state.debugExceptions) void debug.setExceptionFilters(state.debugExceptions);
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
  documents.onDidChange(scheduleHotExit);
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
    saveNow: persist,
  };
}
