import type { Keybinding } from './keybindings';

/**
 * Сочетания клавиш, которые перехватывает САМ renderer.
 *
 * Основные сочетания идут через акселераторы меню Electron (оно шлёт команды push-
 * событием) — их здесь нет: меню уже даёт им клавиши, и повтор сбивал бы. Здесь
 * только то, чего в меню нет. Список вынесен из `app.ts` отдельным модулем, потому
 * что его читают двое: служба перехвата (`KeybindingService`) и редактор сочетаний в
 * настройках — оба должны видеть один и тот же набор и одни и те же значения.
 *
 * Сочетание из этого списка человек может изменить в настройках; изменённое
 * накладывается сверху (`KeybindingService.effective`).
 */
export const DEFAULT_KEYBINDINGS: readonly Keybinding[] = [
  { combo: 'Alt+1', command: 'view.showExplorer' },
  { combo: 'Alt+2', command: 'search.project' },
  // Символ по проекту — привычное сочетание.
  { combo: 'Ctrl+T', command: 'navigate.symbol' },
  { combo: 'Ctrl+,', command: 'settings.open' },
  { combo: 'Ctrl+Shift+G', command: 'view.showChanges' },
  { combo: 'Ctrl+`', command: 'view.showTerminal' },
  { combo: 'Ctrl+Alt+E', command: 'ai.openInEditor' },
  // Запуск — Shift+F10 и Ctrl+F5: обе привычки живут рядом.
  { combo: 'Ctrl+F5', command: 'run.file' },
  { combo: 'Shift+F10', command: 'run.choose' },
  // Тесты — рядом с запуском: Ctrl+Shift+F5, как принято в IDE.
  { combo: 'Ctrl+Shift+F5', command: 'run.tests' },
  // Форматирование — Shift+Alt+F. Инструмент выбирается
  // по языку: у Python это ruff/black окружения, у JS/TS — prettier/biome проекта.
  { combo: 'Shift+Alt+F', command: 'format.document' },
  // Упорядочить импорты — Shift+Alt+O.
  { combo: 'Shift+Alt+O', command: 'editor.organizeImports' },
  // Рефакторинг — Ctrl+Shift+R открывает список действий раздела `refactor`.
  { combo: 'Ctrl+Shift+R', command: 'editor.refactor' },
  // Отладка — привычные сочетания: F5 пуск/продолжить, Shift+F5 стоп,
  // F9 точка останова, F10/F11 шаги.
  { combo: 'F5', command: 'debug.continue' },
  { combo: 'Shift+F5', command: 'debug.stop' },
  { combo: 'F9', command: 'debug.toggleBreakpoint' },
  { combo: 'F10', command: 'debug.stepOver' },
  { combo: 'F11', command: 'debug.stepInto' },
  { combo: 'Shift+F11', command: 'debug.stepOut' },
  // Закладки — привычные сочетания: K — поставить, L/J — переходы.
  { combo: 'Ctrl+Alt+K', command: 'editor.toggleBookmark' },
  { combo: 'Ctrl+Alt+L', command: 'editor.nextBookmark' },
  { combo: 'Ctrl+Alt+J', command: 'editor.previousBookmark' },
  { combo: 'Ctrl+Alt+B', command: 'editor.bookmarksList' },
  // Меню — как в приложениях KDE: Alt+F10 открывает его с клавиатуры.
  { combo: 'Alt+F10', command: 'app.showMenu' },
];
