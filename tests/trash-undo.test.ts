import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_BYTES, MAX_ENTRIES, TrashUndo } from '../src/main/workspace/trash-undo';

/**
 * Возврат удалённого файла.
 *
 * Проверяем на настоящей файловой системе: смысл здесь в том, что копия
 * действительно лежит на диске и действительно возвращается на место.
 */
let root = '';
let store: TrashUndo;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-trash-'));
  store = new TrashUndo(() => path.join(root, 'undo'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function makeFile(name: string, content = 'содержимое'): Promise<string> {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
  return file;
}

describe('копия перед корзиной', () => {
  it('файл возвращается на прежнее место с прежним содержимым', async () => {
    const file = await makeFile('src/a.ts', 'export const a = 1;');
    const undo = await store.keep(file);
    expect(undo).not.toBeNull();

    // Удаление в корзину имитируем: файла больше нет.
    await fs.rm(file);

    await expect(store.restore(undo!)).resolves.toBe(file);
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('export const a = 1;');
  });

  it('папку не копируем — ручки возврата нет', async () => {
    const dir = path.join(root, 'folder');
    await fs.mkdir(dir);
    expect(await store.keep(dir)).toBeNull();
  });

  it('большой файл не копируем: возврат не должен стоить дороже потери', async () => {
    const file = await makeFile('big.bin', 'x'.repeat(MAX_BYTES + 1));
    expect(await store.keep(file)).toBeNull();
  });

  it('несуществующий файл — молчание, а не падение', async () => {
    expect(await store.keep(path.join(root, 'нет.ts'))).toBeNull();
  });
});

describe('возврат', () => {
  it('вернуть можно только один раз: копия живёт до возврата', async () => {
    const file = await makeFile('a.ts');
    const undo = await store.keep(file);
    await fs.rm(file);

    expect(await store.restore(undo!)).toBe(file);
    expect(await store.restore(undo!)).toBeNull();
  });

  it('чужой id — null, а не исключение', async () => {
    expect(await store.restore('нет-такого')).toBeNull();
    expect(await store.has('../../etc')).toBe(false);
  });

  it('родительскую папку вернувшийся файл создаёт сам', async () => {
    const file = await makeFile('deep/nested/a.ts');
    const undo = await store.keep(file);
    await fs.rm(path.join(root, 'deep'), { recursive: true });

    await store.restore(undo!);
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('содержимое');
  });
});

describe('хранилище не растёт', () => {
  it('помнит не больше MAX_ENTRIES удалений', async () => {
    const ids: string[] = [];
    for (let index = 0; index < MAX_ENTRIES + 3; index += 1) {
      const file = await makeFile(`f${index}.ts`, String(index));
      ids.push((await store.keep(file))!);
    }
    const alive = await Promise.all(ids.map((id) => store.has(id)));
    expect(alive.filter(Boolean)).toHaveLength(MAX_ENTRIES);
    // Вытесняются старые, а не свежие: последняя запись обязана вернуться.
    expect(await store.has(ids[ids.length - 1]!)).toBe(true);
    expect(await store.has(ids[0]!)).toBe(false);
  });

  it('осиротевшая папка без meta убирается при следующей записи', async () => {
    const orphan = path.join(root, 'undo', 'broken');
    await fs.mkdir(orphan, { recursive: true });
    await store.keep(await makeFile('a.ts'));
    await expect(fs.stat(orphan)).rejects.toThrow();
  });
});

/**
 * П.8: «Отмена — одна кнопка, а не диалог».
 *
 * `git restore` уничтожает правку без следа, поэтому кнопка «Отменить» честна
 * только тогда, когда текст файла уже снят ДО отката. Снимок живёт в том же
 * хранилище, что и удалённое, но в своей подпапке.
 */
describe('снимок перед откатом правок', () => {
  let restore: TrashUndo;

  beforeEach(() => {
    restore = new TrashUndo(() => path.join(root, 'undo'), 'restore');
  });

  it('снимок возвращает ровно те байты, что были до отката', async () => {
    const file = await makeFile('src/a.ts', 'до отката');
    const undo = await restore.snapshot(file);
    expect(undo).not.toBeNull();

    // `git restore` переписал файл.
    await fs.writeFile(file, 'после отката', 'utf8');

    await expect(restore.restoreContent(undo!)).resolves.toBe(file);
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('до отката');
  });

  it('снимок не удаляет оригинал: откат делает git, а не мы', async () => {
    const file = await makeFile('src/b.ts');
    await restore.snapshot(file);
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('содержимое');
  });

  // Удаление и откат не должны вытеснять друг друга: это разные истории.
  it('откаты и удалённое лежат в разных папках', async () => {
    const file = await makeFile('src/c.ts');
    const trash = await store.keep(file);
    const undiscard = await restore.snapshot(file);

    await expect(store.restoreContent(undiscard!)).resolves.toBeNull();
    expect(trash).not.toBe(undiscard);
  });

  it('папку и слишком большой файл не снимаем — ручки нет', async () => {
    await fs.mkdir(path.join(root, 'dir'));
    expect(await restore.snapshot(path.join(root, 'dir'))).toBeNull();
    const big = await makeFile('big2.bin', 'x'.repeat(MAX_BYTES + 1));
    expect(await restore.snapshot(big)).toBeNull();
  });
});
