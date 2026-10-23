import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Файлы и ссылки, исчезающие между шагами обхода.
 *
 * Гонка настоящая: `readdir` увидел запись, а `stat`/`readFile` по ней уже
 * упали — файл удалили соседним процессом (сборка, git checkout, чистящий
 * скрипт). Требовать такого по требованию нельзя, поэтому исчезновение
 * устроено детерминированно: запись исчезает ПОСЛЕ того, как каталог увидят,
 * но ДО того, как сервису выпадет шанс её прочитать — через имя, которое
 * `readdir` находит, а `stat` уже нет.
 *
 * Дорога ошибки тут односторонняя: уронив поиск или список из-за одного
 * пропавшего файла, сервис наказывает человека за чужую гонку.
 */

const roots: string[] = [];
const services: WorkspaceService[] = [];

beforeEach(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-vanish-')));
  roots.push(root);
  const ws = new WorkspaceService(
    () => undefined,
    () => undefined,
  );
  services.push(ws);
  await ws.open(root);
});

afterEach(async () => {
  for (const ws of services.splice(0)) ws.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** Корень текущего теста. */
const root = (): string => roots[roots.length - 1]!;
const ws = (): WorkspaceService => services[services.length - 1]!;

describe('запись исчезла между обходом и чтением', () => {
  it('битая ссылка не роняет список каталога: видна, помечена сломанной', async () => {
    // Ссылка в никуда: stat упадёт, readlink — нет.
    await fs.symlink(path.join(root(), 'нет-такого'), path.join(root(), 'broken.ts'));

    const entries = await ws().readDir(root());
    const broken = entries.find((entry) => entry.name === 'broken.ts');
    expect(broken).toBeDefined();
    expect(broken?.symlink?.broken).toBe(true);
    // Цель показана как есть: человек должен видеть, куда вела ссылка.
    expect(broken?.symlink?.target).toBe(path.join(root(), 'нет-такого'));
  });

  it('удалённый симлинк в списке тоже не роняет обход', async () => {
    // Сама ссылка исчезает: упадёт и stat, и readlink.
    const target = path.join(root(), 'real.ts');
    await fs.writeFile(target, 'x\n', 'utf8');
    const link = path.join(root(), 'gone.ts');
    await fs.symlink(target, link);
    await fs.symlink(target, path.join(root(), 'sibling.ts'));

    // Список читаем ДО удаления — запись попадёт в dirent.
    const listing = ws().readDir(root());
    await fs.unlink(link);

    // Гонки нет по построению, но проверяем важное: следующий список не падает.
    await expect(listing).resolves.toBeTruthy();
    await expect(ws().readDir(root())).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'real.ts' })]),
    );
  });

  it('битая ссылка в поиске не роняет весь поиск', async () => {
    await fs.writeFile(path.join(root(), 'ok.ts'), 'нужная строка\n', 'utf8');
    await fs.symlink(path.join(root(), 'нет'), path.join(root(), 'dangling.ts'));

    const result = await ws().search({ query: 'нужная строка' });
    // Файл рядом найден — пропавшая ссылка не должна стоить всего результата.
    expect(result.hits.some((hit) => hit.path.endsWith('ok.ts'))).toBe(true);
  });

  it('чтение битой ссылки — внятный отказ, а не падение', async () => {
    await fs.symlink(path.join(root(), 'нет'), path.join(root(), 'dangling.ts'));
    await expect(ws().readFile(path.join(root(), 'dangling.ts'))).rejects.toThrow();
  });

  it('слишком большой файл в списке показан с настоящим размером', async () => {
    // Размер берётся из stat: обрезать имя файла размера не скрывает.
    const big = path.join(root(), 'big.bin');
    await fs.writeFile(big, Buffer.alloc(4096, 7));

    const entries = await ws().readDir(root());
    const entry = entries.find((item) => item.name === 'big.bin');
    expect(entry?.size).toBe(4096);
  });

  it('каталог исчез целиком — внятный отказ, а не пустой список', async () => {
    const sub = path.join(root(), 'подпапка');
    await fs.mkdir(sub);
    await fs.rm(sub, { recursive: true, force: true });

    // Пустой список соврал бы: «здесь ничего нет» вместо «папки больше нет».
    await expect(ws().readDir(sub)).rejects.toThrow(/не удалось прочитать/i);
  });
});
