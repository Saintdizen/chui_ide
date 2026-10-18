import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSeedProvider } from '../src/main/lsp/seed';

/**
 * Файл-затравка: какой файл проекта открывается языковому серверу, чтобы он знал
 * проект и собирал индекс. Проверяется выбор, а не запуск сервера: путь —
 * единственное, что от этого модуля нужно.
 *
 * Главное правило — форма файла, а не первый попавшийся: `tsserver` открывает
 * ПРОЕКТ, в который входит файл, поэтому конфиг в корне (`vite.config.mts`) в
 * качестве затравки дал бы индекс из одного файла.
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** Временный проект: файлы записываются по относительным путям. */
async function project(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lsp-seed-'));
  dirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return root;
}

describe('файл-затравка для языкового сервера', () => {
  it('берёт точку входа проекта, а не конфиг в корне', async () => {
    const root = await project({
      'vite.config.ts': 'export default {};\n',
      'src/main/index.ts': 'export function start(): void {}\n',
      'package.json': '{}\n',
    });
    const seed = createSeedProvider(() => root);
    const document = await seed('typescript');
    expect(document?.path).toBe(path.join(root, 'src', 'main', 'index.ts'));
    expect(document?.text).toContain('export function start');
  });

  it('не берёт служебные и тестовые файлы', async () => {
    const root = await project({
      'node_modules/lib/index.ts': 'export const hidden = 1;\n',
      'src/util.test.ts': 'export const test = 1;\n',
      'src/util.ts': 'export const util = 1;\n',
    });
    const seed = createSeedProvider(() => root);
    expect((await seed('typescript'))?.path).toBe(path.join(root, 'src', 'util.ts'));
  });

  it('языка нет в проекте — затравки нет', async () => {
    const root = await project({ 'src/app.ts': 'export const app = 1;\n' });
    const seed = createSeedProvider(() => root);
    expect(await seed('python')).toBeNull();
  });

  it('корень не открыт — затравки нет', async () => {
    const seed = createSeedProvider(() => null);
    expect(await seed('typescript')).toBeNull();
  });

  it('кеш считается на корень: другой проект — другой файл', async () => {
    const first = await project({ 'src/main/index.ts': 'export const first = 1;\n' });
    const second = await project({ 'src/main/index.ts': 'export const second = 1;\n' });
    let current = first;
    const seed = createSeedProvider(() => current);
    expect((await seed('typescript'))?.text).toContain('first');
    current = second;
    expect((await seed('typescript'))?.text).toContain('second');
  });
});
