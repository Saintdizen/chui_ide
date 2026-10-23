import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Сравнение папок: что считается одинаковым, а что различием.
 *
 * Главное здесь — честность: размер совпал, а байты разные — это РАЗНЫЕ файлы.
 * Ошибиться легко и дорого: «идентично» по одному размеру значит, что человек
 * не увидит расхождение. Отказы («слева не папка») ловятся ДО обхода.
 */

const roots: string[] = [];
const services: WorkspaceService[] = [];

afterEach(async () => {
  for (const ws of services.splice(0)) ws.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-ws5-')));
  roots.push(dir);
  return dir;
}

async function write(dir: string, relative: string, text: string): Promise<void> {
  const full = path.join(dir, ...relative.split('/'));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text, 'utf8');
}

/**
 * Сравнение идёт ТОЛЬКО внутри открытого проекта: `safePath` не пускает за
 * корень. Поэтому обе папки создаются под открытым корнем.
 */
async function scoped(): Promise<{ ws: WorkspaceService; root: string }> {
  const root = await makeDir();
  const ws = new WorkspaceService(
    () => undefined,
    () => undefined,
  );
  services.push(ws);
  await ws.open(root);
  return { ws, root };
}

/** Пара папок внутри корня: слева и справа. */
async function pair(): Promise<{ ws: WorkspaceService; left: string; right: string; root: string }> {
  const { ws, root } = await scoped();
  const left = path.join(root, 'left');
  const right = path.join(root, 'right');
  await fs.mkdir(left, { recursive: true });
  await fs.mkdir(right, { recursive: true });
  return { ws, left, right, root };
}

describe('compareFolders', () => {
  it('различия перечислены по именам: слева, справа, совпало', async () => {
    const { ws, left, right } = await pair();
    await write(left, 'same.ts', 'const a = 1;\n');
    await write(right, 'same.ts', 'const a = 1;\n');
    await write(left, 'only-left.ts', 'x\n');
    await write(right, 'only-right.ts', 'y\n');

    const result = await ws.compareFolders(left, right);

    expect(result.truncated).toBe(false);
    // Файл только слева — удалённый, только справа — добавленный.
    expect(result.files.find((file) => file.path === 'only-left.ts')?.change).toBe('deleted');
    expect(result.files.find((file) => file.path === 'only-right.ts')?.change).toBe('added');
    // Совпавший в список различий НЕ попадает — только в счётчик.
    expect(result.files.find((file) => file.path === 'same.ts')).toBeUndefined();
    expect(result.identical).toBe(1);
  });

  it('одинаковый РАЗМЕР при разном содержимом — всё равно различие', async () => {
    const { ws, left, right } = await pair();
    // Строки одной длины: по размеру неразличимы, по байтам — разные.
    await write(left, 'a.ts', 'const a = 1;\n');
    await write(right, 'a.ts', 'const a = 2;\n');

    const result = await ws.compareFolders(left, right);

    // Главное: размер совпал, но файл НЕ считается одинаковым.
    expect(result.files).toEqual([{ path: 'a.ts', change: 'modified' }]);
    expect(result.identical).toBe(0);
  });

  it('полностью совпадающие папки — identical и без ложных различий', async () => {
    const { ws, left, right } = await pair();
    await write(left, 'deep/nested/a.ts', 'export const x = 1;\n');
    await write(right, 'deep/nested/a.ts', 'export const x = 1;\n');

    const result = await ws.compareFolders(left, right);

    expect(result.identical).toBe(1);
    expect(result.files).toEqual([]);
  });

  it('служебные папки (node_modules, .git) в сравнение не идут', async () => {
    const { ws, left, right } = await pair();
    // Файл ЕСТЬ ТОЛЬКО СЛЕВА — без пропуска он попал бы в различия.
    await write(left, 'node_modules/dep/index.js', 'module.exports = 1;\n');
    await write(left, '.git/HEAD', 'ref: refs/heads/main\n');
    await write(left, 'src/a.ts', 'x\n');
    await write(right, 'src/a.ts', 'x\n');

    const result = await ws.compareFolders(left, right);

    // Иначе папка с зависимостями «различалась» бы всегда.
    expect(result.files).toEqual([]);
    expect(result.identical).toBe(1);
  });

  it('файл вместо папки — InvalidParams до обхода', async () => {
    const { ws, left, right } = await pair();
    await write(left, 'a.txt', 'x\n');

    await expect(ws.compareFolders(path.join(left, 'a.txt'), right)).rejects.toThrow(/Слева не папка/);
    await expect(ws.compareFolders(left, path.join(left, 'a.txt'))).rejects.toThrow(/Справа не папка/);
  });

  it('несуществующая папка — отказ, а не пустой результат', async () => {
    const { ws, left } = await pair();
    await expect(ws.compareFolders(path.join(left, 'нет'), left)).rejects.toThrow(/Слева не папка/);
  });

  it('сравнение за пределы проекта не пускается вовсе', async () => {
    const { ws } = await pair();
    const outside = await makeDir();
    // safePath срабатывает раньше stat: чужой путь — отказ, а не пустой список.
    await expect(ws.compareFolders(outside, outside)).rejects.toThrow(/вне рабочей папки/i);
  });
});
