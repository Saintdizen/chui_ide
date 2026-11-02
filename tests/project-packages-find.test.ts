import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findPackages } from '../src/main/project/packages';

/**
 * Поиск пакетов в проекте (`main/project/packages.ts`).
 *
 * По пакетам у файла появляется хозяин: на них держится навигация и запуск в
 * контейнере пакета. Поэтому важно и что нашли, и что НЕ нашли служебные каталоги —
 * иначе `node_modules` завалит список тысячами «пакетов».
 */

let root = '';

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = '';
});

async function project(files: Record<string, unknown>): Promise<string> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-pkgs-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

describe('пакеты проекта', () => {
  it('одиночный проект: манифест в корне — пакет с пустым путём', async () => {
    const dir = await project({ 'package.json': { name: 'single' } });

    const packages = await findPackages(dir);

    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({ path: '', kind: 'node', name: 'single' });
  });

  it('python-проект узнаётся по pyproject.toml', async () => {
    const dir = await project({ 'pyproject.toml': '[project]\nname = "cowsay"\n' });

    const packages = await findPackages(dir);

    expect(packages[0]).toMatchObject({ path: '', kind: 'python' });
    // Имя для python-корня не берётся из TOML: подпись общая — «корень».
    expect(packages[0]?.name).toBeTruthy();
  });

  it('монорепо: корень плюс пакеты из workspaces', async () => {
    // Маски точнее обхода: вошли только названные пакеты, а не всё подряд.
    const dir = await project({
      'package.json': { name: 'root', workspaces: ['packages/*'] },
      'packages/api/package.json': { name: '@acme/api' },
      'packages/web/package.json': { name: '@acme/web' },
      'other/tool/package.json': { name: 'чужой' },
    });

    const packages = await findPackages(dir);

    expect(packages.map((item) => item.name).sort()).toEqual(['@acme/api', '@acme/web', 'root']);
  });

  it('без workspaces обход идёт до двух уровней', async () => {
    const dir = await project({
      'package.json': { name: 'root' },
      'apps/api/package.json': { name: 'api' },
      'apps/deep/far/package.json': { name: 'слишком глубоко' },
    });

    const packages = await findPackages(dir);

    // Глубже двух уровней не смотрим: иначе обход большого проекта дорог.
    expect(packages.map((item) => item.name).sort()).toEqual(['api', 'root']);
  });

  it('служебные и скрытые каталоги пропускаются целиком', async () => {
    // `node_modules` — тысячи каталогов с package.json, и они не пакеты проекта.
    const dir = await project({
      'package.json': { name: 'root' },
      'node_modules/vue/package.json': { name: 'vue' },
      'dist/bundle/package.json': { name: 'bundle' },
      '.cache/package.json': { name: 'кэш' },
    });

    const packages = await findPackages(dir);

    expect(packages.map((item) => item.name)).toEqual(['root']);
  });

  it('пустой корень и каталог без манифестов — пустой список', async () => {
    await expect(findPackages('')).resolves.toEqual([]);
    const dir = await project({ 'readme.md': 'проект без пакетов' });
    await expect(findPackages(dir)).resolves.toEqual([]);
  });
});
