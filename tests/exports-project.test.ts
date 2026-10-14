import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Поиск «где имя экспортируется» по проекту: обход файлов, пропуск языков без разбора
 * и подсчёт. Разбор самих экспортов — в `tests/symbol-exports.test.ts`; здесь проверяем
 * шов main-слоя.
 */
let dir: string;
let workspace: WorkspaceService;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-exports-')));
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

describe('workspace.findExports', () => {
  it('находит экспорты имени в разных файлах', async () => {
    await write('a.ts', 'export const target = 1;\n');
    await write('b.ts', "export { target } from './a';\n");
    await write('c.ts', 'export const other = 2;\n');

    const result = await workspace.findExports({ name: 'target' });

    expect(result.total).toBe(2);
    expect(result.files.map((file) => path.relative(dir, file.path)).sort()).toEqual(['a.ts', 'b.ts']);
    expect(result.files.every((file) => file.entries[0]?.name === 'target')).toBe(true);
  });

  it('видит экспорт в python', async () => {
    await write('pkg/mod.py', 'def target():\n    pass\n');
    const result = await workspace.findExports({ name: 'target' });
    expect(result.total).toBe(1);
    expect(result.files[0]?.entries[0]).toMatchObject({ line: 1, kind: 'declaration' });
  });

  it('не находит — пустой список, а не ошибка', async () => {
    await write('a.ts', 'export const value = 1;\n');
    expect(await workspace.findExports({ name: 'nope' })).toMatchObject({ total: 0, files: [] });
  });

  it('файлы языков без разбора пропускаются', async () => {
    await write('style.css', '.foo { color: red }\n');
    const result = await workspace.findExports({ name: 'foo' });
    // CSS не разбираем: его и не считаем просмотренным.
    expect(result.scanned).toBe(0);
    expect(result.total).toBe(0);
  });

  it('пустое имя — ошибка', async () => {
    await expect(workspace.findExports({ name: '   ' })).rejects.toThrow();
  });
});
