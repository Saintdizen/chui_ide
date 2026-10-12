import { describe, expect, it } from 'vitest';
import {
  groupByPackage,
  isMonorepo,
  manifestName,
  matchWorkspaces,
  NO_PACKAGE,
  packageAt,
  packageForPath,
  packagesLabel,
  parseManifest,
  parseWorkspaces,
  type ProjectPackage,
} from '../src/shared/monorepo';

/**
 * Пакеты монорепозитория: чтение манифестов, маски рабочих областей и отнесение
 * файла к пакету. Ловушка тут одна, но важная: вложенный пакет должен выигрывать у
 * внешнего (`packages/web/lib` — свой пакет), иначе правка попадёт «не в тот ящик».
 */
describe('манифесты', () => {
  it('имя читается из package.json', () => {
    expect(manifestName('{"name":"@app/web","version":"1.0.0"}')).toBe('@app/web');
  });

  it('битый или чужой json даёт пустое имя', () => {
    expect(manifestName('{ это не json')).toBe('');
    expect(manifestName('[]')).toBe('');
    expect(manifestName('{"name":42}')).toBe('');
  });

  it('workspaces читаются и массивом, и объектом', () => {
    expect(parseWorkspaces('{"workspaces":["packages/*","apps/web"]}')).toEqual(['packages/*', 'apps/web']);
    expect(parseWorkspaces('{"workspaces":{"packages":["libs/*"]}}')).toEqual(['libs/*']);
    expect(parseWorkspaces('{}')).toEqual([]);
    expect(parseWorkspaces('мусор')).toEqual([]);
  });

  it('parseManifest отдаёт и имя, и маски', () => {
    expect(parseManifest('{"name":"root","workspaces":["p/*"]}')).toEqual({ name: 'root', workspaces: ['p/*'] });
  });
});

describe('packageAt', () => {
  it('имя берётся из манифеста, иначе из папки', () => {
    expect(packageAt('packages/api', 'node', '{"name":"@app/api"}')).toEqual({
      name: '@app/api',
      path: 'packages/api',
      kind: 'node',
    });
    expect(packageAt('services/pay', 'python')).toEqual({ name: 'pay', path: 'services/pay', kind: 'python' });
  });

  it('корень получает путь пустым', () => {
    expect(packageAt('/', 'node', '{"name":"root"}')).toEqual({ name: 'root', path: '', kind: 'node' });
  });

  it('без имени в манифесте остаётся имя папки', () => {
    expect(packageAt('apps/сборка', 'node', '{}').name).toBe('сборка');
  });
});

describe('matchWorkspaces', () => {
  const dirs = ['packages', 'packages/api', 'packages/web', 'apps/mobile', 'libs/util/deep', 'docs'];

  it('маска «packages/*» берёт папки внутри packages', () => {
    expect(matchWorkspaces(['packages/*'], dirs)).toEqual(['packages/api', 'packages/web']);
  });

  it('маска «**» съедает любую глубину', () => {
    expect(matchWorkspaces(['libs/**'], dirs)).toEqual(['libs/util/deep']);
  });

  it('точный путь совпадает только сам с собой', () => {
    expect(matchWorkspaces(['apps/mobile'], dirs)).toEqual(['apps/mobile']);
    // Каталога `apps` в списке нет — значит и совпадений нет.
    expect(matchWorkspaces(['apps'], dirs)).toEqual([]);
  });

  it('нет совпадений — пусто', () => {
    expect(matchWorkspaces(['nope/*'], dirs)).toEqual([]);
  });
});

describe('packageForPath', () => {
  const packages: ProjectPackage[] = [
    { name: 'root', path: '', kind: 'node' },
    { name: 'api', path: 'packages/api', kind: 'node' },
    { name: 'web', path: 'packages/web', kind: 'node' },
    { name: 'web-lib', path: 'packages/web/lib', kind: 'node' },
  ];

  it('файл относится к своему пакету', () => {
    expect(packageForPath(packages, 'packages/api/src/index.ts')?.name).toBe('api');
    expect(packageForPath(packages, 'README.md')?.name).toBe('root');
  });

  it('вложенный пакет выигрывает у внешнего', () => {
    expect(packageForPath(packages, 'packages/web/lib/util.ts')?.name).toBe('web-lib');
    expect(packageForPath(packages, 'packages/web/app.ts')?.name).toBe('web');
  });

  it('похожий по имени путь не считается вложенным', () => {
    // `packages/web-tools` не внутри `packages/web`.
    expect(packageForPath(packages, 'packages/web-tools/a.ts')?.name).toBe('root');
  });

  it('без корневого пакета файл вне пакетов', () => {
    const only: ProjectPackage[] = [{ name: 'api', path: 'packages/api', kind: 'node' }];
    expect(packageForPath(only, 'README.md')).toBeNull();
  });
});

describe('groupByPackage', () => {
  const packages: ProjectPackage[] = [
    { name: 'root', path: '', kind: 'node' },
    { name: 'api', path: 'packages/api', kind: 'node' },
    { name: 'web', path: 'packages/web', kind: 'python' },
  ];

  it('файлы раскладываются по пакетам, корень — в конце', () => {
    const groups = groupByPackage(packages, ['packages/web/a.ts', 'packages/api/b.ts', 'README.md', 'docs/c.md']);
    // Корневой пакет вмещает всё, что не попало во вложенные: и README, и docs.
    expect(groups.map((group) => group.name)).toEqual(['api', 'web', 'root']);
    expect(groups[0]?.files).toEqual(['packages/api/b.ts']);
    expect(groups[2]?.files).toEqual(['README.md', 'docs/c.md']);
  });

  it('остаток помечен знаком, который не спутать с корнем', () => {
    const groups = groupByPackage([{ name: 'api', path: 'packages/api', kind: 'node' }], ['README.md']);
    expect(groups[0]?.path).toBe(NO_PACKAGE);
  });
});

describe('монорепо и подпись', () => {
  it('монорепо — когда пакетов больше одного', () => {
    expect(isMonorepo([{ name: 'root', path: '', kind: 'node' }])).toBe(false);
    expect(
      isMonorepo([
        { name: 'root', path: '', kind: 'node' },
        { name: 'api', path: 'packages/api', kind: 'node' },
      ]),
    ).toBe(false);
    expect(
      isMonorepo([
        { name: 'api', path: 'packages/api', kind: 'node' },
        { name: 'web', path: 'packages/web', kind: 'node' },
      ]),
    ).toBe(true);
  });

  it('подпись списка пакетов склоняется', () => {
    expect(packagesLabel([])).toBe('пакетов не найдено');
    expect(packagesLabel([{ name: 'a', path: 'a', kind: 'node' }])).toBe('1 пакет');
    expect(
      packagesLabel([
        { name: 'a', path: 'a', kind: 'node' },
        { name: 'b', path: 'b', kind: 'node' },
      ]),
    ).toBe('2 пакета');
    expect(
      packagesLabel([
        { name: 'a', path: 'a', kind: 'node' },
        { name: 'b', path: 'b', kind: 'node' },
        { name: 'c', path: 'c', kind: 'node' },
        { name: 'd', path: 'd', kind: 'node' },
        { name: 'e', path: 'e', kind: 'node' },
      ]),
    ).toBe('5 пакетов');
  });
});
