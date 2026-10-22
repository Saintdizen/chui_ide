import type { ToastKind, ToastOptions } from '../ui/toast';
import type { DefineCommand } from './command-args';

/** Что модулю нужно от сервиса исправлений — три входа, не весь объект. */
export interface EditorFixActions {
  runOrganizeImports(path: string): Promise<void> | void;
  runRefactorMenu(path: string): Promise<void> | void;
  runRefactor(path: string, action: 'extract' | 'inline'): Promise<void> | void;
}

export interface EditorFixDeps {
  /** Только текущий путь: остальное решает сервис исправлений. */
  currentPath(): string | null;
  fixes: EditorFixActions;
  showToast(message: string, kind?: ToastKind, options?: ToastOptions): void;
}

/**
 * Исправления и рефакторинги текущего файла.
 *
 * Все четыре команды — одна и та же развилка: есть ли открытый файл. Сами списки
 * действий приходят от языка (LSP), поэтому здесь нет ни текста правки, ни
 * применения — только выбор цели и честное «нет открытого файла».
 */
export function registerEditorFixCommands(define: DefineCommand, deps: EditorFixDeps): void {
  const { currentPath, fixes, showToast } = deps;

  // Один заход на все четыре: `path` нужен всем, отличается только вызов сервиса.
  const withPath = (run: (path: string) => void) => () => {
    const path = currentPath();
    if (!path) {
      showToast('Нет открытого файла');
      return;
    }
    run(path);
  };

  define(
    {
      id: 'editor.organizeImports',
      title: 'Упорядочить импорты',
      category: 'Редактор',
      keybinding: 'Shift+Alt+O',
      keywords: ['imports', 'import', 'импорт', 'organize'],
    },
    withPath((path) => void fixes.runOrganizeImports(path)),
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
    withPath((path) => void fixes.runRefactorMenu(path)),
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
    withPath((path) => void fixes.runRefactor(path, 'extract')),
  );

  // «Разворачивание» (inline) — обратный рефакторинг: тело символа встаёт на место вызова.
  define(
    {
      id: 'editor.inlineSymbol',
      title: 'Развернуть (inline)',
      category: 'Редактор',
      keywords: ['refactor', 'inline', 'развернуть', 'встроить'],
    },
    withPath((path) => void fixes.runRefactor(path, 'inline')),
  );
}
