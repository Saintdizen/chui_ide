import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Сравнение папок и замена по проекту — две операции, которыми человек меняет
 * много файлов разом, не видя каждого. Ценно не «нашлось», а ГРАНИЦЫ:
 * одинаковый размер не значит одинаковое содержимое, а замена не должна
 * трогать файлы вне маски и не должна переписывать то, где не нашлось.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-ws-cmp-')));
  roots.push(base);
  return base;
}

function service(): WorkspaceService {
  return new WorkspaceService(
    () => undefined,
    () => undefined,
  );
}

async function write(dir: string, relative: string, text: string): Promise<void> {
  const full = path.join(dir, ...relative.split('/'));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text, 'utf8');
}
describe('compareFolders', () => {
  it('находит добавленные, удалённые и изменённые при ОДИНАКОВОм размере', async () => {
    const root = await makeDir();
    const left = path.join(root, 'left');
    const right = path.join(root, 'right');
    await fs.mkdir(left);
    await fs.mkdir(right);
    await write(left, 'same.ts', 'abc');
    await write(right, 'same.ts', 'abc');
    await write(left, 'changed.ts', 'abc');
    await write(right, 'changed.ts', 'abd');
    await write(left, 'gone.ts', 'x');
    await write(right, 'new.ts', 'y');

    const ws = service();
    await ws.open(root);
    const result = await ws.compareFolders(left, right);

    const byPath = Object.fromEntries(result.files.map((f) => [f.path, f.change]));
    expect(byPath['same.ts']).toBeUndefined();
    expect(byPath['changed.ts']).toBe('modified');
    expect(byPath['gone.ts']).toBe('deleted');
    expect(byPath['new.ts']).toBe('added');
    expect(result.identical).toBe(1);
  });

  it('разный размер — тоже modified', async () => {
    const root = await makeDir();
    const left = path.join(root, 'left');
    const right = path.join(root, 'right');
    await fs.mkdir(left);
    await fs.mkdir(right);
    await write(left, 'a.ts', 'êðàòêî');
    await write(right, 'a.ts', 'ãîðàçäî äëèííåå');

    const ws = service();
    await ws.open(root);
    const result = await ws.compareFolders(left, right);
    expect(result.files).toEqual([{ path: 'a.ts', change: 'modified' }]);
  });

  it('служебные каталоги в сравнение не попадают', async () => {
    const root = await makeDir();
    const left = path.join(root, 'left');
    const right = path.join(root, 'right');
    await fs.mkdir(left);
    await fs.mkdir(right);
    await write(left, 'node_modules/dep/index.js', 'a');
    await write(left, '.git/config', 'b');
    await write(left, 'real.ts', 'c');

    const ws = service();
    await ws.open(root);
    const result = await ws.compareFolders(left, right);
    expect(result.files.map((f) => f.path)).toEqual(['real.ts']);
  });

  it('вложенность: пути относительные и через прямой слэш', async () => {
    const root = await makeDir();
    const left = path.join(root, 'left');
    const right = path.join(root, 'right');
    await fs.mkdir(left);
    await fs.mkdir(right);
    await write(right, 'a/b/c.ts', 'ãëóáîêî');

    const ws = service();
    await ws.open(root);
    const result = await ws.compareFolders(left, right);
    expect(result.files).toEqual([{ path: 'a/b/c.ts', change: 'added' }]);
  });

  it('не папка — внятный отказ', async () => {
    const root = await makeDir();
    const left = path.join(root, 'left');
    const right = path.join(root, 'right');
    await fs.mkdir(left);
    await fs.mkdir(right);
    await write(left, 'file.ts', 'x');

    const ws = service();
    await ws.open(root);
    await expect(ws.compareFolders(path.join(left, 'file.ts'), right)).rejects.toThrow();
    await expect(ws.compareFolders(left, path.join(left, 'file.ts'))).rejects.toThrow();
  });
});

describe('findFiles', () => {
  it('отдаёт относительные пути и применяет маску', async () => {
    const dir = await makeDir();
    await write(dir, 'src/a.ts', '1');
    await write(dir, 'src/b.js', '2');
    await write(dir, 'README.md', '3');

    const ws = service();
    await ws.open(dir);
    expect(await ws.findFiles('src/*.ts')).toEqual(['src/a.ts']);
    expect((await ws.findFiles()).length).toBe(3);
  });

  it('результат отсортирован и ограничен', async () => {
    const dir = await makeDir();
    for (const name of ['c.ts', 'a.ts', 'b.ts']) await write(dir, name, 'x');

    const ws = service();
    await ws.open(dir);
    expect(await ws.findFiles()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(await ws.findFiles(undefined, 2)).toEqual(['a.ts', 'b.ts']);
  });
});

describe('replace', () => {
  it('меняет только файлы под маской и считает замены', async () => {
    const dir = await makeDir();
    await write(dir, 'src/a.ts', 'foo foo');
    await write(dir, 'src/b.md', 'foo');

    const ws = service();
    await ws.open(dir);
    const result = await ws.replace({ query: 'foo', replacement: 'bar', glob: 'src/*.ts' });

    expect(result.replaced).toBe(2);
    expect(result.files).toHaveLength(1);
    expect(await fs.readFile(path.join(dir, 'src/a.ts'), 'utf8')).toBe('bar bar');
    expect(await fs.readFile(path.join(dir, 'src/b.md'), 'utf8')).toBe('foo');
  });

  it('без совпадений файл не переписывается вовсе', async () => {
    const dir = await makeDir();
    await write(dir, 'a.ts', 'ничего\r\n');
    const before = await fs.readFile(path.join(dir, 'a.ts'), 'utf8');

    const ws = service();
    await ws.open(dir);
    const result = await ws.replace({ query: 'искомое', replacement: 'x' });

    expect(result.replaced).toBe(0);
    expect(result.files).toEqual([]);
    expect(await fs.readFile(path.join(dir, 'a.ts'), 'utf8')).toBe(before);
  });

  it('зовёт снимок для истории перед каждой записью', async () => {
    const dir = await makeDir();
    await write(dir, 'a.ts', 'foo');
    await write(dir, 'b.ts', 'foo');

    const ws = service();
    await ws.open(dir);
    const shots: string[] = [];
    ws.onBeforeChange = async (file) => {
      shots.push(path.basename(file));
    };

    await ws.replace({ query: 'foo', replacement: 'bar' });
    expect(shots.sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('регулярное выражение с группами подстановки', async () => {
    const dir = await makeDir();
    await write(dir, 'a.ts', 'const x1 = 1;');

    const ws = service();
    await ws.open(dir);
    await ws.replace({ query: 'x(\\d)', replacement: 'y$1', isRegex: true });
    expect(await fs.readFile(path.join(dir, 'a.ts'), 'utf8')).toBe('const y1 = 1;');
  });
});
