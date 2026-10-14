import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Поиск наследования по проекту: обход файлов, пропуск языков без разбора и подсчёт.
 * Разбор самих объявлений — в `tests/type-inheritance.test.ts`.
 */
let dir: string;
let workspace: WorkspaceService;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-inherit-')));
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

describe('workspace.findInheritance', () => {
  it('кто наследует имя — по всем файлам', async () => {
    await write('base.ts', 'export class Base {}\n');
    await write('a.ts', 'class Child extends Base {}\n');
    await write('b.ts', 'class Other extends Base {}\n');
    await write('c.ts', 'class Unrelated {}\n');

    const result = await workspace.findInheritance({ name: 'Base', direction: 'subtypes' });

    expect(result.total).toBe(2);
    expect(result.files.map((file) => path.relative(dir, file.path)).sort()).toEqual(['a.ts', 'b.ts']);
    expect(result.files.every((file) => file.entries[0]?.bases.includes('Base'))).toBe(true);
  });

  it('от кого наследует имя', async () => {
    await write('a.ts', 'class Child extends Base implements IThing {}\n');
    const result = await workspace.findInheritance({ name: 'Child', direction: 'supertypes' });
    expect(result.total).toBe(1);
    expect(result.files[0]?.entries[0]?.bases).toEqual(['Base', 'IThing']);
  });

  it('видит python-классы', async () => {
    await write('mod.py', 'class Child(Base, Mix):\n    pass\n');
    const result = await workspace.findInheritance({ name: 'Base', direction: 'subtypes' });
    expect(result.total).toBe(1);
  });

  it('языки без разбора пропускаются', async () => {
    await write('style.css', '.base {}\n');
    const result = await workspace.findInheritance({ name: 'base', direction: 'subtypes' });
    expect(result.scanned).toBe(0);
    expect(result.total).toBe(0);
  });

  it('пустое имя — ошибка', async () => {
    await expect(workspace.findInheritance({ name: '  ', direction: 'subtypes' })).rejects.toThrow();
  });
});
