import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../src/main/workspace/workspace';
import { MAX_OPEN_BYTES } from '../src/shared/large-file';
import { MAX_VIEW_OFFICE_BYTES } from '../src/shared/office';

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

/**
 * Отказы на границах файловых операций. Проверяется не чистая функция
 * (`withinOpenLimit`, `officeRefusal` покрыты в своих тестах), а то, что СЕРВИС
 * доводит их до человека: файл на диске какого-то размера превращается в
 * внятный отказ, а не в зависший рендерер.
 */
describe('пределы при открытии', () => {
  it('stat: файла нет — NotFound, а не пустые метаданные', async () => {
    const root = await makeRoot();
    const ws = service();
    await ws.open(root);

    await expect(ws.stat(path.join(root, 'нет.ts'))).rejects.toThrow(/не найден/);
  });

  it('stat различает папку, файл и размер', async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, 'dir'));
    await fs.writeFile(path.join(root, 'a.ts'), 'привет', 'utf8');
    const ws = service();
    await ws.open(root);

    expect((await ws.stat(path.join(root, 'dir'))).kind).toBe('directory');
    const file = await ws.stat(path.join(root, 'a.ts'));
    expect(file.kind).toBe('file');
    expect(file.size).toBe(Buffer.byteLength('привет'));
  });

  it('файл больше предела редактора — отказ до чтения', async () => {
    const root = await makeRoot();
    // Размер важнее содержимого: файл «раздут» одним вызовом, без гигабайта текста.
    const big = path.join(root, 'big.log');
    await fs.writeFile(big, '', 'utf8');
    await fs.truncate(big, MAX_OPEN_BYTES + 1);
    const ws = service();
    await ws.open(root);

    await expect(ws.readFile(big)).rejects.toThrow(/больше предела/);
  });

  it('файл ровно в предел — открывается', async () => {
    const root = await makeRoot();
    const ok = path.join(root, 'ok.log');
    await fs.writeFile(ok, '', 'utf8');
    await fs.truncate(ok, MAX_OPEN_BYTES);
    const ws = service();
    await ws.open(root);

    // Граница ВКЛЮЧАЮЩАЯ: ровно предел — ещё открываем. Содержимое здесь нули
    // (файл раздут `truncate`), важен сам факт чтения, а не текст.
    const content = await ws.readFile(ok);
    expect(content.text).toHaveLength(MAX_OPEN_BYTES);
  });

  it('предпросмотр офиса: не тот формат — отказ с именем файла', async () => {
    const root = await makeRoot();
    await fs.writeFile(path.join(root, 'a.ts'), 'x', 'utf8');
    const ws = service();
    await ws.open(root);

    await expect(ws.readOffice(path.join(root, 'a.ts'))).rejects.toThrow(/a\.ts/);
  });

  it('предпросмотр офиса: файла нет — NotFound', async () => {
    const root = await makeRoot();
    const ws = service();
    await ws.open(root);

    await expect(ws.readOffice(path.join(root, 'нет.docx'))).rejects.toThrow(/не найден/);
  });

  it('предпросмотр офиса: слишком большой документ — отказ по размеру', async () => {
    const root = await makeRoot();
    const big = path.join(root, 'big.docx');
    await fs.writeFile(big, '', 'utf8');
    await fs.truncate(big, MAX_VIEW_OFFICE_BYTES + 1);
    const ws = service();
    await ws.open(root);

    await expect(ws.readOffice(big)).rejects.toThrow(/предела предпросмотра/);
  });
});

describe('создание папки', () => {
  it('вложенная папка создаётся вместе с недостающими родителями', async () => {
    const root = await makeRoot();
    const ws = service();
    await ws.open(root);

    const dir = await ws.createDir(path.join(root, 'a/b/c'));

    expect(dir).toBe(path.join(root, 'a/b/c'));
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });

  it('существующая папка — не ошибка, но и не новая папка', async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, 'есть'));
    const ws = service();
    await ws.open(root);

    const dir = await ws.createDir(path.join(root, 'есть'));

    expect(dir).toBe(path.join(root, 'есть'));
  });

  it('создание папки вне корня — отказ', async () => {
    const root = await makeRoot();
    const ws = service();
    await ws.open(root);

    await expect(ws.createDir('/tmp/чужое-место')).rejects.toThrow(/вне рабочей папки/i);
  });
});
