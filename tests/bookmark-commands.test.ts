import { describe, expect, it } from 'vitest';
import { registerBookmarkCommands, type BookmarkDeps } from '../src/renderer/core/bookmark-commands';
import { BookmarkModel } from '../src/renderer/core/bookmarks';
import type { DefineCommand } from '../src/renderer/core/command-args';

type Run = (...args: unknown[]) => unknown;

/**
 * Закладки — вынесенная семья `editor.*`: команды не держат состояния, всё
 * приходит через порты. Сторож держит три вещи, которые легко сломать при
 * переезде: набор команд, хождение между файлами и молчание без файла в фокусе.
 */
function setup(path: string | null = '/p/a.ts') {
  const commands = new Map<string, Run>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const toasts: string[] = [];
  const log: string[] = [];
  const bookmarks = new BookmarkModel();
  const deps = {
    bookmarks,
    list: { open: () => log.push('list') },
    editors: {
      currentPath: path,
      cursor: () => ({ line: 5 }),
      reveal: (file: string, line: number, column: number) => log.push(`reveal:${file}:${line}:${column}`),
    },
    openPath: async (file: string) => {
      log.push(`open:${file}`);
    },
    showToast: (message: string) => toasts.push(message),
    ...({} as Partial<BookmarkDeps>),
  } as unknown as BookmarkDeps;
  registerBookmarkCommands(define, deps);
  return { commands, bookmarks, toasts, log };
}

describe('registerBookmarkCommands', () => {
  it('регистрирует 5 команд семейства закладок', () => {
    const { commands } = setup();
    expect([...commands.keys()].sort()).toEqual([
      'editor.bookmarksList',
      'editor.clearBookmarksInFile',
      'editor.nextBookmark',
      'editor.previousBookmark',
      'editor.toggleBookmark',
    ]);
  });

  it('ставить и снимать закладку — на строке курсора в текущем файле', () => {
    const { commands, bookmarks } = setup();
    commands.get('editor.toggleBookmark')!();
    expect(bookmarks.all).toEqual([expect.objectContaining({ path: '/p/a.ts', line: 5 })]);
    commands.get('editor.toggleBookmark')!();
    expect(bookmarks.all).toEqual([]);
  });

  it('без файла в фокусе закладка не ставится и файл не чистится', () => {
    const { commands, bookmarks } = setup(null);
    commands.get('editor.toggleBookmark')!();
    commands.get('editor.clearBookmarksInFile')!();
    expect(bookmarks.all).toEqual([]);
  });

  it('переход к закладке сначала открывает её файл, потом показывает строку', async () => {
    const { commands, bookmarks, log } = setup();
    bookmarks.toggle('/p/b.ts', 12);
    commands.get('editor.nextBookmark')!();
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toContain('open:/p/b.ts');
    expect(log.some((item) => item.startsWith('reveal:/p/b.ts:12:'))).toBe(true);
  });

  it('без закладок сообщает об этом, а не открывает пустоту', () => {
    const { commands, toasts, log } = setup();
    commands.get('editor.nextBookmark')!();
    expect(toasts).toEqual(['Закладок нет']);
    expect(log).toEqual([]);
  });

  it('список открывается по своей команде', () => {
    const { commands, log } = setup();
    commands.get('editor.bookmarksList')!();
    expect(log).toEqual(['list']);
  });
});
