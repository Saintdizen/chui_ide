import type { ToastKind, ToastOptions } from '../ui/toast';
import type { DefineCommand } from './command-args';

/** Что было видно в дзен-режиме: возвращаем ровно это, а не «всё включено». */
export interface ZenSnapshot {
  sidebar: boolean;
  right: boolean;
  dock: boolean;
}

export interface ViewLayout {
  root: HTMLElement;
  readonly sidebarVisible: boolean;
  readonly rightVisible: boolean;
  readonly dockVisible: boolean;
  readonly editorVisible: boolean;
  setSidebarVisible(on: boolean): void;
  setRightVisible(on: boolean): void;
  setDockVisible(on: boolean): void;
  setEditorVisible(on: boolean): void;
}

export interface ViewDock {
  readonly visible: boolean;
  readonly activeId: string | null;
  show(id: string): void;
  hide(): void;
  toggle(id: string): void;
}

export interface ViewCommandDeps {
  layout: ViewLayout;
  dock: ViewDock;
  /** Кнопки вида в шапке обязаны отражать новое состояние сразу. */
  syncViewButtons(): void;
  /** Спрятанный макет сохранять нельзя — прячем внутри этого. */
  withoutPersist(run: () => void): void;
  /** Дзен-режим помнит, что было видно: состояние живёт в замыкании окна. */
  getZen(): ZenSnapshot | null;
  setZen(snapshot: ZenSnapshot | null): void;
  editors: {
    readonly isSplit: boolean;
    readonly isGrid: boolean;
    splitEditor(): void;
    splitEditorGrid(): void;
    closeSplit(): void;
  };
  openEditors: { readonly active: { readonly path: string } | null };
  statusBar: { readonly gitAnchor: HTMLElement | null };
  openGitManager(anchor: HTMLElement | null): void;
  isMarkdownPath(path: string): boolean;
  toggleMarkdownPreview(path: string): void;
  regexTester: { open(): void };
  showToast(message: string, kind?: ToastKind, options?: ToastOptions): void;
}

/**
 * Вид: панели, док, разделение редактора и дзен-режим.
 *
 * Команды не решают, что видно — они переключают и просят перерисовать кнопки:
 * состояние живёт в раскладке и доке, а кнопки шапки читают его оттуда же. Поэтому
 * после каждой смены — `syncViewButtons()`, иначе кнопка соврёт о состоянии.
 */
export function registerViewCommands(define: DefineCommand, deps: ViewCommandDeps): void {
  const { layout, dock, syncViewButtons, withoutPersist, showToast } = deps;

  define({ id: 'view.showExplorer', title: 'Показать проводник', category: 'Вид', keybinding: 'Alt+1' }, () => {
    layout.setSidebarVisible(true);
    syncViewButtons();
  });

  // Вкладки «Изменения» в нижней панели больше нет: полный менеджер git открывается
  // поповером от кнопки ветки в статусбаре.
  define({ id: 'view.showChanges', title: 'Показать изменения', category: 'Вид', keybinding: 'Ctrl+Shift+G' }, () => {
    deps.openGitManager(deps.statusBar.gitAnchor);
  });

  define({ id: 'view.toggleSidebar', title: 'Боковая панель', category: 'Вид', keybinding: 'Ctrl+B' }, () => {
    layout.setSidebarVisible(!layout.sidebarVisible);
    syncViewButtons();
  });

  // Область редактора — такая же часть макета, как панели: кто-то работает только
  // с чатом и деревом, кто-то — только с терминалом. Свёрнутость — осознанный выбор
  // человека, поэтому пишется в настройки так же, как у боковой панели и дока.
  define(
    { id: 'view.toggleEditor', title: 'Панель редактора', category: 'Вид', keybinding: 'Ctrl+Alt+E' },
    () => {
      layout.setEditorVisible(!layout.editorVisible);
      syncViewButtons();
    },
  );

  // Режим дзен: прячем всю обвязку — панели, нижний док, строку состояния и шапку — и
  // оставляем только редактор. Что было видно, ЗАПОМИНАЕМ и возвращаем на выходе;
  // спрятанный макет сохранять нельзя, поэтому прячем внутри `withoutPersist`.
  define({ id: 'view.zen', title: 'Режим дзен', category: 'Вид', keywords: ['zen', 'фокус'] }, () => {
    const saved = deps.getZen();
    if (saved) {
      deps.setZen(null);
      withoutPersist(() => {
        layout.setSidebarVisible(saved.sidebar);
        layout.setRightVisible(saved.right);
        layout.setDockVisible(saved.dock);
      });
      layout.root.classList.remove('is-zen');
    } else {
      deps.setZen({ sidebar: layout.sidebarVisible, right: layout.rightVisible, dock: layout.dockVisible });
      withoutPersist(() => {
        layout.setSidebarVisible(false);
        layout.setRightVisible(false);
        layout.setDockVisible(false);
      });
      layout.root.classList.add('is-zen');
    }
    syncViewButtons();
  });

  // Открыть именно вкладку терминала (палитра, Ctrl+`).
  define({ id: 'view.showTerminal', title: 'Терминал', category: 'Вид' }, () => {
    dock.show('terminal');
  });

  define({ id: 'view.showOutline', title: 'Структура файла', category: 'Вид' }, () => {
    dock.toggle('outline');
  });

  define({ id: 'view.notebooks', title: 'Ячейки ноутбука', category: 'Вид' }, () => {
    dock.show('notebooks');
  });

  define({ id: 'view.showMarkdownPreview', title: 'Предпросмотр Markdown', category: 'Вид' }, () => {
    const path = deps.openEditors.active?.path ?? null;
    if (path === null || !deps.isMarkdownPath(path)) {
      showToast('Предпросмотр Markdown: откройте файл .md', 'error');
      return;
    }
    deps.toggleMarkdownPreview(path);
  });

  define({ id: 'view.regexTester', title: 'Отладчик регулярных выражений', category: 'Вид' }, () => {
    deps.regexTester.open();
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

  // Тумблер острова — одна команда на палитру, кнопку шапки и Alt+F12: показывает
  // нижнюю панель с прежней вкладкой, а если она уже открыта — скрывает целиком.
  define({ id: 'view.toggleDock', title: 'Нижняя панель', category: 'Вид', keybinding: 'Alt+F12' }, () => {
    if (dock.visible) dock.hide();
    else dock.show(dock.activeId ?? 'terminal');
  });

  // Разделение области редактора: одна кнопка включает и выключает, как и у панелей.
  define({ id: 'view.splitEditor', title: 'Разделить редактор', category: 'Вид', keybinding: 'Ctrl+\\' }, () => {
    if (deps.editors.isSplit) deps.editors.closeSplit();
    else deps.editors.splitEditor();
    syncViewButtons();
  });

  // Сетка из четырёх панелей: разложить в 2×2, повторный вызов возвращает одну панель.
  define(
    {
      id: 'view.splitEditorGrid',
      title: 'Разделить на четыре (сетка)',
      category: 'Вид',
      keybinding: 'Ctrl+Shift+\\',
    },
    () => {
      if (deps.editors.isGrid) deps.editors.closeSplit();
      else deps.editors.splitEditorGrid();
      syncViewButtons();
    },
  );
}
