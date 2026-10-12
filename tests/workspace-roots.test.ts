import { describe, expect, it } from 'vitest';
import {
  appendRoot,
  hasRoot,
  nextActiveRoot,
  normalizeRootList,
  removeRoot,
  relativeToRoots,
  rootForPath,
  workspaceLabel,
  type WorkspaceRoot,
} from '../src/shared/workspace-roots';

/**
 * Рабочая область из нескольких корней. Ловушка одна и та же во всём: файл должен
 * относиться к САМОМУ ГЛУБОКОМУ корню (вложенные папки — обычное дело), и границу
 * пути нельзя путать с похожим именем (`/proj` против `/project`).
 */
describe('normalizeRootList', () => {
  it('строит корни из путей, имя — последний сегмент', () => {
    expect(normalizeRootList(['/home/u/api'])).toEqual([{ root: '/home/u/api', name: 'api' }]);
  });

  it('хвостовые разделители убираются, повторы схлопываются', () => {
    expect(normalizeRootList(['/a/b/', '/a/b', '/a/c'])).toEqual([
      { root: '/a/b', name: 'b' },
      { root: '/a/c', name: 'c' },
    ]);
  });

  it('пустые строки пропускаются', () => {
    expect(normalizeRootList(['', '/a'])).toEqual([{ root: '/a', name: 'a' }]);
  });
});

describe('rootForPath', () => {
  const roots: WorkspaceRoot[] = [
    { root: '/work/api', name: 'api' },
    { root: '/work/api/packages/web', name: 'web' },
    { root: '/work/docs', name: 'docs' },
  ];

  it('файл относится к своему корню', () => {
    expect(rootForPath(roots, '/work/api/src/a.ts')?.name).toBe('api');
    expect(rootForPath(roots, '/work/docs/readme.md')?.name).toBe('docs');
  });

  it('вложенный корень выигрывает у внешнего', () => {
    expect(rootForPath(roots, '/work/api/packages/web/app.ts')?.name).toBe('web');
  });

  it('сам корень принадлежит себе', () => {
    expect(rootForPath(roots, '/work/api')?.name).toBe('api');
  });

  it('похожее имя не считается вложенным', () => {
    // `/work/api2` не внутри `/work/api`.
    expect(rootForPath(roots, '/work/api2/a.ts')).toBeNull();
    expect(rootForPath(roots, '/work/apix/a.ts')).toBeNull();
  });

  it('файл вне всех корней — null', () => {
    expect(rootForPath(roots, '/etc/passwd')).toBeNull();
    expect(rootForPath([], '/a')).toBeNull();
  });
});

describe('relativeToRoots', () => {
  const roots: WorkspaceRoot[] = [
    { root: '/work/api', name: 'api' },
    { root: '/work/api/packages/web', name: 'web' },
  ];

  it('путь считается от своего корня, а не от «текущего проекта»', () => {
    expect(relativeToRoots(roots, '/work/api/src/a.ts')).toBe('src/a.ts');
    // Файл из вложенного корня — относительно него, без «../../».
    expect(relativeToRoots(roots, '/work/api/packages/web/app.ts')).toBe('app.ts');
  });

  it('файл вне корней возвращается как есть', () => {
    expect(relativeToRoots(roots, '/etc/passwd')).toBe('/etc/passwd');
  });
});

describe('добавление и удаление корней', () => {
  const roots: WorkspaceRoot[] = normalizeRootList(['/a', '/b']);

  it('appendRoot не дублирует', () => {
    expect(appendRoot(roots, '/a')).toHaveLength(2);
    expect(appendRoot(roots, '/c').map((item) => item.root)).toEqual(['/a', '/b', '/c']);
  });

  it('hasRoot сравнивает с точностью до хвостового разделителя', () => {
    expect(hasRoot(roots, '/a/')).toBe(true);
    expect(hasRoot(roots, '/c')).toBe(false);
  });

  it('removeRoot убирает только нужный', () => {
    expect(removeRoot(roots, '/a').map((item) => item.root)).toEqual(['/b']);
  });

  it('после удаления активным становится первый оставшийся', () => {
    expect(nextActiveRoot(roots, '/a')).toBe('/b');
    expect(nextActiveRoot(roots, '/b')).toBe('/a');
    expect(nextActiveRoot([roots[0]!], '/a')).toBeNull();
  });
});

describe('подпись области', () => {
  it('один корень — его имя, несколько — число папок', () => {
    expect(workspaceLabel([])).toBe('нет папки');
    expect(workspaceLabel(normalizeRootList(['/a']))).toBe('a');
    expect(workspaceLabel(normalizeRootList(['/a', '/b', '/c']))).toBe('3 папки');
  });
});
