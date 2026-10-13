import { describe, expect, it } from 'vitest';
import type { GitFileStatus } from '../src/shared/api';
import { deletedInFolder } from '../src/shared/git-deleted';

const file = (path: string, change: GitFileStatus['change']): GitFileStatus => ({
  path,
  relative: path,
  change,
  staged: false,
  unstaged: true,
});

/**
 * Удалённые файлы папки: дерево их иначе не покажет — на диске файла уже нет.
 * Разбор путей идёт на разделителе системы, поэтому случай Windows проверяется
 * отдельно: с жёстким «/» папку там не найти.
 */
describe('deletedInFolder', () => {
  it('берёт только удалённые файлы этой папки', () => {
    const files = [file('/p/src/gone.ts', 'deleted'), file('/p/src/keep.ts', 'modified')];
    expect(deletedInFolder(files, '/p/src').map((item) => item.path)).toEqual(['/p/src/gone.ts']);
  });

  it('не заходит во вложенные папки', () => {
    const files = [file('/p/src/deep/gone.ts', 'deleted')];
    expect(deletedInFolder(files, '/p/src')).toEqual([]);
    expect(deletedInFolder(files, '/p/src/deep').map((item) => item.path)).toEqual(['/p/src/deep/gone.ts']);
  });

  it('изменённые и новые файлы не подставляются', () => {
    const files = [file('/p/a.ts', 'modified'), file('/p/b.ts', 'untracked'), file('/p/c.ts', 'added')];
    expect(deletedInFolder(files, '/p')).toEqual([]);
  });

  it('разбирает пути Windows', () => {
    const files = [file('C:\\p\\src\\gone.ts', 'deleted')];
    expect(deletedInFolder(files, 'C:\\p\\src').map((item) => item.path)).toEqual(['C:\\p\\src\\gone.ts']);
  });
});
