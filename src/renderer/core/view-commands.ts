import { editorFontSizeLabel, stepEditorFontSize } from '../../shared/editor-font-scale';
import { stepUiScale, uiScaleLabel } from '../../shared/ui-scale';
import type { SidebarPosition } from '../../shared/api/settings';
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
  /** Сторона, с которой стоит боковая панель: содержимое переезжает вместе с ней. */
  readonly sidebarPosition: SidebarPosition;
  setSidebarPosition(position: SidebarPosition): void;
  setRightVisible(on: boolean): void;
  setDockVisible(on: boolean): void;
  setEditorVisible(on: boolean): void;
}

export interface ViewDock {
  readonly visible: boolean;
  readonly activeId: string | null;
  /** Место, которое панель держала до дзена: ноль — не помнит. */
  readonly height: number;
  /** Запомнить место панели; ноль — забыть. */
  setHeight(height: number): void;
  show(id: string): void;
  /** Показать вкладку и увести в неё фокус: шаг с клавиатуры, а не только вид. */
  showAndFocus(id: string): void;
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
    /** Дзен-режим: редактор сам прячет миникарту и возвращает её на выходе. */
    setZen(on: boolean): void;
  };
  openEditors: { readonly active: { readonly path: string } | null };
  statusBar: { readonly gitAnchor: HTMLElement | null };
  openGitManager(anchor: HTMLElement | null): void;
  isMarkdownPath(path: string): boolean;
  toggleMarkdownPreview(path: string): void;
  /** Миникарта вкл/выкл на один раз: настройку `editor.minimap` не трогает. */
  toggleMinimap(): void;
  regexTester: { open(): void };
  showToast(message: string, kind?: ToastKind, options?: ToastOptions): void;
  /** Масштаб оболочки: читаем текущий и ставим новый (`appearance.uiScale`). */
  uiScale: {
    get(): number;
    set(scale: number): void;
  };
  /** Кегль редактора: читаем текущий и меняем на ступень (`editor.fontSize`). */
  editorFont: {
    get(): number;
    set(size: number): void;
  };
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

  // Сторона боковой панели — часть макета, как её ширина и видимость, поэтому
  // правка сразу уходит в настройки (см. `persistLayout`). Одна команда на обе
  // стороны: палитра по ней видит текущее положение и переключает его.
  define(
    {
      id: 'view.sidebarPosition',
      title: 'Боковая панель: переставить вправо/влево',
      category: 'Вид',
      keywords: ['layout', 'макет', 'сторона', 'переставить'],
    },
    () => {
      const next: SidebarPosition = layout.sidebarPosition === 'left' ? 'right' : 'left';
      layout.setSidebarPosition(next);
      showToast(next === 'right' ? 'Боковая панель справа' : 'Боковая панель слева');
      syncViewButtons();
    },
  );

  // Область редактора — такая же часть макета, как панели: кто-то работает только
  // с чатом и деревом, кто-то — только с терминалом. Свёрнутость — осознанный выбор
  // человека, поэтому пишется в настройки так же, как у боковой панели и дока.
  define({ id: 'view.toggleEditor', title: 'Панель редактора', category: 'Вид', keybinding: 'Ctrl+Alt+E' }, () => {
    layout.setEditorVisible(!layout.editorVisible);
    syncViewButtons();
  });

  // Режим дзен: прячем всю обвязку — панели, нижний док, строку состояния и шапку — и
  // оставляем только редактор. Что было видно, ЗАПОМИНАЕМ и возвращаем на выходе;
  // спрятанный макет сохранять нельзя, поэтому прячем внутри `withoutPersist`.
  //
  // Высота дока и миникарта — тоже часть картинки: свёрнутый док теряет место,
  // открытый на выходе вернулся бы к высоте по умолчанию. Обе помнит тот, кому
  // принадлежат: док — свою высоту (`dock.height`), редактор — миникарту.
  // Только сам класс: вид редактора на дзен отзывается сам (`editors.setZen`), а в
  // шапке кнопки гасить незачем — она и так спрятана.
  const setZen = (on: boolean): void => {
    layout.root.classList.toggle('is-zen', on);
    deps.editors.setZen(on);
  };

  define({ id: 'view.zen', title: 'Режим дзен', category: 'Вид', keywords: ['zen', 'фокус'] }, () => {
    const saved = deps.getZen();
    if (saved) {
      deps.setZen(null);
      withoutPersist(() => {
        layout.setSidebarVisible(saved.sidebar);
        layout.setRightVisible(saved.right);
        layout.setDockVisible(saved.dock);
      });
      setZen(false);
    } else {
      deps.setZen({ sidebar: layout.sidebarVisible, right: layout.rightVisible, dock: layout.dockVisible });
      // Свёрнутый док своё место теряет: перед тем как отдать его дзену, запомним.
      dock.setHeight(dock.height);
      withoutPersist(() => {
        layout.setSidebarVisible(false);
        layout.setRightVisible(false);
        layout.setDockVisible(false);
      });
      setZen(true);
    }
    syncViewButtons();
  });

  // Открыть именно вкладку терминала (палитра, Ctrl+`).
  define({ id: 'view.showTerminal', title: 'Терминал', category: 'Вид' }, () => {
    dock.show('terminal');
  });

  // `Ctrl+Shift+O` занят быстрым открывателем (`app-view-commands`), `Ctrl+Shift+K`
  // — удалением строки в редакторе, `Ctrl+Shift+M` — панелью проблем. Свободное
  // `Ctrl+Shift+U` и стало дверью к структуре (`U` — как `outline` у штурвала).
  define({ id: 'view.showOutline', title: 'Структура файла', category: 'Вид', keybinding: 'Ctrl+Shift+U' }, () => {
    dock.showAndFocus('outline');
  });

  // Журнал LSP: туда ведёт «Показать» из уведомления о подключении серверов.
  // Команда, а не замыкание, потому что шаг должен переживать закрытие тоста.
  define({ id: 'view.lspLog', title: 'Журнал языковых серверов', category: 'Вид', keywords: ['lsp'] }, () => {
    dock.show('lsp-log');
  });

  // Миникарта — отдельно от настройки: настройка решает, как открывать файл, а команда
  // (и палитра) мнёт её на один раз и обратно, не лезя в `settings.json`. В дзене
  // миникарты нет ни в каком случае — там она противоречит самому смыслу режима.
  define({ id: 'view.toggleMinimap', title: 'Миникарта', category: 'Вид', keybinding: 'Alt+M' }, () => {
    if (layout.root.classList.contains('is-zen')) {
      showToast('Миникарта в режиме дзен не показывается', 'error');
      return;
    }
    deps.toggleMinimap();
  });

  // Масштаб оболочки. Меняется тем же путём, что и список в настройках, — так
  // клавиша и окно настроек не расходятся: значение одно, в `settings.json`.
  const zoom = (direction: -1 | 0 | 1): void => {
    const before = deps.uiScale.get();
    const after = stepUiScale(before, direction);
    if (after === before) return;
    deps.uiScale.set(after);
    // Подпись обязательна: без неё `Ctrl+Shift+=` на максимуме выглядит как «клавиша не работает».
    deps.showToast(`Масштаб интерфейса: ${uiScaleLabel(after)}`);
  };
  // БЕЗ `keybinding`. Сочетания заданы пунктами меню с ролью Electron
  // (`Ctrl+Shift+=` / `Ctrl+Shift+-`, `role: 'zoomIn'`): роль держит клавишу до
  // renderer, и своё привязанное сочетание здесь молча не сработало бы. Своя
  // клавиша занята кеглем текста (см. ниже) — это разные величины.
  define({ id: 'view.zoomIn', title: 'Крупнее', category: 'Вид' }, () => {
    zoom(1);
  });
  define({ id: 'view.zoomOut', title: 'Мельче', category: 'Вид' }, () => {
    zoom(-1);
  });
  define({ id: 'view.zoomReset', title: 'Масштаб 100 %', category: 'Вид' }, () => {
    zoom(0);
  });

  // Кегль ТЕКСТА — не то же, что масштаб оболочки: у редактора свой размер, и
  // `Ctrl+=`/`Ctrl+-` меняют именно текст (в меню «Крупнее»/«Мельче», см.
  // `shared/app-menu.ts`). Масштаб окна ушёл на `Ctrl+Shift+=`/`Ctrl+Shift+-`:
  // роль Electron держит клавишу до renderer, и двум действиям на одном сочетании
  // места нет — одно из них молча не сработало бы.
  const zoomFont = (direction: -1 | 1): void => {
    const before = deps.editorFont.get();
    const after = stepEditorFontSize(before, direction);
    // У границы не молчим, а говорим «дальше некуда»: иначе клавиша выглядит сломанной.
    if (after === before) {
      deps.showToast(editorFontSizeLabel(after));
      return;
    }
    deps.editorFont.set(after);
    deps.showToast(editorFontSizeLabel(after));
  };
  define({ id: 'editor.fontZoomIn', title: 'Шрифт редактора крупнее', category: 'Вид', keybinding: 'Ctrl+=' }, () => {
    zoomFont(1);
  });
  define({ id: 'editor.fontZoomOut', title: 'Шрифт редактора мельче', category: 'Вид', keybinding: 'Ctrl+-' }, () => {
    zoomFont(-1);
  });

  // Открытие панели с клавиатуры — это шаг в панель, а не только её появление:
  // иначе человек вызвал панель, а следующий Tab уводит его из неё в обход окна.
  // `show` остаётся для случаев, когда панель зовут фоном (ошибка LSP, отладка).
  define({ id: 'view.notebooks', title: 'Ячейки ноутбука', category: 'Вид' }, () => {
    dock.showAndFocus('notebooks');
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
    dock.showAndFocus('problems');
  });

  // Задачи: список пометок TODO/FIXME/HACK/XXX по проекту — как панель «Проблемы»,
  // только источник у списка другой (поиск по проекту).
  define(
    { id: 'view.showTodos', title: 'Задачи (TODO/FIXME)', category: 'Вид', keywords: ['todo', 'fixme', 'пометки'] },
    () => {
      dock.showAndFocus('todo');
    },
  );

  // Тумблер острова — одна команда на палитру, кнопку шапки и Alt+F12: показывает
  // нижнюю панель с прежней вкладкой, а если она уже открыта — скрывает целиком.
  define({ id: 'view.toggleDock', title: 'Нижняя панель', category: 'Вид', keybinding: 'Alt+F12' }, () => {
    if (dock.visible) dock.hide();
    else dock.showAndFocus(dock.activeId ?? 'terminal');
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
