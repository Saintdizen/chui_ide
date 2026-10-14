import { describe, expect, it } from 'vitest';
import { packageAncestorDirs, topLevelPackages, type ProjectPackage } from '../src/shared/monorepo';

const pkg = (path: string, name = path): ProjectPackage => ({ path, name, kind: 'node' });

describe('topLevelPackages: пакеты для верхнего уровня дерева', () => {
  it('берёт пакеты, не лежащие внутри другого пакета', () => {
    const packages = [pkg(''), pkg('packages/api'), pkg('packages/web'), pkg('services/pay')];
    expect(topLevelPackages(packages).map((item) => item.path)).toEqual([
      'packages/api',
      'packages/web',
      'services/pay',
    ]);
  });

  it('вложенный пакет в верхний уровень не попадает — он виден при раскрытии родителя', () => {
    const packages = [pkg(''), pkg('packages/web'), pkg('packages/web/lib')];
    expect(topLevelPackages(packages).map((item) => item.path)).toEqual(['packages/web']);
  });

  it('корневой пакет (пустой путь) в верхний уровень не идёт: он и есть сам корень', () => {
    expect(topLevelPackages([pkg(''), pkg('packages/api')]).map((item) => item.path)).toEqual(['packages/api']);
  });

  it('сортирует по пути', () => {
    const packages = [pkg('services/b'), pkg('apps/a')];
    expect(topLevelPackages(packages).map((item) => item.path)).toEqual(['apps/a', 'services/b']);
  });

  it('похожие имена по границе сегмента не путаются', () => {
    // `packages/api2` не лежит внутри `packages/api`.
    const packages = [pkg('packages/api'), pkg('packages/api2')];
    expect(topLevelPackages(packages).map((item) => item.path)).toEqual(['packages/api', 'packages/api2']);
  });
});

describe('packageAncestorDirs: промежуточные каталоги', () => {
  it('собирает все звенья пути к пакету', () => {
    const packages = [pkg('packages/api'), pkg('apps/web/src')];
    expect(packageAncestorDirs(packages).sort()).toEqual(['apps', 'apps/web', 'packages']);
  });

  it('у пакета рядом с корнем предков нет', () => {
    expect(packageAncestorDirs([pkg('api')])).toEqual([]);
  });

  it('корневой пакет предков не даёт', () => {
    expect(packageAncestorDirs([pkg('')])).toEqual([]);
  });

  it('общие звенья не повторяются', () => {
    expect(packageAncestorDirs([pkg('packages/a'), pkg('packages/b')])).toEqual(['packages']);
  });
});
