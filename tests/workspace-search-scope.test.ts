import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Область поиска и обход дерева.
 *
 * Проверки идут своим обходом, не ripgrep: его в системе может не быть, и
 * тогда единственный работающий путь — этот. Иначе тест тихо проверял бы
 * чужой код (на этом уже спотыкались — см. `search-ripgrep.test.ts`).
 */

const roots: string[] = [];
const services: WorkspaceService[] = [];

beforeEach(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-scope-')));
  roots.push(root);
  const ws = new WorkspaceService(
    () => undefined,
    () => undefined,
  );
  services.push(ws);
  await ws.open(root);

  await fs.mkdir(path.join(root, 'src', 'вложенная'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'пакет'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'иголка\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'b.ts'), 'иголка\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'вложенная', 'c.ts'), 'иголка\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'd.md'), 'иголка\n', 'utf8');
  // Служебная папка: её содержимое в поиск попадать не должно.
  await fs.writeFile(path.join(root, 'node_modules', 'пакет', 'x.ts'), 'иголка\n', 'utf8');
});

afterEach(async () => {
  for (const ws of services.splice(0)) ws.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const root = (): string => roots[roots.length - 1]!;
const ws = (): WorkspaceService => services[services.length - 1]!;
const names = (hits: Array<{ path: string }>): string[] => hits.map((hit) => path.basename(hit.path)).sort();

describe('область поиска', () => {
  it('без пути ищется по всему проекту, служебные папки пропускаются', async () => {
    const result = await ws().search({ query: 'иголка' });
    expect(names(result.hits)).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.md']);
  });

  it('маска меряется от области поиска, а не от корня проекта', async () => {
    // С path=src маска *.ts значит «прямо в src»: вложенная папка не в счёт.
    const result = await ws().search({ query: 'иголка', path: path.join(root(), 'src'), glob: '*.ts' });
    expect(names(result.hits)).toEqual(['a.ts', 'b.ts']);
  });

  it('область — один файл: ищется только он', async () => {
    const result = await ws().search({ query: 'иголка', path: path.join(root(), 'src', 'd.md') });
    expect(names(result.hits)).toEqual(['d.md']);
  });

  it('маска отсекает и один файл, если имя не подходит', async () => {
    // Область уже сужена до файла, но маска про другое расширение.
    const result = await ws().search({ query: 'иголка', path: path.join(root(), 'src', 'd.md'), glob: '*.ts' });
    expect(result.hits).toEqual([]);
  });

  it('сортировка стабильна: внутри файла — по номеру строки', async () => {
    await fs.writeFile(path.join(root(), 'src', 'a.ts'), 'иголка 1\nиголка 2\nиголка 3\n', 'utf8');
    const result = await ws().search({ query: 'иголка', path: path.join(root(), 'src', 'a.ts') });
    expect(result.hits.map((hit) => hit.line)).toEqual([1, 2, 3]);
  });
});

describe('список файлов', () => {
  it('пути относительные, по POSIX-разделителям, отсортированы', async () => {
    const files = await ws().listFiles();
    expect(files).toContain('src/a.ts');
    expect(files).toContain('src/вложенная/c.ts');
    // Служебная папка не попадает и сюда.
    expect(files.some((file) => file.startsWith('node_modules'))).toBe(false);
    // Порядок стабильный: сравниваем с отсортированной копией.
    expect(files).toEqual([...files].sort());
  });
});
