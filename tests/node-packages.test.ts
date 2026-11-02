import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { availablePackages, missingPackages } from '../src/main/node/packages';

/**
 * Какие пакеты видит Node-проект (`main/node/packages.ts`).
 *
 * От этого зависит разметка импортов: неверный ответ либо ругает встроенные модули,
 * либо молчит про отсутствующий пакет. Поэтому проверяется и обход `node_modules`
 * (обычные и scoped, служебные каталоги), и подъём по дереву, и кэш.
 *
 * Каждый тест — свой временный каталог: кэш в модуле общий, и одинаковые пути из
 * разных тестов перепутались бы.
 */

const roots: string[] = [];

afterEach(async () => {
  for (const dir of roots) await fs.rm(dir, { recursive: true, force: true });
  roots.length = 0;
});

async function project(files: string[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-node-pkgs-'));
  roots.push(root);
  for (const name of files) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '{}');
  }
  return root;
}

describe('доступные пакеты', () => {
  it('видит обычные и scoped пакеты в node_modules', async () => {
    const root = await project(['node_modules/vue/package.json', 'node_modules/@acme/api/package.json']);

    const names = await availablePackages(root);

    expect(names.has('vue')).toBe(true);
    expect(names.has('@acme/api')).toBe(true);
  });

  it('служебные каталоги node_modules пропускаются', async () => {
    // `.bin` и кэши лежат рядом с пакетами и пакетами не являются.
    const root = await project(['node_modules/.bin/vite', 'node_modules/vue/package.json']);

    const names = await availablePackages(root);

    expect(names.has('.bin')).toBe(false);
    expect(names.has('vue')).toBe(true);
  });

  it('без node_modules — пусто, без ошибки', async () => {
    const root = await project(['package.json']);

    await expect(availablePackages(root)).resolves.toEqual(new Set());
  });

  it('пакеты видны и из node_modules выше по дереву', async () => {
    // Так работает разрешение Node: в монорепозитории пакеты часто лежат на уровень
    // выше проекта, и без подъёма они выглядели бы отсутствующими.
    const root = await project(['node_modules/vue/package.json', 'packages/web/package.json']);

    const names = await availablePackages(path.join(root, 'packages', 'web'));

    expect(names.has('vue')).toBe(true);
  });

  it('повторный запрос берёт короткий кэш', async () => {
    // Кэш нужен, чтобы разметка импортов не обходила дерево на каждый файл.
    const root = await project(['node_modules/vue/package.json']);
    const first = await availablePackages(root);

    // Пакет появился на диске, но кэш ещё жив — ответ прежний.
    await fs.mkdir(path.join(root, 'node_modules', 'vitest'), { recursive: true });
    const second = await availablePackages(root);

    expect(second).toBe(first);
    expect(second.has('vitest')).toBe(false);
  });
});

describe('недоступные пакеты', () => {
  it('встроенные модули не считаются отсутствующими', async () => {
    // `node:fs` и `fs` — одно и то же, и разметка не должна на них ругаться.
    const root = await project(['package.json']);

    const missing = await missingPackages(root, ['node:fs', 'fs', 'path']);

    expect(missing).toEqual([]);
  });

  it('недоступные пакеты возвращаются по одному разу, в порядке появления', async () => {
    const root = await project(['node_modules/vue/package.json']);

    const missing = await missingPackages(root, ['vue', 'lodash', 'lodash', 'chalk']);

    expect(missing).toEqual(['lodash', 'chalk']);
  });

  it('пустой список импортов даёт пустой ответ', async () => {
    await expect(missingPackages(null, [])).resolves.toEqual([]);
  });

  it('без корня проекта проверяются только встроенные модули', async () => {
    // Файл вне проекта: судить о пакетах не по чему, но встроенные известны всегда.
    const missing = await missingPackages(null, ['fs', 'lodash']);

    expect(missing).toEqual(['lodash']);
  });

  it('пустые имена отбрасываются', async () => {
    const missing = await missingPackages(null, ['', 'fs']);

    expect(missing).toEqual([]);
  });
});
