/**
 * Меню приложения — ОДИН шаблон на два процесса.
 *
 * Само меню рисует renderer: кнопка «☰» открывает наш попап, стилизованный как
 * остальные выпадашки. Но системное меню остаётся внутри (`Menu.setApplicationMenu`):
 * именно оно держит горячие клавиши Electron-уровня, которые renderer не увидит
 * (масштаб, полный экран, инструменты разработчика, выход).
 *
 * Поэтому структура живёт здесь, а не в `main/menu.ts`: два списка с одними и теми же
 * пунктами неизбежно разъехались бы. Пункт описывает либо команду реестра renderer
 * (`command`), либо действие, которое умеет только main (`role`).
 */

/** Действие, которое выполняет main: буфер обмена, масштаб, окно. */
export type MenuRole =
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'reload'
  | 'toggleDevTools'
  | 'zoomReset'
  | 'zoomIn'
  | 'zoomOut'
  | 'fullscreen'
  | 'quit';

export interface MenuNode {
  /** Разделитель: остальные поля не читаются. */
  separator?: true;
  label?: string;
  /** Идентификатор команды в реестре renderer — тот же, что у кнопок интерфейса. */
  command?: string;
  /** Действие main: пункт без команды, но с ролью. */
  role?: MenuRole;
  /** Подсказка справа в нашем меню и горячая клавиша системного. */
  accelerator?: string;
  /** Подменю: есть только у четырёх групп верхнего уровня. */
  children?: readonly MenuNode[];
}

const FILE: MenuNode = {
  label: 'Файл',
  children: [
    { label: 'Открыть проект…', accelerator: 'Ctrl+O', command: 'workspace.openFolder' },
    // Закрыть проект — вернуться к списку проектов: окно IDE уступает стартовому.
    { label: 'Закрыть проект', command: 'project.close' },
    { separator: true },
    { label: 'Новый файл', accelerator: 'Ctrl+N', command: 'file.newFile' },
    { label: 'Новая папка', command: 'file.newFolder' },
    { separator: true },
    { label: 'Сохранить', accelerator: 'Ctrl+S', command: 'file.save' },
    // «Сохранить как…» на Ctrl+Shift+S — привычное сочетание; поэтому
    // «Сохранить всё» переехало на Ctrl+Alt+S: два пункта на одной клавише не жить.
    { label: 'Сохранить как…', accelerator: 'Ctrl+Shift+S', command: 'file.saveAs' },
    { label: 'Сохранить всё', accelerator: 'Ctrl+Alt+S', command: 'file.saveAll' },
    { label: 'Закрыть вкладку', accelerator: 'Ctrl+W', command: 'file.close' },
    { separator: true },
    { label: 'Обновить дерево', command: 'workspace.refresh' },
    { label: 'Быстрое открытие файла…', accelerator: 'Ctrl+Shift+O', command: 'file.quickOpen' },
    { separator: true },
    // Настройки — только здесь: кнопки в шапке нет, это редкое действие, а не работа.
    { label: 'Настройки…', accelerator: 'Ctrl+,', command: 'settings.open' },
    { separator: true },
    { label: 'Выход', role: 'quit' },
  ],
};

const EDIT: MenuNode = {
  label: 'Правка',
  children: [
    { label: 'Отменить', accelerator: 'Ctrl+Z', role: 'undo' },
    { label: 'Повторить', accelerator: 'Ctrl+Shift+Z', role: 'redo' },
    { separator: true },
    { label: 'Вырезать', accelerator: 'Ctrl+X', role: 'cut' },
    { label: 'Копировать', accelerator: 'Ctrl+C', role: 'copy' },
    { label: 'Вставить', accelerator: 'Ctrl+V', role: 'paste' },
    { label: 'Выделить всё', accelerator: 'Ctrl+A', role: 'selectAll' },
    { separator: true },
    { label: 'Поиск по проекту', accelerator: 'Ctrl+Shift+F', command: 'search.project' },
    { label: 'Заменить по структуре…', command: 'editor.structuralReplace' },
    { separator: true },
    // Макросы: редкий жест, но найти их должно быть можно — потому и в меню, без клавиш.
    { label: 'Макрос: начать или остановить запись', command: 'editor.macroRecord' },
    { label: 'Макрос: выполнить', command: 'editor.macroPlay' },
    { label: 'Макрос: выполнить несколько раз…', command: 'editor.macroPlayCount' },
    { separator: true },
    // Модальные раскладки Vim и Emacs: редкий выбор, потому и в меню, без клавиш.
    { label: 'Vim-режим: включить или выключить', command: 'editor.toggleVim' },
    { label: 'Emacs-режим: включить или выключить', command: 'editor.toggleEmacs' },
  ],
};

const VIEW: MenuNode = {
  label: 'Вид',
  children: [
    { label: 'Боковая панель', accelerator: 'Ctrl+B', command: 'view.toggleSidebar' },
    { label: 'Нижняя панель', accelerator: 'Alt+F12', command: 'view.toggleDock' },
    { label: 'Панель AI', accelerator: 'Ctrl+Shift+A', command: 'view.toggleRight' },
    { label: 'Режим дзен', accelerator: 'Alt+Z', command: 'view.zen' },
    { separator: true },
    { label: 'Терминал', command: 'view.showTerminal' },
    { label: 'Открыть страницу…', accelerator: 'Ctrl+Shift+B', command: 'browser.open' },
    { label: 'Структура файла', command: 'view.showOutline' },
    { label: 'Ячейки ноутбука', command: 'view.notebooks' },
    { label: 'Предпросмотр Markdown', command: 'view.showMarkdownPreview' },
    { label: 'Отладчик регулярных выражений…', command: 'view.regexTester' },
    { label: 'Задачи (TODO/FIXME)', command: 'view.showTodos' },
    { separator: true },
    { label: 'Палитра команд…', accelerator: 'Ctrl+Shift+P', command: 'palette.open' },
    { separator: true },
    { label: 'Перезагрузить', accelerator: 'Ctrl+R', role: 'reload' },
    { label: 'Инструменты разработчика', accelerator: 'Ctrl+Shift+I', role: 'toggleDevTools' },
    { separator: true },
    { label: 'Обычный масштаб', accelerator: 'Ctrl+0', role: 'zoomReset' },
    { label: 'Крупнее', accelerator: 'Ctrl+=', role: 'zoomIn' },
    { label: 'Мельче', accelerator: 'Ctrl+-', role: 'zoomOut' },
    { separator: true },
    // Без акселератора: `F11` держит шаг отладки с заходом (`debug.stepInto`) —
    // привычное сочетание. Полный экран остаётся пунктом меню, а не клавишей.
    { label: 'Полный экран', role: 'fullscreen' },
  ],
};

const AI: MenuNode = {
  label: 'AI',
  children: [
    { label: 'Новый диалог', accelerator: 'Ctrl+Shift+N', command: 'ai.newChat' },
    { label: 'Остановить генерацию', command: 'ai.stop' },
    { separator: true },
    { label: 'Объяснить выделение', command: 'ai.explainSelection' },
    { label: 'Исправить выделение', command: 'ai.fixSelection' },
    { label: 'Расписание задач…', command: 'ai.schedules' },
  ],
};

/** Языковые инструменты — отдельной группой: у Python их больше всего. */
const PYTHON: MenuNode = {
  label: 'Python',
  children: [
    { label: 'Виртуальные окружения…', command: 'python.environments' },
    { label: 'Профиль строк (узкое место)', command: 'python.profileLines' },
    { label: 'Убрать подсветку профиля', command: 'python.clearProfileLines' },
    { separator: true },
    { label: 'Перезапустить языковые серверы', command: 'lsp.restart' },
  ],
};

/** Верхний уровень: те же группы, что в системном меню. */
export const APP_MENU: readonly MenuNode[] = [FILE, EDIT, VIEW, AI, PYTHON];

/** Команды-переключатели: их состояние меню показывает отметкой слева. */
export const MENU_TOGGLES = {
  sidebar: 'view.toggleSidebar',
  aiPanel: 'view.toggleRight',
  terminal: 'view.showTerminal',
} as const;

/** Что включено прямо сейчас: про панели меню иначе молчит. */
export interface MenuState {
  sidebar: boolean;
  aiPanel: boolean;
  terminal: boolean;
}

/**
 * Состояние переключателей меню по идентификатору команды. Живёт рядом с шаблоном:
 * так отметки и сами пункты не разъедутся, и это проверяется тестом без DOM.
 */
export function menuChecks(state: MenuState): Record<string, boolean> {
  return {
    [MENU_TOGGLES.sidebar]: state.sidebar,
    [MENU_TOGGLES.aiPanel]: state.aiPanel,
    [MENU_TOGGLES.terminal]: state.terminal,
  };
}

/**
 * Клавиши пунктов меню по командам: `команда → акселератор`. Без переопределений это
 * встроенные клавиши шаблона; с ними — те, что человек задал под ключом `menu:<команда>`.
 * Нужно двоим: редактору сочетаний (показать и поменять) и сборке системного меню в
 * main (`main/menu.ts`).
 *
 * Пункты-роли (масштаб, буфер обмена) команды не имеют, поэтому в карту не попадают:
 * их клавиши и не меняются — Electron обрабатывает роли сам.
 *
 * Переопределение с пустой строкой убирает клавишу у пункта: `menu:file.save` = `''`
 * значит «Ctrl+S больше не наш». Команда, у которой клавиши не было, но переопределение
 * появилось, тоже попадёт в карту — так клавишу можно назначить и новому пункту.
 */
export function menuAccelerators(overrides?: ReadonlyMap<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (nodes: readonly MenuNode[]): void => {
    for (const node of nodes) {
      if (node.children) walk(node.children);
      if (!node.command) continue;
      if (overrides?.has(node.command)) {
        const combo = overrides.get(node.command)!;
        if (combo) map.set(node.command, combo);
      } else if (node.accelerator) {
        map.set(node.command, node.accelerator);
      }
    }
  };
  walk(APP_MENU);
  return map;
}
