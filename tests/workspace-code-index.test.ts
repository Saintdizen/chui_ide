import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Вопросы по коду всего проекта: структура, экспорты, наследование.
 *
 * Ради чего эти методы существуют: шаблон со скобками ищет независимо от
 * содержимого (иначе это обычный grep), замена пишет только изменённое и
 * спрашивает того, кто следит за диском, а неразобранный язык не выдаёт
 * себя за «ничего не найдено».
 */

const roots: string[] = [];
const services: WorkspaceService[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-index-')));
  roots.push(root);
  return root;
}

function service(): WorkspaceService {
  const ws = new WorkspaceService(() => undefined, {});
  services.push(ws);
  return ws;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  for (const ws of services.splice(0)) ws.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const write = (file: string, text: string): Promise<void> => fs.writeFile(file, text, 'utf8');

describe('поиск по структуре', () => {
  it('$x — дырка: находит независимо от того, что внутри', async () => {
    const root = await makeRoot();
    // Записано по-разному: пробелы и переводы строк для структуры не значат ничего.
    const lines = ['if (ready) { go(); }', '', 'if (done) { go(); }', ''];
    await write(path.join(root, 'a.ts'), lines.join('\n'));
    const ws = service();
    await ws.open(root);

    const result = await ws.findByStructure({ pattern: 'if ($c) { go(); }' });
    expect(result.total).toBe(2);
    expect(result.files.map((file) => path.basename(file.path))).toEqual(['a.ts']);
    // Наружу идёт и число просмотренных: иначе «0 совпадений» не отличить от «не смотрели».
    expect(result.scanned).toBe(1);
  });

  it('пустой шаблон — отказ, а не «найдено всё»', async () => {
    const root = await makeRoot();
    const ws = service();
    await ws.open(root);
    // Разбирать нечего: обещание «ничего не искали» честнее пустого ответа.
    await expect(ws.findByStructure({ pattern: '   ' })).rejects.toThrow(/пуст/i);
  });

  it('маска ограничивает обход', async () => {
    const root = await makeRoot();
    await write(path.join(root, 'a.ts'), 'x();\n');
    await write(path.join(root, 'b.md'), 'x();\n');
    const ws = service();
    await ws.open(root);

    const result = await ws.findByStructure({ pattern: 'x();', glob: '*.ts' });
    expect(result.files.map((file) => path.basename(file.path))).toEqual(['a.ts']);
  });
});

describe('экспорты', () => {
  it('находит объявление по имени и молчит про комментарий с тем же именем', async () => {
    const root = await makeRoot();
    await write(path.join(root, 'a.ts'), ['// export const wanted = 1;', 'export const wanted = 2;', ''].join('\n'));
    const ws = service();
    await ws.open(root);

    const result = await ws.findExports({ name: 'wanted' });
    expect(result.total).toBe(1);
    expect(result.files.map((file) => path.basename(file.path))).toEqual(['a.ts']);
  });

  it('язык, который мы не разбираем, в счёт просмотренных не идёт', async () => {
    const root = await makeRoot();
    // Rust экспортов мы не разбираем: притворяться, что «посмотрели и не нашли», нельзя.
    await write(path.join(root, 'a.rs'), 'pub fn wanted() {}\n');
    await write(path.join(root, 'b.ts'), 'export const wanted = 1;\n');
    const ws = service();
    await ws.open(root);

    const result = await ws.findExports({ name: 'wanted' });
    expect(result.scanned).toBe(1);
    expect(result.files.map((file) => path.basename(file.path))).toEqual(['b.ts']);
  });

  it('пустое имя — отказ', async () => {
    const root = await makeRoot();
    const ws = service();
    await ws.open(root);
    await expect(ws.findExports({ name: '  ' })).rejects.toThrow();
  });
});

describe('наследование', () => {
  it('находит наследника и предка в разные стороны', async () => {
    const root = await makeRoot();
    await write(path.join(root, 'a.ts'), ['class Base {}', 'class Child extends Base {}', ''].join('\n'));
    const ws = service();
    await ws.open(root);

    const subtypes = await ws.findInheritance({ name: 'Base', direction: 'subtypes' });
    expect(subtypes.total).toBe(1);
    expect(subtypes.files).toHaveLength(1);

    const supertypes = await ws.findInheritance({ name: 'Child', direction: 'supertypes' });
    expect(supertypes.total).toBe(1);
  });

  it('без направления ищем наследников', async () => {
    const root = await makeRoot();
    await write(path.join(root, 'a.ts'), ['class Base {}', 'class Child extends Base {}', ''].join('\n'));
    const ws = service();
    await ws.open(root);

    const result = await ws.findInheritance({ name: 'Base' });
    expect(result.direction).toBe('subtypes');
    expect(result.total).toBe(1);
  });

  it('пустое имя — отказ', async () => {
    const root = await makeRoot();
    const ws = service();
    await ws.open(root);
    await expect(ws.findInheritance({ name: '' })).rejects.toThrow();
  });
});

describe('замена по структуре', () => {
  it('пишет только изменённые файлы', async () => {
    const root = await makeRoot();
    const hit = path.join(root, 'hit.ts');
    const miss = path.join(root, 'miss.ts');
    await write(hit, 'log(1);\n');
    await write(miss, 'совсем другое\n');
    const ws = service();
    await ws.open(root);

    const result = await ws.replaceByStructure({ pattern: 'log($a);', replacement: 'print($a);' });
    expect(result.replaced).toBe(1);
    expect(result.files).toEqual([hit]);
    await expect(fs.readFile(hit, 'utf8')).resolves.toBe('print(1);\n');
    // Файл без совпадений не тронут: замена не перезаписывает всё подряд.
    await expect(fs.readFile(miss, 'utf8')).resolves.toBe('совсем другое\n');
  });

  it('перед записью спрашивает того, кто следит за диском', async () => {
    const root = await makeRoot();
    const file = path.join(root, 'a.ts');
    await write(file, 'log(1);\n');
    const ws = service();
    const ask = vi.fn();
    await ws.open(root);
    ws.onBeforeChange = ask;

    await ws.replaceByStructure({ pattern: 'log($a);', replacement: 'print($a);' });
    expect(ask).toHaveBeenCalledWith(file, 'save');
  });
});
