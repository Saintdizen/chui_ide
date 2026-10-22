import type { RefactorAction } from '../../shared/lsp-refactor';
import type { EditorContextInfo } from '../editor/host/editor-host';
import type { PopupMenuItem } from '../ui/popup-menu';

/**
 * Меню правого клика по тексту редактора: какие пункты показать.
 *
 * Собирается здесь чистой функцией: что доступно сейчас, решают снимок
 * `EditorContextInfo` и ответы зависимостей (каталог команд, закладки,
 * орфография). Показывает меню приложение — у него попапы и реестр команд.
 * `app.ts` передаёт настоящие зависимости, юнит-тест
 * (`tests/editor-context-menu.test.ts`) — подставные, и проверяет состав пунктов
 * без браузера.
 */
export interface EditorMenuDeps {
  /** Есть ли команда в каталоге редактора: переходы и переименование живут только с языковым сервером. */
  hasAction(id: string): boolean;
  runAction(id: string): void;
  /** Буфер обмена — через редактор: он ведёт свою историю и выделение. */
  cut(): void;
  copy(): void;
  paste(): void;
  /** Под курсором слово с ошибкой орфографии — без него пунктов словаря нет. */
  spellingAtCursor(): boolean;
  addToDictionary(): void;
  ignoreSpelling(): void;
  isBookmarked(path: string, line: number): boolean;
  toggleBookmark(path: string, line: number): void;
  openBookmarks(): void;
  refactorMenu(path: string): void;
  refactor(path: string, action: RefactorAction): void;
  codeActions(path: string, position: { line: number; column: number }): void;
}

/**
 * Пункты меню по месту клика. Порядок привычный: история, буфер, выделение и
 * отступы, поиск, дальше то, что зависит от языка и от файла.
 */
export function editorContextMenuPlan(info: EditorContextInfo, deps: EditorMenuDeps): PopupMenuItem[] {
  const items: PopupMenuItem[] = [
    {
      label: 'Отменить',
      hint: 'Ctrl+Z',
      onSelect: () => deps.runAction('editor.undo'),
    },
    {
      label: 'Повторить',
      hint: 'Ctrl+Y',
      onSelect: () => deps.runAction('editor.redo'),
    },
    { separator: true },
  ];
  if (info.hasSelection) {
    items.push(
      { label: 'Вырезать', hint: 'Ctrl+X', onSelect: () => deps.cut() },
      { label: 'Копировать', hint: 'Ctrl+C', onSelect: () => deps.copy() },
    );
  }
  items.push(
    { label: 'Вставить', hint: 'Ctrl+V', onSelect: () => deps.paste() },
    { separator: true },
    {
      label: 'Выделить всё',
      hint: 'Ctrl+A',
      onSelect: () => deps.runAction('editor.selectAll'),
    },
    { separator: true },
    {
      label: 'Увеличить отступ',
      hint: 'Tab',
      onSelect: () => deps.runAction('editor.indent'),
    },
    {
      label: 'Уменьшить отступ',
      hint: 'Shift+Tab',
      onSelect: () => deps.runAction('editor.outdent'),
    },
    { separator: true },
    {
      label: 'Найти',
      hint: 'Ctrl+F',
      onSelect: () => deps.runAction('editor.find'),
    },
    {
      label: 'Найти и заменить',
      hint: 'Ctrl+H',
      onSelect: () => deps.runAction('editor.replace'),
    },
    {
      label: 'Перейти к строке',
      hint: 'Ctrl+G',
      onSelect: () => deps.runAction('editor.gotoLine'),
    },
  );
  // Переходы по символу и переименование доступны только с языковым сервером:
  // без него этих команд в каталоге редактора нет — и пунктов не показываем.
  if (deps.hasAction('editor.goToDefinition')) {
    items.push(
      { separator: true },
      {
        label: 'Перейти к определению',
        onSelect: () => deps.runAction('editor.goToDefinition'),
      },
      {
        label: 'Заглянуть в определение',
        onSelect: () => deps.runAction('editor.peekDefinition'),
      },
      {
        label: 'Найти все ссылки',
        onSelect: () => deps.runAction('editor.references'),
      },
      {
        label: 'Переименовать символ',
        onSelect: () => deps.runAction('editor.renameSymbol'),
      },
    );
    // Рефакторинги тоже делает сервер. Извлечение — только по выделению: пункт есть,
    // когда есть что выносить.
    const path = info.path;
    if (path) {
      items.push({
        label: 'Рефакторинг…',
        onSelect: () => deps.refactorMenu(path),
      });
      if (info.hasSelection) {
        items.push({
          label: 'Извлечь…',
          onSelect: () => deps.refactor(path, 'extract'),
        });
      }
      items.push({
        label: 'Развернуть (inline)…',
        onSelect: () => deps.refactor(path, 'inline'),
      });
    }
  }
  // Закладка ставится на конкретную строку, поэтому и пункт есть только у файла.
  const bookmarkPath = info.path;
  if (bookmarkPath) {
    const bookmarked = deps.isBookmarked(bookmarkPath, info.line);
    items.push(
      { separator: true },
      {
        label: bookmarked ? 'Убрать закладку' : 'Поставить закладку',
        onSelect: () => deps.toggleBookmark(bookmarkPath, info.line),
      },
      {
        label: 'Закладки…',
        hint: 'Ctrl+Alt+B',
        onSelect: () => deps.openBookmarks(),
      },
    );
  }
  // Орфография: пункты есть, только когда под курсором слово с ошибкой.
  if (deps.spellingAtCursor()) {
    items.push(
      { separator: true },
      { label: 'Добавить в словарь', onSelect: () => deps.addToDictionary() },
      { label: 'Пропустить слово', onSelect: () => deps.ignoreSpelling() },
    );
  }
  // Быстрые исправления: пункт есть там, где он что-то даст — с языковым сервером.
  if (info.path && deps.hasAction('editor.codeActions')) {
    items.push({
      label: 'Быстрые исправления…',
      hint: 'Ctrl+.',
      onSelect: () => deps.codeActions(info.path!, { line: info.line, column: info.column }),
    });
  }
  return items;
}
