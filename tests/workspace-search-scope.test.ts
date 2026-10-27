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
  const ws = new WorkspaceService(() => undefined, {});
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

/**
 * Потолки поиска. Настоящие (20 000 файлов, 2000 совпадений) в тесте не
 * воспроизвести, поэтому потолок задаётся конструктору. Проверяется главное:
 * урезанный обход помечает результат `truncated`, а не притворяется полным.
 */
describe('потолки поиска', () => {
  async function limited(scanFiles: number): Promise<WorkspaceService> {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-scan-')));
    roots.push(dir);
    const service = new WorkspaceService(() => undefined, { scanFiles });
    services.push(service);
    await service.open(dir);
    for (let i = 0; i < 6; i += 1) {
      await fs.writeFile(path.join(dir, `f${i}.ts`), 'иголка\n', 'utf8');
    }
    return service;
  }

  it('обход упёрся в потолок — truncated, и файлов не больше потолка', async () => {
    const service = await limited(2);

    const result = await service.search({ query: 'иголка' });

    expect(result.truncated).toBe(true);
    expect(new Set(result.hits.map((hit) => hit.path)).size).toBeLessThanOrEqual(2);
  });

  it('потолок не мешает полному результату, когда файлов немного', async () => {
    const service = await limited(100);

    const result = await service.search({ query: 'иголка' });

    expect(result.truncated).toBe(false);
    expect(result.hits).toHaveLength(6);
  });

  it('потолок останавливает и поиск списком файлов', async () => {
    const service = await limited(2);

    const files = await service.findFiles('*.ts');

    expect(files.length).toBeLessThanOrEqual(2);
  });
});

describe('потолок ровно на границе', () => {
  async function exactly(scanFiles: number, count: number): Promise<WorkspaceService> {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-edge-')));
    roots.push(dir);
    const service = new WorkspaceService(() => undefined, { scanFiles });
    services.push(service);
    await service.open(dir);
    for (let i = 0; i < count; i += 1) {
      await fs.writeFile(path.join(dir, `f${i}.ts`), 'иголка\n', 'utf8');
    }
    return service;
  }

  it('файлов ровно столько же, сколько потолок — ни один не потерян', async () => {
    const service = await exactly(3, 3);

    const result = await service.search({ query: 'иголка' });

    // Ни одного файла не потеряно. Флаг при этом честно осторожный: обход
    // остановился РОВНО на потолке и не знает, был ли следующий файл —
    // поэтому `truncated: true` здесь про незнание, а не про потерю.
    expect(result.hits).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('файлов на четверть больше потолка — честный truncated', async () => {
    const service = await exactly(4, 9);

    const result = await service.search({ query: 'иголка' });

    expect(result.truncated).toBe(true);
    expect(result.hits.length).toBeLessThanOrEqual(4);
  });

  it('filesOnly: по одному совпадению на файл и без контекста', async () => {
    // В каждом файле ДВЕ иголки: сводка должна отдать файл один раз.
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-fo-')));
    roots.push(dir);
    const service = new WorkspaceService(() => undefined, {});
    services.push(service);
    await service.open(dir);
    await fs.writeFile(path.join(dir, 'a.ts'), 'иголка\nиголка\n', 'utf8');
    await fs.writeFile(path.join(dir, 'b.ts'), 'иголка\nиголка\n', 'utf8');

    const result = await service.search({ query: 'иголка', filesOnly: true, context: 2 });

    // Файл упомянут один раз, и соседних строк нет: сводка «где встречается»,
    // а не выдержки из текста (хотя `context` запрошен явно).
    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((hit) => path.basename(hit.path)).sort()).toEqual(['a.ts', 'b.ts']);
    for (const hit of result.hits) {
      expect(hit.before).toBeUndefined();
      expect(hit.after).toBeUndefined();
    }
  });
});
