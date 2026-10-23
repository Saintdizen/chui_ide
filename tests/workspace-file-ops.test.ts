import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Правки на диске: создать, переименовать, скопировать.
 *
 * Общее правило у всех трёх: существующее не перетираем. Молча затереть
 * чужой файл дороже, чем показать отказ — на этом стоит каждая проверка.
 */

const roots: string[] = [];
const services: WorkspaceService[] = [];
const events: Array<{ topic: string; payload: unknown }> = [];

async function makeRoot(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-ops-')));
  roots.push(root);
  return root;
}

function service(): WorkspaceService {
  const ws = new WorkspaceService((topic, payload) => events.push({ topic, payload }));
  services.push(ws);
  return ws;
}

/** Дожидаемся склеенного уведомления об изменении (задержка 120 мс). */
async function changes(): Promise<string[]> {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return events.map((event) => JSON.stringify(event.payload));
}

beforeEach(() => {
  events.length = 0;
});

afterEach(async () => {
  for (const ws of services.splice(0)) ws.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('создание файла', () => {
  it('существующий не перетирает, а отказывает', async () => {
    const root = await makeRoot();
    const file = path.join(root, 'a.ts');
    await fs.writeFile(file, 'важное\n', 'utf8');
    const ws = service();
    await ws.open(root);

    await expect(ws.createFile(file, 'новое\n')).rejects.toThrow(/уже существует/i);
    // Содержимое цело: ради этого отказ и сделан.
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('важное\n');
  });

  it('создаёт папки по пути и отдаёт абсолютный путь', async () => {
    const root = await makeRoot();
    const ws = service();
    await ws.open(root);

    const created = await ws.createFile(path.join(root, 'новая', 'вложенная', 'a.ts'), 'x\n');
    expect(created).toBe(path.join(root, 'новая', 'вложенная', 'a.ts'));
    await expect(fs.readFile(created, 'utf8')).resolves.toBe('x\n');
  });
});

describe('переименование', () => {
  it('носит содержимое, а не создаёт пустой файл', async () => {
    const root = await makeRoot();
    await fs.writeFile(path.join(root, 'a.ts'), 'тело\n', 'utf8');
    const ws = service();
    await ws.open(root);

    await ws.rename(path.join(root, 'a.ts'), path.join(root, 'b.ts'));
    await expect(fs.readFile(path.join(root, 'b.ts'), 'utf8')).resolves.toBe('тело\n');
    await fs.stat(path.join(root, 'a.ts')).then(
      () => expect('файл остался').toBe('его не должно быть'),
      () => undefined,
    );
  });

  it('на занятое имя не переименовывает', async () => {
    const root = await makeRoot();
    await fs.writeFile(path.join(root, 'a.ts'), 'a\n', 'utf8');
    await fs.writeFile(path.join(root, 'b.ts'), 'b\n', 'utf8');
    const ws = service();
    await ws.open(root);

    await expect(ws.rename(path.join(root, 'a.ts'), path.join(root, 'b.ts'))).rejects.toThrow(/уже существует/i);
    // Оба файла на месте с прежним содержимым — ни один не пострадал.
    await expect(fs.readFile(path.join(root, 'a.ts'), 'utf8')).resolves.toBe('a\n');
    await expect(fs.readFile(path.join(root, 'b.ts'), 'utf8')).resolves.toBe('b\n');
  });

  it('о переезде говорит новое имя', async () => {
    const root = await makeRoot();
    await fs.writeFile(path.join(root, 'a.ts'), 'x\n', 'utf8');
    const ws = service();
    await ws.open(root);

    await ws.rename(path.join(root, 'a.ts'), path.join(root, 'z.ts'));
    const seen = await changes();
    // Дереву нужно убрать старое имя и добавить новое: одного мало.
    expect(seen.some((item) => item.includes('z.ts'))).toBe(true);
  });
});

describe('копия', () => {
  it('копирует папку целиком', async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, 'папка'));
    await fs.writeFile(path.join(root, 'папка', 'a.ts'), 'x\n', 'utf8');
    const ws = service();
    await ws.open(root);

    await ws.copy(path.join(root, 'папка'), path.join(root, 'копия'));
    await expect(fs.readFile(path.join(root, 'копия', 'a.ts'), 'utf8')).resolves.toBe('x\n');
  });

  it('в занятое место не копирует', async () => {
    const root = await makeRoot();
    await fs.writeFile(path.join(root, 'a.ts'), 'источник\n', 'utf8');
    await fs.writeFile(path.join(root, 'b.ts'), 'жертва\n', 'utf8');
    const ws = service();
    await ws.open(root);

    await expect(ws.copy(path.join(root, 'a.ts'), path.join(root, 'b.ts'))).rejects.toThrow(/уже существует/i);
    // Копия не стирает то, что уже лежит в целевой папке.
    await expect(fs.readFile(path.join(root, 'b.ts'), 'utf8')).resolves.toBe('жертва\n');
  });

  it('вне проекта не копирует', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await fs.writeFile(path.join(root, 'a.ts'), 'x\n', 'utf8');
    const ws = service();
    await ws.open(root);

    await expect(ws.copy(path.join(root, 'a.ts'), path.join(outside, 'a.ts'))).rejects.toThrow();
    await fs.stat(path.join(outside, 'a.ts')).then(
      () => expect('скопировалось').toBe('не должно'),
      () => undefined,
    );
  });
});
