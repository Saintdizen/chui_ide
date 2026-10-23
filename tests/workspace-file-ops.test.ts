import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Файловые операции рабочей области: создать, переименовать, скопировать, убрать.
 *
 * Всё это — единственные пути, которыми IDE правит диск за спиной редактора.
 * Здесь важно не только «сработало», а что происходит при СТОЛКНОВЕНИИ: чужой файл
 * на месте цели не затирается, корень проекта не убирается в корзину, а
 * переименование не оставляет содержимое в кэше поиска под старым путём.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-ws-ops-')));
  roots.push(base);
  return base;
}

interface Changes {
  topics: string[];
  payloads: unknown[];
}

/** Уведомления дереву складываются в батч на 120 мс — ждём, иначе видим пустоту. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

function service(changes?: Changes): WorkspaceService {
  return new WorkspaceService(
    (topic: string, payload: unknown) => {
      changes?.topics.push(topic);
      changes?.payloads.push(payload);
    },
    () => undefined,
  );
}

describe('workspace: файловые операции', () => {
  it('createFile(): создаёт с содержимым и говорит дереву об изменении', async () => {
    const dir = await makeDir();
    const changes: Changes = { topics: [], payloads: [] };
    const ws = service(changes);
    await ws.open(dir);

    const file = await ws.createFile(path.join(dir, 'new.ts'), 'const a = 1;\n');
    expect(await fs.readFile(file, 'utf8')).toBe('const a = 1;\n');
    await settle();
    expect(changes.topics.length).toBeGreaterThan(0);
  });

  it('createFile(): существующий НЕ перетирается, а честно отказывает', async () => {
    const dir = await makeDir();
    const ws = service();
    await ws.open(dir);
    await fs.writeFile(path.join(dir, 'old.ts'), 'чужое\n');

    await expect(ws.createFile(path.join(dir, 'old.ts'), 'моё\n')).rejects.toThrow(/существует/i);
    // Содержимое на диске не тронуто — ради этого и стоит `flag: 'wx'`.
    expect(await fs.readFile(path.join(dir, 'old.ts'), 'utf8')).toBe('чужое\n');
  });

  it('createFile(): вложенная папка создаётся по пути файла', async () => {
    const dir = await makeDir();
    const ws = service();
    await ws.open(dir);
    const file = await ws.createFile(path.join(dir, 'a/b/c.ts'), 'x');
    expect(await fs.readFile(file, 'utf8')).toBe('x');
  });

  it('rename(): занятое имя — отказ, оба файла на месте', async () => {
    const dir = await makeDir();
    const ws = service();
    await ws.open(dir);
    await fs.writeFile(path.join(dir, 'a.ts'), 'A');
    await fs.writeFile(path.join(dir, 'b.ts'), 'B');

    await expect(ws.rename(path.join(dir, 'a.ts'), path.join(dir, 'b.ts'))).rejects.toThrow(/существует/i);
    expect(await fs.readFile(path.join(dir, 'a.ts'), 'utf8')).toBe('A');
    expect(await fs.readFile(path.join(dir, 'b.ts'), 'utf8')).toBe('B');
  });

  it('rename(): свободное имя — содержимое уехало, старое исчезло', async () => {
    const dir = await makeDir();
    const changes: Changes = { topics: [], payloads: [] };
    const ws = service(changes);
    await ws.open(dir);
    await fs.writeFile(path.join(dir, 'a.ts'), 'A');
    const moved = await ws.rename(path.join(dir, 'a.ts'), path.join(dir, 'c.ts'));

    expect(moved).toBe(path.join(dir, 'c.ts'));
    expect(await fs.readFile(moved, 'utf8')).toBe('A');
    await expect(fs.stat(path.join(dir, 'a.ts'))).rejects.toThrow();
    // Дерево должно услышать и про старое имя — иначе в нём останется призрак.
    await settle();
    expect(changes.topics.length).toBeGreaterThanOrEqual(1);
  });

  it('copy(): папка копируется целиком, цель с содержимым не трогаем', async () => {
    const dir = await makeDir();
    const ws = service();
    await ws.open(dir);
    await fs.mkdir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src/one.ts'), '1');

    await ws.copy(path.join(dir, 'src'), path.join(dir, 'copy'));
    expect(await fs.readFile(path.join(dir, 'copy/one.ts'), 'utf8')).toBe('1');

    await expect(ws.copy(path.join(dir, 'src'), path.join(dir, 'copy'))).rejects.toThrow(/существует/i);
  });

  it('trash(): корень проекта в корзину не уходит', async () => {
    const dir = await makeDir();
    const ws = service();
    await ws.open(dir);
    await expect(ws.trash(dir)).rejects.toThrow(/Корень проекта/i);
  });

  it('writeFile(): зовёт снимок для истории ДО записи', async () => {
    const dir = await makeDir();
    const ws = service();
    await ws.open(dir);
    await fs.writeFile(path.join(dir, 'a.ts'), 'старое');

    const seen: { file: string; reason: string; onDisk: string }[] = [];
    ws.onBeforeChange = async (file, reason) => {
      // В момент снимка на диске ещё СТАРОЕ — иначе спасать было бы нечего.
      seen.push({ file, reason, onDisk: await fs.readFile(file, 'utf8') });
    };

    await ws.writeFile(path.join(dir, 'a.ts'), 'новое');
    expect(seen).toHaveLength(1);
    expect(seen[0].reason).toBe('save');
    expect(seen[0].onDisk).toBe('старое');
    expect(await fs.readFile(path.join(dir, 'a.ts'), 'utf8')).toBe('новое');
  });
});

describe('workspace: чтение файлов', () => {
  it('read(): отдаёт текст, а CRLF приводит к \\n', async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, 'a.ts'), 'a\r\nb\r\n');
    const ws = service();
    await ws.open(dir);
    const doc = await ws.readFile(path.join(dir, 'a.ts'));
    // Одна модель документа: иначе позиции правок разойдутся с моделью.
    expect(doc.text).toBe('a\nb\n');
    expect(doc.readOnly).toBe(false);
  });

  it('read(): отсутствующий файл — NotFound, а не пустая строка', async () => {
    const dir = await makeDir();
    const ws = service();
    await ws.open(dir);
    await expect(ws.readFile(path.join(dir, 'nope.ts'))).rejects.toThrow(/не найден/i);
  });

  it('readImage(): обычный файл не считается картинкой', async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, 'a.ts'), 'x');
    const ws = service();
    await ws.open(dir);
    await expect(ws.readImage(path.join(dir, 'a.ts'))).rejects.toThrow(/Не изображение/i);
  });

  it('readImage(): png отдаётся data-URL с верным mime', async () => {
    const dir = await makeDir();
    // Минимальный валидный PNG-заголовок: важен не рисунок, а mime и data-URL.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await fs.writeFile(path.join(dir, 'shot.png'), png);
    const ws = service();
    await ws.open(dir);
    const image = await ws.readImage(path.join(dir, 'shot.png'));
    expect(image.mime).toBe('image/png');
    expect(image.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(image.bytes).toBe(png.byteLength);
  });

  it('readOffice(): не-docx отказ, а не попытка разобрать', async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, 'a.txt'), 'x');
    const ws = service();
    await ws.open(dir);
    await expect(ws.readOffice(path.join(dir, 'a.txt'))).rejects.toThrow(/docx|xlsx/i);
  });

  it('stat(): различает файл, каталог и отсутствующий путь', async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, 'a.ts'), 'abc');
    const ws = service();
    await ws.open(dir);
    expect((await ws.stat(path.join(dir, 'a.ts'))).kind).toBe('file');
    expect((await ws.stat(dir)).kind).toBe('directory');
    await expect(ws.stat(path.join(dir, 'gone.ts'))).rejects.toThrow(/не найден/i);
  });
});

describe('workspace: путь вне области', () => {
  it('запись наружу запрещена, а не «просто не сработала»', async () => {
    const dir = await makeDir();
    const outside = await makeDir();
    const ws = service();
    await ws.open(dir);
    await expect(ws.writeFile(path.join(outside, 'x.ts'), 'плохо')).rejects.toThrow();
    await expect(fs.stat(path.join(outside, 'x.ts'))).rejects.toThrow();
  });

  it('createDir(): каталог создаётся, и файл в нём виден обходу', async () => {
    const dir = await makeDir();
    const ws = service();
    await ws.open(dir);
    const made = await ws.createDir(path.join(dir, 'sub'));
    expect((await fs.stat(made)).isDirectory()).toBe(true);
    await fs.writeFile(path.join(made, 'a.ts'), 'x');
    // listFiles отдаёт только ФАЙЛЫ и пути ОТНОСИТЕЛЬНЫЕ корню, а не каталоги.
    // trash сюда не годится: он зовёт shell.trashItem из Electron, а не fs.
    expect(await ws.listFiles()).toContain('sub/a.ts');
  });
});
