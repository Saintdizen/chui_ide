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
    { label: 'Открыть папку…', accelerator: 'Ctrl+O', command: 'workspace.openFolder' },
    { separator: true },
    { label: 'Новый файл', accelerator: 'Ctrl+N', command: 'file.newFile' },
    { label: 'Новая папка', command: 'file.newFolder' },
    { separator: true },
    { label: 'Сохранить', accelerator: 'Ctrl+S', command: 'file.save' },
    { label: 'Сохранить всё', accelerator: 'Ctrl+Shift+S', command: 'file.saveAll' },
    { label: 'Закрыть вкладку', accelerator: 'Ctrl+W', command: 'file.close' },
    { separator: true },
    { label: 'Обновить дерево', command: 'workspace.refresh' },
    { label: 'Быстрое открытие файла…', accelerator: 'Ctrl+Shift+O', command: 'file.quickOpen' },
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
  ],
};

const VIEW: MenuNode = {
  label: 'Вид',
  children: [
    { label: 'Боковая панель', accelerator: 'Ctrl+B', command: 'view.toggleSidebar' },
    { label: 'Панель AI', accelerator: 'Ctrl+Shift+A', command: 'view.toggleRight' },
    { separator: true },
    { label: 'Терминал', accelerator: 'Alt+F12', command: 'view.showTerminal' },
    { separator: true },
    { label: 'Палитра команд…', accelerator: 'Ctrl+Shift+P', command: 'palette.open' },
    { separator: true },
    { label: 'Тема: тёмная', command: 'view.theme.dark' },
    { label: 'Тема: светлая', command: 'view.theme.light' },
    { label: 'Тема: как в системе', command: 'view.theme.system' },
    { separator: true },
    { label: 'Перезагрузить', accelerator: 'Ctrl+R', role: 'reload' },
    { label: 'Инструменты разработчика', accelerator: 'Ctrl+Shift+I', role: 'toggleDevTools' },
    { separator: true },
    { label: 'Обычный масштаб', accelerator: 'Ctrl+0', role: 'zoomReset' },
    { label: 'Крупнее', accelerator: 'Ctrl+=', role: 'zoomIn' },
    { label: 'Мельче', accelerator: 'Ctrl+-', role: 'zoomOut' },
    { separator: true },
    // Без акселератора: `F11` держит шаг отладки с заходом (`debug.stepInto`) —
    // привычка VS Code и PyCharm. Полный экран остаётся пунктом меню, а не клавишей.
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
  ],
};

/** Языковые инструменты — отдельной группой: у Python их больше всего. */
const PYTHON: MenuNode = {
  label: 'Python',
  children: [
    { label: 'Виртуальные окружения…', command: 'python.environments' },
    { separator: true },
    { label: 'Перезапустить языковые серверы', command: 'lsp.restart' },
  ],
};

/** Верхний уровень: те же группы, что в системном меню. */
export const APP_MENU: readonly MenuNode[] = [FILE, EDIT, VIEW, AI, PYTHON];
