import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Импорты при переименовании: если языковой сервер умеет `willRenameFiles`, его
 * правки предпочитаются собственной regex-переписке (он знает алиасы, реэкспорты,
 * пути из tsconfig). Нет сервера — работает старое текстовое переписывание.
 */
let dir: string;
let workspace: WorkspaceService;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-willrename-')));
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

describe('willRenameFiles перед regex', () => {
  it('правки сервера применяются и заменяют regex', async () => {
    const from = await write('src/foo.ts', 'export const foo = 1;\n');
    await write('src/app.ts', "import { foo } from '@app/foo';\n");
    const to = path.join(dir, 'src/bar.ts');
    await workspace.rename(from, to);

    const appFile = path.join(dir, 'src/app.ts');
    workspace.onWillRenameFiles = async () => [
      { path: appFile, edits: [{ startLine: 1, startColumn: 22, endLine: 1, endColumn: 30, newText: '@app/bar' }] },
    ];

    const result = await workspace.updateImports(from, to);
    expect(await read('src/app.ts')).toBe("import { foo } from '@app/bar';\n");
    expect(result.files).toEqual([appFile]);
  });

  it('сервер вернул null — работает текстовый fallback', async () => {
    const from = await write('src/foo.ts', 'export const foo = 1;\n');
    await write('src/app.ts', "import { foo } from './foo';\n");
    const to = path.join(dir, 'src/bar.ts');
    await workspace.rename(from, to);

    workspace.onWillRenameFiles = async () => null;
    await workspace.updateImports(from, to);
    expect(await read('src/app.ts')).toBe("import { foo } from './bar';\n");
  });

  it('правку вне корня отбрасываем', async () => {
    const from = await write('src/foo.ts', 'export const foo = 1;\n');
    await write('src/app.ts', "import { foo } from './foo';\n");
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-outside-')));
    const stray = path.join(outside, 'x.ts');
    await fs.writeFile(stray, 'const a = 1;\n', 'utf8');
    const to = path.join(dir, 'src/bar.ts');
    await workspace.rename(from, to);

    workspace.onWillRenameFiles = async () => [
      { path: stray, edits: [{ startLine: 1, startColumn: 7, endLine: 1, endColumn: 8, newText: '2' }] },
    ];
    await workspace.updateImports(from, to);

    expect(await fs.readFile(stray, 'utf8')).toBe('const a = 1;\n');
    expect(await read('src/app.ts')).toBe("import { foo } from './bar';\n");
    await fs.rm(outside, { recursive: true, force: true });
  });
});
