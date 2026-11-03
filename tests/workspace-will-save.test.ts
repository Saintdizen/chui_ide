import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Форматирование при сохранении: сервер вправе сказать, что записать вместо
 * файла (`willSaveWaitUntil`).
 *
 * Сервис рабочей папки — последний, кто решает, что окажется на диске. Правило
 * должно действовать на всех путях записи (одиночная, массовая, переименование),
 * иначе форматирование срабатывало бы через раз — и тем непонятнее.
 */
let dir: string;
let workspace: WorkspaceService;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-willsave-')));
  workspace = new WorkspaceService(() => undefined);
  await workspace.open(dir);
});

afterEach(async () => {
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('onWillSave', () => {
  it('пишет текст с правками сервера, а не исходный', async () => {
    workspace.onWillSave = (file, text) => (file.endsWith('a.ts') ? `${text.trim()}\n` : null);
    const file = path.join(dir, 'a.ts');
    await workspace.writeFile(file, 'const a = 1;\n\n\n');

    expect(await fs.readFile(file, 'utf8')).toBe('const a = 1;\n');
  });

  it('null — пишем как есть', async () => {
    workspace.onWillSave = () => null;
    const file = path.join(dir, 'b.ts');
    await workspace.writeFile(file, 'x\n\n\n');

    expect(await fs.readFile(file, 'utf8')).toBe('x\n\n\n');
  });

  it('сбой хука не мешает сохранению: файл всё равно записан', async () => {
    workspace.onWillSave = () => {
      throw new Error('сервер упал');
    };
    const file = path.join(dir, 'c.ts');
    await workspace.writeFile(file, 'важно');

    expect(await fs.readFile(file, 'utf8')).toBe('важно');
  });

  it('без хука запись прежняя', async () => {
    const file = path.join(dir, 'd.ts');
    await workspace.writeFile(file, 'текст');

    expect(await fs.readFile(file, 'utf8')).toBe('текст');
  });
});
