import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkEnvironment, declaredDependencyNames, installedPackages, nodeInfo } from '../src/main/node/environment';

/**
 * Окружение Node-проекта (`main/node/environment.ts`).
 *
 * Всё здесь — файловая система: `package.json`, `node_modules`, файлы блокировки.
 * Поэтому тест собирает настоящий каталог проекта во временной папке, а не
 * подменяет чтение: так проверяется и разбор, и то, какие файлы мы ищем.
 *
 * Версии Node и менеджера пакетов зависят от машины, поэтому их проверяем только
 * на форму: «нет Node» — это факт для интерфейса, а не сбой.
 */

let root = '';

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = '';
});

async function project(files: Record<string, unknown>): Promise<string> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-node-env-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

describe('объявленные зависимости', () => {
  it('собирает обычные и dev-зависимости', async () => {
    const dir = await project({
      'package.json': {
        dependencies: { vue: '^3' },
        devDependencies: { vitest: '^5' },
      },
    });

    const names = await declaredDependencyNames(dir);

    expect(names).toContain('vue');
    expect(names).toContain('vitest');
  });

  it('нет package.json — пустой список, а не падение', async () => {
    const dir = await project({ 'readme.md': 'текст' });

    await expect(declaredDependencyNames(dir)).resolves.toEqual([]);
  });

  it('битый package.json не бросает наружу', async () => {
    // Проект мог сохраняться и быть недописанным: интерфейс должен показать
    // «зависимостей нет», а не упасть всем запросом.
    const dir = await project({ 'package.json': '{ не json' });

    await expect(declaredDependencyNames(dir)).resolves.toEqual([]);
  });
});

describe('установленные пакеты', () => {
  it('читает имена и версии из node_modules', async () => {
    const dir = await project({
      'package.json': { dependencies: { vue: '^3' } },
      'node_modules/vue/package.json': { name: 'vue', version: '3.5.0' },
      'node_modules/vitest/package.json': { name: 'vitest', version: '5.0.3' },
    });

    const packages = await installedPackages(dir);

    expect(packages.map((item) => `${item.name}@${item.version}`).sort()).toEqual(['vitest@5.0.3', 'vue@3.5.0']);
  });

  it('dev-признак берётся из package.json проекта', async () => {
    const dir = await project({
      'package.json': { dependencies: { vue: '^3' }, devDependencies: { vitest: '^5' } },
      'node_modules/vue/package.json': { name: 'vue', version: '3.5.0' },
      'node_modules/vitest/package.json': { name: 'vitest', version: '5.0.3' },
    });

    const packages = await installedPackages(dir);
    const vitest = packages.find((item) => item.name === 'vitest');
    const vue = packages.find((item) => item.name === 'vue');

    expect(vitest?.dev).toBe(true);
    expect(vue?.dev).toBe(false);
  });

  it('пакет без package.json всё равно в списке, но без версии', async () => {
    // Битая установка: пакет есть на диске, версии нет. Молча выкинуть его значит
    // потерять ровно тот случай, ради которого список и нужен.
    const dir = await project({ 'package.json': { dependencies: {} }, 'node_modules/vue/index.js': '' });

    const packages = await installedPackages(dir);

    expect(packages).toHaveLength(1);
    expect(packages[0]?.version).toBe('');
  });

  it('нет node_modules — пустой список', async () => {
    const dir = await project({ 'package.json': { dependencies: {} } });

    await expect(installedPackages(dir)).resolves.toEqual([]);
  });
});

describe('сводка окружения', () => {
  it('менеджер пакетов из файла блокировки', async () => {
    const dir = await project({
      'package.json': { dependencies: {} },
      'pnpm-lock.yaml': 'lockfileVersion: 9',
    });

    const info = await nodeInfo(dir);

    expect(info.packageManager.name).toBe('pnpm');
    expect(info.runtime).toHaveProperty('version');
    expect(info.runtime).toHaveProperty('command');
  });

  it('без проекта — npm и пустой корень', async () => {
    const info = await nodeInfo(null);

    // Имя менеджера нужно интерфейсу всегда: пустой строкой кнопка запуска сломалась бы.
    expect(info.packageManager.name).toBe('npm');
  });

  it('метка версии Node заполнена всегда', async () => {
    const info = await nodeInfo(null);

    expect(info.runtime.label.length).toBeGreaterThan(0);
  });
});

describe('проверка окружения', () => {
  it('пустой node_modules при объявленных зависимостях — проблема', async () => {
    const dir = await project({ 'package.json': { dependencies: { vue: '^3' } } });

    // Результат — группы проблем по корням проекта, внутри каждой свои `issues`.
    const groups = await checkEnvironment(dir);
    const issues = groups.flatMap((group) => group.issues);

    expect(issues.length).toBeGreaterThan(0);
    expect(issues.map((issue) => issue.kind).join(' ')).toMatch(/modules|depend/);
  });

  it('всё на месте — список проблем пуст', async () => {
    const dir = await project({
      'package.json': { dependencies: { vue: '^3' } },
      'package-lock.json': '{}',
      'node_modules/vue/package.json': { name: 'vue', version: '3.5.0' },
    });

    const issues = (await checkEnvironment(dir)).flatMap((group) => group.issues);

    // Версия Node на машине может не подойти под engines — тогда единственная
    // жалоба должна быть про неё, а не про пакеты.
    expect(issues.filter((issue) => issue.kind !== 'engine-mismatch')).toEqual([]);
  });

  it('несовместимая версия Node из engines попадает в проблемы', async () => {
    const dir = await project({
      'package.json': { dependencies: {}, engines: { node: '>=99' } },
      'node_modules/.keep': '',
    });

    const issues = (await checkEnvironment(dir)).flatMap((group) => group.issues);

    expect(issues.some((issue) => issue.kind === 'engine-mismatch')).toBe(true);
  });
});
