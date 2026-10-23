import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Обвязка рабочей области: корни, разрешения на чтение и сброс кэшей.
 *
 * Здесь проверяются не поиски и правки, а состояние между ними — то, что
 * остаётся в памяти сервиса: какие папки открыты, что из них можно читать,
 * чьи правила исключения считать. Ошибки тут тихие: кэш отдаст старое
 * содержимое, чтение откажет по чужому пути — и ни одна строка не упадёт.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-ws4-')));
  roots.push(dir);
  return dir;
}

async function write(dir: string, relative: string, text: string): Promise<void> {
  const full = path.join(dir, ...relative.split('/'));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text, 'utf8');
}

function service(): WorkspaceService {
  return new WorkspaceService(
    () => undefined,
    () => undefined,
  );
}

describe('корни рабочей области', () => {
  it('open отказывает по несуществующей папке, называя путь', async () => {
    const missing = path.join(await makeDir(), 'нет-такой');
    await expect(service().open(missing)).rejects.toThrow(missing);
  });

  it('open отказывает по файлу: корень — это папка, а не что угодно', async () => {
    const dir = await makeDir();
    await write(dir, 'a.txt', 'x\n');
    await expect(service().open(path.join(dir, 'a.txt'))).rejects.toThrow(/не найдена/i);
  });

  it('второй корень добавляется рядом, а не заменяет первый', async () => {
    const first = await makeDir();
    const second = await makeDir();
    const ws = service();
    await ws.open(first);
    await ws.addRoot(second);

    const listed = ws.rootList().map((root) => path.resolve(root.path ?? root.root ?? String(root)));
    expect(listed).toContain(path.resolve(first));
    expect(listed).toContain(path.resolve(second));
  });

  it('повторный addRoot того же корня не плодит дубль', async () => {
    const dir = await makeDir();
    const ws = service();
    await ws.open(dir);
    await ws.addRoot(dir);
    // Корень в списке ровно один: дубль сломал бы выбор активного.
    const built = ws.rootList();
    expect(
      built.filter((root) => path.resolve(root.path ?? root.root ?? String(root)) === path.resolve(dir)),
    ).toHaveLength(1);
  });

  it('setActiveRoot переключает корень, а чужой путь — отказ', async () => {
    const first = await makeDir();
    const second = await makeDir();
    const ws = service();
    await ws.open(first);
    await ws.addRoot(second);

    const info = await ws.setActiveRoot(second);
    expect(path.resolve(info.root)).toBe(path.resolve(second));
    expect(ws.rootPath()).toBe(path.resolve(second));

    await expect(ws.setActiveRoot(path.join(first, 'нет-такой'))).rejects.toThrow(/не в рабочей области/i);
  });
});

describe('разрешения на чтение', () => {
  it('по умолчанию путь вне проекта читать нельзя', async () => {
    const root = await makeDir();
    const outside = await makeDir();
    await write(outside, 'secret.txt', 'секрет\n');
    const ws = service();
    await ws.open(root);

    await expect(ws.readFile(path.join(outside, 'secret.txt'))).rejects.toThrow();
  });

  it('allowReadDir открывает чтение из конкретной папки — и только из неё', async () => {
    const root = await makeDir();
    const allowed = await makeDir();
    const other = await makeDir();
    await write(allowed, 'spill.txt', 'длинный вывод\n');
    await write(other, 'other.txt', 'чужое\n');
    const ws = service();
    await ws.open(root);
    ws.allowReadDir(allowed);

    const content = await ws.readFile(path.join(allowed, 'spill.txt'));
    expect(content.text).toContain('длинный вывод');
    // Соседняя папка не стала доступной заодно.
    await expect(ws.readFile(path.join(other, 'other.txt'))).rejects.toThrow();
  });

  it('allowReadDir не даёт ПИСАТЬ в разрешённую папку', async () => {
    const root = await makeDir();
    const allowed = await makeDir();
    await write(allowed, 'spill.txt', 'x\n');
    const ws = service();
    await ws.open(root);
    ws.allowReadDir(allowed);

    // Копию вывода читать можно, а править её — нет.
    await expect(ws.writeFile(path.join(allowed, 'spill.txt'), 'испорчено', {})).rejects.toThrow();
    expect(await fs.readFile(path.join(allowed, 'spill.txt'), 'utf8')).toBe('x\n');
  });

  it('setDependencyDirs открывает чтение исходников зависимости', async () => {
    const root = await makeDir();
    const deps = await makeDir();
    await write(deps, 'lib/index.js', 'module.exports = 1;\n');
    const ws = service();
    await ws.open(root);
    ws.setDependencyDirs([deps]);

    const content = await ws.readFile(path.join(deps, 'lib/index.js'));
    expect(content.text).toContain('module.exports');
  });

  it('смена набора зависимостей сбрасывает кэш содержимого', async () => {
    const root = await makeDir();
    const depsA = await makeDir();
    const depsB = await makeDir();
    await write(root, 'a.txt', 'нужно найти\n');
    const ws = service();
    await ws.open(root);

    // Кэш наполняется обходом каталога при поиске, а не чтением файла.
    await ws.search({ query: 'найти' });
    const warmed = ws.cacheStats();
    expect(warmed.entries).toBeGreaterThan(0);

    // Тот же набор — записи на месте (лишнего сброса нет).
    ws.setDependencyDirs([depsA]);
    ws.setDependencyDirs([depsA]);
    await ws.search({ query: 'найти' });
    expect(ws.cacheStats().entries).toBe(warmed.entries);

    // Другой набор — кэш пуст: старые пути могли перестать быть видны.
    ws.setDependencyDirs([depsB]);
    expect(ws.cacheStats().entries).toBe(0);
  });
});

describe('close и правила исключения', () => {
  it('правила исключения считаются по активному корню', async () => {
    const first = await makeDir();
    const second = await makeDir();
    await write(first, '.gitignore', 'a\nb\n');
    await write(second, '.gitignore', 'x\n');
    const ws = service();
    await ws.open(first);
    expect(ws.ignoreRuleCount()).toBe(2);

    await ws.addRoot(second);
    await ws.setActiveRoot(second);
    expect(ws.ignoreRuleCount()).toBe(1);
  });

  it('после close рабочей области нет и читать нечего', async () => {
    const dir = await makeDir();
    await write(dir, 'a.txt', 'x\n');
    const ws = service();
    await ws.open(dir);
    ws.close();

    expect(ws.rootPath()).toBeNull();
    expect(ws.rootList()).toEqual([]);
    expect(ws.ignoreRuleCount()).toBe(0);
    await expect(ws.readFile(path.join(dir, 'a.txt'))).rejects.toThrow();
  });
});
