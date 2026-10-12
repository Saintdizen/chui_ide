import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findPackages } from '../src/main/project/packages';

/**
 * Поиск пакетов в проекте: раскрытие `workspaces`, неглубокий обход и служебные
 * каталоги. Последнее — самое важное: в монорепо `node_modules` набит чужими
 * `package.json`, и если бы мы туда заходили, список пакетов был бы мусором.
 */
describe('findPackages', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeRoot(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'chui-mono-'));
    dirs.push(dir);
    return dir;
  }

  async function writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  }

  it('пакеты берутся по workspaces, а служебные каталоги пропускаются', async () => {
    const root = await makeRoot();
    await writeJson(path.join(root, 'package.json'), { name: 'root', workspaces: ['packages/*'] });
    await writeJson(path.join(root, 'packages', 'api', 'package.json'), { name: '@app/api' });
    await writeJson(path.join(root, 'packages', 'web', 'package.json'), { name: '@app/web' });
    // Чужой манифест внутри node_modules — в списке пакетов его быть не должно.
    await writeJson(path.join(root, 'node_modules', 'left-pad', 'package.json'), { name: 'left-pad' });
    // Каталог вне масок: с workspaces он не считается пакетом.
    await writeJson(path.join(root, 'scripts', 'package.json'), { name: 'scripts' });

    const packages = await findPackages(root);
    expect(packages.map((item) => item.name)).toEqual(['root', '@app/api', '@app/web']);
    expect(packages.map((item) => item.path)).toEqual(['', 'packages/api', 'packages/web']);
  });

  it('без workspaces пакеты ищутся по манифестам неглубоко', async () => {
    const root = await makeRoot();
    await writeJson(path.join(root, 'package.json'), { name: 'just-root' });
    await writeJson(path.join(root, 'apps', 'web', 'package.json'), { name: 'web' });
    await mkdir(path.join(root, 'services', 'pay'), { recursive: true });
    await writeFile(path.join(root, 'services', 'pay', 'pyproject.toml'), '[project]\nname = "pay"\n', 'utf8');

    const packages = await findPackages(root);
    const names = packages.map((item) => item.name);
    expect(names).toContain('just-root');
    expect(names).toContain('web');
    expect(names).toContain('pay');
    expect(packages.find((item) => item.name === 'pay')?.kind).toBe('python');
  });

  it('вложенные служебные каталоги не попадают в список', async () => {
    const root = await makeRoot();
    await writeJson(path.join(root, 'package.json'), { name: 'root' });
    await writeJson(path.join(root, 'app', 'package.json'), { name: 'app' });
    await writeJson(path.join(root, 'app', 'dist', 'package.json'), { name: 'built' });
    await writeJson(path.join(root, 'app', 'node_modules', 'x', 'package.json'), { name: 'x' });
    await writeJson(path.join(root, '.venv', 'lib', 'package.json'), { name: 'venv' });

    const names = (await findPackages(root)).map((item) => item.name);
    expect(names).toEqual(['root', 'app']);
  });

  it('проект без манифестов даёт пустой список', async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, 'README.md'), '# нет манифестов\n', 'utf8');
    expect(await findPackages(root)).toEqual([]);
  });

  it('пустой корень не читаем', async () => {
    expect(await findPackages('')).toEqual([]);
  });
});
