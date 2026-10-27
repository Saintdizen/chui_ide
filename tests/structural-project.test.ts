import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Замена по структуре по ВСЕМУ проекту: проверяем и обход файлов, и то, что правится
 * только подходящее, а `#` в CSS не принимается за комментарий.
 *
 * Логика самого сопоставления — в `tests/structural-search.test.ts`; здесь проверяем
 * шов main-слоя: обход, чтение, запись и подсчёт.
 */
let dir: string;
let workspace: WorkspaceService;

/** Каталог временный, поэтому берём у него канонический путь: на macOS `os.tmpdir()` — симлинк. */
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-struct-')));
  workspace = new WorkspaceService(() => undefined);
  await workspace.open(dir);
});

afterEach(async () => {
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(relative: string, text: string): Promise<string> {
  const file = path.join(dir, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
  return file;
}

const read = (relative: string): Promise<string> => fs.readFile(path.join(dir, relative), 'utf8');

describe('workspace.findByStructure', () => {
  it('находит места в разных файлах и считает их', async () => {
    await write('a.ts', 'foo(a, b);\nfoo(c, d);\n');
    await write('b.ts', 'foo(e, f);\n');
    await write('c.ts', 'bar(1);\n');

    const result = await workspace.findByStructure({ pattern: 'foo($x, $y)' });

    expect(result.total).toBe(3);
    expect(result.files.map((file) => path.relative(dir, file.path)).sort()).toEqual(['a.ts', 'b.ts']);
    expect(result.files.find((file) => file.path.endsWith('a.ts'))?.count).toBe(2);
  });

  it('не находит — пустой список, а не ошибка', async () => {
    await write('a.ts', 'bar(1);\n');
    const result = await workspace.findByStructure({ pattern: 'foo($x)' });
    expect(result.total).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('пустой образец — ошибка, а не «ничего не нашлось»', async () => {
    await expect(workspace.findByStructure({ pattern: '   ' })).rejects.toThrow();
  });
});

describe('workspace.replaceByStructure', () => {
  it('меняет форму во всех файлах и возвращает изменённые пути', async () => {
    const a = await write('a.ts', 'foo(a, b);\nfoo(c, d);\n');
    const b = await write('b.ts', 'foo(e, f);\n');
    await write('c.ts', 'bar(1);\n');

    const result = await workspace.replaceByStructure({ pattern: 'foo($x, $y)', replacement: 'bar($y, $x)' });

    expect(await read('a.ts')).toBe('bar(b, a);\nbar(d, c);\n');
    expect(await read('b.ts')).toBe('bar(f, e);\n');
    expect(await read('c.ts')).toBe('bar(1);\n');
    expect(result.replaced).toBe(3);
    expect(result.files.sort()).toEqual([a, b].sort());
  });

  it('в CSS `#` — не комментарий: цвет не выпадает из структуры', async () => {
    await write('style.css', 'a { color: #fff; }\n');
    // Строку после `#` читаем как код: если принять `#` за комментарий (как в коде), вся
    // строка до конца исчезнет из структуры, `$c...` не поймает цвет и замены не случится.
    const result = await workspace.replaceByStructure({
      pattern: 'color: $c... ;',
      replacement: 'background: $c;',
    });

    expect(await read('style.css')).toBe('a { background: #fff; }\n');
    expect(result.replaced).toBe(1);
  });

  it('нечего менять — ни путей, ни ошибки', async () => {
    await write('a.ts', 'bar(1);\n');
    const result = await workspace.replaceByStructure({ pattern: 'foo($x)', replacement: 'baz($x)' });
    expect(result).toEqual({ files: [], replaced: 0 });
  });

  it('маска пути ограничивает, где искать', async () => {
    await write('src/a.ts', 'foo(a, b);\n');
    await write('tests/a.ts', 'foo(c, d);\n');

    const result = await workspace.replaceByStructure({
      pattern: 'foo($x, $y)',
      replacement: 'bar($y, $x)',
      glob: 'src/**',
    });

    expect(await read('src/a.ts')).toBe('bar(b, a);\n');
    expect(await read('tests/a.ts')).toBe('foo(c, d);\n');
    expect(result.replaced).toBe(1);
  });
});
