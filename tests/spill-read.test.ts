import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Копии длинного вывода — вне проекта, и адрес из пометки «вывод обрезан;
 * полностью в файле …» обязан открываться.
 *
 * До правки пометка вела в тупик: `read_file` проверяет путь рабочей папкой и
 * отвечал «Путь вне рабочей папки». Агент видел адрес, шёл по нему, получал
 * отказ и либо перезапускал команду (новый вывод — новый файл), либо бросал
 * дело. Обещать адрес, по которому нельзя пройти, хуже, чем не обещать вовсе.
 */

const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

describe('чтение копий вывода', () => {
  it('без разрешения файл вне проекта не читается', async () => {
    const root = await tempDir('chui-spill-root-');
    const spill = await tempDir('chui-spill-copy-');
    const file = path.join(spill, 'terminal.txt');
    await fs.writeFile(file, 'вывод команды', 'utf8');

    const workspace = new WorkspaceService(() => undefined);
    await workspace.open(root);
    await expect(workspace.readFile(file)).rejects.toThrow(/вне рабочей папки/);
    workspace.dispose();
  });

  it('после allowReadDir копия читается', async () => {
    const root = await tempDir('chui-spill-root-');
    const spill = await tempDir('chui-spill-copy-');
    const file = path.join(spill, 'terminal.txt');
    await fs.writeFile(file, 'вывод команды', 'utf8');

    const workspace = new WorkspaceService(() => undefined);
    await workspace.open(root);
    workspace.allowReadDir(spill);

    const content = await workspace.readFile(file);
    expect(content.text).toBe('вывод команды');
    workspace.dispose();
  });

  it('запись в этот каталог по-прежнему запрещена', async () => {
    const root = await tempDir('chui-spill-root-');
    const spill = await tempDir('chui-spill-copy-');

    const workspace = new WorkspaceService(() => undefined);
    await workspace.open(root);
    workspace.allowReadDir(spill);

    // Разрешение только на чтение: копия вывода не должна становиться местом,
    // где агент правит файлы в обход проекта.
    await expect(workspace.writeFile(path.join(spill, 'new.txt'), 'текст')).rejects.toThrow(/вне рабочей папки/);
    workspace.dispose();
  });
});
