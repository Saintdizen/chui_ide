import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Поиск: контекст, потолки строк, бинарные файлы.
 *
 * Контекст отдаётся БЕЗ trim — отступы в коде значимы, по ним видно, к какому
 * блоку относится совпадение. Но длину строки всё равно режем: файл с одной
 * строкой в килобайты не должен раздувать ответ инструмента.
 */

const roots: string[] = [];
const services: WorkspaceService[] = [];

afterEach(async () => {
  for (const ws of services.splice(0)) ws.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-ws8-')));
  roots.push(dir);
  return dir;
}

async function write(dir: string, relative: string, text: string): Promise<void> {
  const full = path.join(dir, ...relative.split('/'));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text, 'utf8');
}

async function open(): Promise<{ ws: WorkspaceService; root: string }> {
  const root = await makeDir();
  const ws = new WorkspaceService(() => undefined, {});
  services.push(ws);
  await ws.open(root);
  return { ws, root };
}

describe('поиск: контекст', () => {
  it('контекст отдаёт соседние строки с сохранёнными отступами', async () => {
    const { ws, root } = await open();
    const lines = ['function f() {', '  const guard = 1;', '  if (x) { needle(); }', '  return 2;', '}'];
    await write(root, 'a.ts', lines.join('\n'));

    const result = await ws.search({ query: 'needle', context: 1 });
    const hit = result.hits[0]!;

    // Отступы сохранены: по ним видно, что вызов внутри if.
    expect(hit.before).toEqual(['  const guard = 1;']);
    expect(hit.after).toEqual(['  return 2;']);
  });

  it('контекст на первой строке не уходит в отрицательный срез', async () => {
    const { ws, root } = await open();
    await write(root, 'a.ts', ['needle();', 'второй;', 'третий;'].join('\n'));

    const result = await ws.search({ query: 'needle', context: 3 });
    const hit = result.hits[0]!;

    // Без Math.max(0, …) срез взял бы строки с конца файла.
    expect(hit.before).toEqual([]);
    expect(hit.after).toEqual(['второй;', 'третий;']);
  });

  it('длинная строка контекста обрезается тем же потолком, что и совпадение', async () => {
    const { ws, root } = await open();
    const long = 'x'.repeat(5000);
    await write(root, 'a.ts', [long, 'needle();', long].join('\n'));

    const result = await ws.search({ query: 'needle', context: 1 });
    const hit = result.hits[0]!;

    // Потолок 400 символов + многоточие: ответ инструмента не раздувается.
    expect(hit.before![0]!.length).toBeLessThanOrEqual(401);
    expect(hit.after![0]!.length).toBeLessThanOrEqual(401);
  });

  it('CRLF в контексте не оставляет хвостового возврата каретки', async () => {
    const { ws, root } = await open();
    await write(root, 'a.ts', ['первый;', 'needle();', 'третий;'].join('\r\n'));

    const result = await ws.search({ query: 'needle', context: 1 });
    const hit = result.hits[0]!;

    expect(hit.before).toEqual(['первый;']);
    expect(hit.after).toEqual(['третий;']);
  });
});

describe('поиск: что не читается', () => {
  it('бинарный файл в результаты не попадает', async () => {
    const { ws, root } = await open();
    // Нулевой байт — признак бинарника; слово «needle» в нём есть.
    const bytes = [0, 1, 2, ...Buffer.from('needle'), 0];
    await fs.writeFile(path.join(root, 'bin.dat'), Buffer.from(bytes));
    await write(root, 'text.ts', 'const needle = 1;\n');

    const result = await ws.search({ query: 'needle' });

    // Иначе агент получил бы байты как «строки кода».
    expect(result.hits.map((hit) => path.basename(hit.path))).toEqual(['text.ts']);
  });

  it('файл крупнее потолка поиском не читается', async () => {
    const { ws, root } = await open();
    // Потолок 2 МБ; совпадение в самом начале, а файл чуть больше.
    const big = `needle\n${'x'.repeat(2 * 1024 * 1024 + 10)}`;
    await fs.writeFile(path.join(root, 'big.txt'), big, 'utf8');

    const result = await ws.search({ query: 'needle' });

    // Читать гигабайт ради одной строки — не тот обмен.
    expect(result.hits).toHaveLength(0);
  });
});
