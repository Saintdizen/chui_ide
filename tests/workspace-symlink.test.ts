import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Границы проекта и потолки поиска.
 *
 * Симлинк — главное здесь: папка внутри проекта, а ведёт наружу. Проверка по
 * одному текстовому пути его пропустит, поэтому сравниваются КАНОНИЧЕСКИЕ пути
 * после realpath. Дальше — бинарные файлы и строки с нулевым байтом, которые в
 * поиск попадать не должны, и обрезка строки совпадения.
 */

const roots: string[] = [];
const services: WorkspaceService[] = [];

afterEach(async () => {
  for (const ws of services.splice(0)) ws.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-ws7-')));
  roots.push(dir);
  return dir;
}

function service(events: Array<{ topic: string; payload: unknown }> = []): WorkspaceService {
  const ws = new WorkspaceService(
    (topic, payload) => events.push({ topic, payload }),
    () => undefined,
  );
  services.push(ws);
  return ws;
}

describe('симлинки за пределы проекта', () => {
  it('папка-симлинк наружу не пускает читать', async () => {
    const root = await makeDir();
    const outside = await makeDir();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'секрет\n', 'utf8');
    await fs.symlink(outside, path.join(root, 'вылазка'), 'dir');

    const ws = service();
    await ws.open(root);

    // Путь ТЕКСТОМ внутри проекта, а на деле — снаружи.
    await expect(ws.readFile(path.join(root, 'вылазка', 'secret.txt'))).rejects.toThrow(/симлинк/i);
  });

  it('относительный симлинк наружу тоже ловится', async () => {
    const root = await makeDir();
    const outside = await makeDir();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'секрет\n', 'utf8');
    // Относительная ссылка: по тексту вообще не видно, куда она ведёт.
    await fs.symlink(path.relative(root, outside), path.join(root, 'вылазка'), 'dir');

    const ws = service();
    await ws.open(root);

    await expect(ws.readFile(path.join(root, 'вылазка', 'secret.txt'))).rejects.toThrow(/симлинк/i);
  });

  it('симлинк ВНУТРИ проекта разрешён', async () => {
    const root = await makeDir();
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'const a = 1;\n', 'utf8');
    await fs.symlink(path.join(root, 'src'), path.join(root, 'ссылка'), 'dir');

    const ws = service();
    await ws.open(root);

    // Ужесточение не должно запретить обычные ссылки внутри проекта.
    const content = await ws.readFile(path.join(root, 'ссылка', 'a.ts'));
    expect(content.text).toContain('const a = 1;');
  });
});

/**
 * Дерево показывает ссылку с её целью. Живая ссылка — куда ведёт и папка ли
 * это; битая — что цель не найдена, чтобы дерево не пыталось её раскрыть.
 */
describe('ссылки в дереве', () => {
  it('живая ссылка отдаёт цель и её вид', async () => {
    const root = await makeDir();
    await fs.mkdir(path.join(root, 'src'));
    await fs.symlink(path.join(root, 'src'), path.join(root, 'ссылка'), 'dir');

    const ws = service();
    await ws.open(root);
    const entries = await ws.readDir(root);
    const link = entries.find((entry) => entry.name === 'ссылка');

    expect(link?.kind).toBe('symlink');
    expect(link?.symlink).toEqual({
      target: await fs.realpath(path.join(root, 'src')),
      kind: 'directory',
      broken: false,
    });
  });

  it('битая ссылка видна, помечена и не роняет дерево', async () => {
    const root = await makeDir();
    await fs.symlink(path.join(root, 'нет-такого'), path.join(root, 'битая'), 'dir');

    const ws = service();
    await ws.open(root);
    const entries = await ws.readDir(root);
    const link = entries.find((entry) => entry.name === 'битая');

    // Ссылка остаётся в списке: спрятать её — соврать, что файла нет вовсе.
    expect(link?.kind).toBe('symlink');
    expect(link?.symlink?.broken).toBe(true);
    expect(link?.symlink?.target).toBe(path.join(root, 'нет-такого'));
  });
});
