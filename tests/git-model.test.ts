import { describe, expect, it } from 'vitest';
import { changeInsideFolders } from '../src/renderer/core/git-model';
import type { GitFileStatus } from '../src/shared/api';

/**
 * Раскладка правок по папкам-родителям: по ней свёрнутая папка в дереве помечается
 * как изменённая. Пути приходят от main в родных разделителях (`path.join`), и это
 * важно: резать только по «/» значило бы на Windows не найти ни одной папки.
 */

const file = (path: string, change: GitFileStatus['change']): GitFileStatus => ({
  path,
  relative: path,
  change,
  staged: false,
  unstaged: true,
});

describe('changeInsideFolders', () => {
  it('считает правки по папкам-родителям', () => {
    const inside = changeInsideFolders([file('/proj/src/a.ts', 'modified'), file('/proj/src/b.ts', 'modified')]);
    expect(inside.get('/proj/src')).toEqual({ count: 2, change: 'modified' });
    expect(inside.get('/proj')).toEqual({ count: 2, change: 'modified' });
  });

  it('самая заметная правка побеждает: удаление важнее изменения', () => {
    const inside = changeInsideFolders([file('/proj/src/a.ts', 'modified'), file('/proj/src/b.ts', 'deleted')]);
    expect(inside.get('/proj/src')).toEqual({ count: 2, change: 'deleted' });
  });

  it('новая папка читается как добавленное, а не изменённое', () => {
    const inside = changeInsideFolders([file('/proj/src/a.ts', 'modified'), file('/proj/src/b.ts', 'untracked')]);
    expect(inside.get('/proj/src')?.change).toBe('untracked');
  });

  it('пути Windows с обратными слэшами тоже дают папки', () => {
    // Раньше путь резался только по «/»: на Windows папок не находилось вовсе.
    const inside = changeInsideFolders([file('C:\\proj\\src\\a.ts', 'modified'), file('C:\\proj\\src\\b.ts', 'modified')]);
    expect(inside.get('C:\\proj\\src')).toEqual({ count: 2, change: 'modified' });
    expect(inside.get('C:\\proj')).toEqual({ count: 2, change: 'modified' });
  });

  it('файл в корне папок не создаёт', () => {
    expect(changeInsideFolders([file('/a.ts', 'modified')]).size).toBe(0);
  });

  it('чужие файлы не смешиваются', () => {
    const inside = changeInsideFolders([file('/proj/src/a.ts', 'modified'), file('/proj/tests/b.ts', 'added')]);
    expect(inside.get('/proj/src')).toEqual({ count: 1, change: 'modified' });
    expect(inside.get('/proj/tests')).toEqual({ count: 1, change: 'added' });
    expect(inside.get('/proj')).toEqual({ count: 2, change: 'added' });
  });
});
