import type { BreakpointRecord, DebugLaunchOptions, SessionState } from '../../shared/api';
import type { DockView } from '../ui/dock';
import type { DebugController } from './debug';
import type { DocumentStore } from './document-store';
import type { EditorService } from './editor-service';
import type { OpenEditors } from './open-editors';
import type { RpcClient } from './rpc';

/** Проводник в той части, что нужна сессии: какие папки раскрыты. */
export interface ExpandedTree {
  expandedPaths(): string[];
  restoreExpanded(paths: readonly string[]): void;
}

/** Панель отладки в той части, что нужна сессии: наблюдаемые выражения. */
export interface WatchPanel {
  getWatch(): string[];
  setWatch(expressions: readonly string[]): void;
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
  editors: EditorService;
  debug: DebugController;
  explorer: ExpandedTree;
  dock: DockView;
  debugPanel: WatchPanel;
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
 * Рабочее место проекта: что открыто, что раскрыто и какие точки останова стоят.
 * Живёт отдельно от сборки окна — приложению о нём напоминают только две вещи:
 * восстановить место при открытии проекта и попросить сохранить при изменении.
 */
export function createSessionControl(deps: SessionDeps): SessionControl {
  const { rpc, documents, openEditors, editors, debug, explorer, dock, debugPanel, layout } = deps;

  /** Какой проект сейчас восстановлен: ключ, по которому кладётся сессия. */
  let root: string | null = null;
  /** Пока идёт восстановление, сохранять нельзя — иначе затрём файл пустотой. */
  let restoring = false;
  let saveTimer = 0;

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
  const capture = (): SessionState => {
    const breakpoints = captureBreakpoints();
    const watch = debugPanel.getWatch();
    const exceptions = debug.exceptionFilters();
    const options = deps.getDebugOptions();
    return {
      tabs: [...openEditors.paths],
      ...(openEditors.active ? { activeTab: openEditors.active.path } : {}),
      expanded: explorer.expandedPaths(),
      ...(dock.activeId ? { dockActive: dock.activeId } : {}),
      // Видимость панелей сюда не входит: это общий макет (settings), а не
      // свойство проекта. Рабочее место конкретной папки — вкладки и папки.
      // Параметры запуска, наблюдение и точки останова отладки — часть рабочего места:
      // пустые не пишем, чтобы файл не разрастался полями-пустышками.
      ...(Object.keys(options).length > 0 ? { debugLaunch: options } : {}),
      ...(watch.length > 0 ? { debugWatch: watch } : {}),
      ...(exceptions.uncaught || exceptions.caught ? { debugExceptions: exceptions } : {}),
      ...(breakpoints.length > 0 ? { breakpoints } : {}),
    };
  };

  /** Записать сессию сейчас, если есть проект и не идёт восстановление. */
  const persist = (): void => {
    if (!root || restoring) return;
    // не сохранилось — не повод мешать работе
    void rpc.request('session.save', { root, state: capture() }).catch(() => undefined);
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

      for (const path of state.tabs) {
        try {
          await deps.openPath(path);
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
      deps.setDebugOptions(state.debugLaunch ?? {});
      debugPanel.setWatch(state.debugWatch ?? []);
      if (state.debugExceptions) void debug.setExceptionFilters(state.debugExceptions);
      restoreBreakpoints(state.breakpoints ?? []);
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
