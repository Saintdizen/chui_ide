import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Обновление импортов при переименовании: проверяем и обход файлов проекта,
 * и то, что переписанным оказывается только нужное.
 *
 * Переименовываем ЦЕЛЬ (то, на что ссылаются), а не файл со ссылкой: именно так
 * это и работает в дереве — человек переименовал модуль, а импорты указывают на него.
 */
let dir: string;
let workspace: WorkspaceService;

/** Каталог временный, поэтому берём у него канонический путь: на macOS `os.tmpdir()` — симлинк. */
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-imports-')));
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

describe('workspace.updateImports', () => {
  it('переписывает ссылки на переименованный файл', async () => {
    const from = await write('src/foo.ts', 'export const foo = 1;\n');
    await write('src/app.ts', "import { foo } from './foo';\n");
    const to = path.join(dir, 'src/bar.ts');

    await workspace.rename(from, to);
    const result = await workspace.updateImports(from, to);

    expect(await read('src/app.ts')).toBe("import { foo } from './bar';\n");
    expect(result.files).toEqual([path.join(dir, 'src/app.ts')]);
  });

  it('файлы внутри переименованной папки остаются как были', async () => {
    await write('src/utils/a.ts', "import b from './b';\n");
    await write('src/utils/b.ts', 'export default 1;\n');
    await write('src/app.ts', "import a from './utils/a';\n");
    const from = path.join(dir, 'src/utils');
    const to = path.join(dir, 'src/helpers');
    await fs.rename(from, to);

    await workspace.updateImports(from, to);

    expect(await read('src/app.ts')).toBe("import a from './helpers/a';\n");
    // Сосед внутри переехавшей папки не тронут: путь между ними не изменился.
    expect(await read('src/helpers/a.ts')).toBe("import b from './b';\n");
  });

  it('правит относительные импорты Python', async () => {
    const from = await write('pkg/utils.py', 'x = 1\n');
    await write('pkg/app.py', 'from .utils import x\n');
    const to = path.join(dir, 'pkg/helpers.py');

    await workspace.rename(from, to);
    await workspace.updateImports(from, to);

    expect(await read('pkg/app.py')).toBe('from .helpers import x\n');
  });

  it('нет подходящих ссылок — пустой список, а не ошибка', async () => {
    const from = await write('src/foo.ts', 'export const foo = 1;\n');
    await write('src/app.ts', "import x from './other';\n");
    const to = path.join(dir, 'src/bar.ts');

    await workspace.rename(from, to);
    expect(await workspace.updateImports(from, to)).toEqual({ files: [] });
    expect(await read('src/app.ts')).toBe("import x from './other';\n");
  });
});
