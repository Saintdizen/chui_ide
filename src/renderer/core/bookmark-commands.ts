import type { BookmarkModel } from './bookmarks';
import type { DefineCommand } from './command-args';

/** Редакторы: какой файл в фокусе, где курсор и как показать нужную строку. */
export interface BookmarkEditorHost {
  readonly currentPath: string | null;
  cursor(): { line: number };
  reveal(path: string, line: number, column: number): void;
}

/** Список закладок проекта: команда только открывает его. */
export interface BookmarkList {
  open(): void;
}

export interface BookmarkDeps {
  bookmarks: BookmarkModel;
  list: BookmarkList;
  editors: BookmarkEditorHost;
  openPath(path: string): Promise<void>;
  showToast(message: string): void;
}

/**
 * Закладки: поставить или снять на строке курсора, ходить между ними, показать
 * списком. Соседняя закладка может лежать в другом файле — его сначала открывает
 * `openPath`, а показом строки занимается хост. Уборка закладок файла клавиши не
 * получает: это редкое дело, а не жест.
 */
export function registerBookmarkCommands(define: DefineCommand, deps: BookmarkDeps): void {
  const { bookmarks, list, editors, openPath, showToast } = deps;

  define({ id: 'editor.toggleBookmark', title: 'Закладки: поставить или снять', category: 'Навигация' }, () => {
    const path = editors.currentPath;
    if (path) bookmarks.toggle(path, editors.cursor().line);
  });

  /** Перейти к соседней закладке: файл может быть другим — сначала открываем его. */
  const goTo = (direction: 1 | -1): void => {
    const path = editors.currentPath;
    const all = bookmarks.all;
    const target = path
      ? bookmarks.next({ path, line: editors.cursor().line }, direction)
      : ((direction === 1 ? all[0] : all[all.length - 1]) ?? null);
    if (!target) {
      showToast('Закладок нет');
      return;
    }
    void openPath(target.path).then(() => editors.reveal(target.path, target.line, 1));
  };

  define({ id: 'editor.nextBookmark', title: 'Закладки: следующая', category: 'Навигация' }, () => goTo(1));
  define({ id: 'editor.previousBookmark', title: 'Закладки: предыдущая', category: 'Навигация' }, () => goTo(-1));
  define({ id: 'editor.bookmarksList', title: 'Закладки: список', category: 'Навигация' }, () => list.open());
  define({ id: 'editor.clearBookmarksInFile', title: 'Закладки: убрать в файле', category: 'Навигация' }, () => {
    const path = editors.currentPath;
    if (path) bookmarks.clearFile(path);
  });
}
