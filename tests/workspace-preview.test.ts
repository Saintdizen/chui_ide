import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 *Предпросмотр файлов, которые текстом не открыть: картинки и Office.
 *
 * Обе двери отказывают там, где открыть нельзя, и называют предел числом —
 * «слишком большой» без цифры не даёт человеку ничего, с чем можно работать.
 */
const roots: string[] = [];
const services: WorkspaceService[] = [];

async function setup(): Promise<{ root: string; ws: WorkspaceService }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-view-')));
  roots.push(root);
  const ws = new WorkspaceService(() => undefined);
  services.push(ws);
  await ws.open(root);
  return { root, ws };
}

afterEach(async () => {
  for (const ws of services.splice(0)) ws.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

// 1×1 PNG: годная картинка, которой достаточно для проверки data-URL.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('картинка', () => {
  it('отдаётся data-URL: вьюер понимает только его', async () => {
    const { root, ws } = await setup();
    await fs.writeFile(path.join(root, 'a.png'), PNG);
    const image = await ws.readImage(path.join(root, 'a.png'));
    expect(image.mime).toBe('image/png');
    expect(image.bytes).toBe(PNG.byteLength);
    expect(image.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('не картинка — отказ с именем файла', async () => {
    const { root, ws } = await setup();
    await fs.writeFile(path.join(root, 'a.txt'), 'текст\n');
    await expect(ws.readImage(path.join(root, 'a.txt'))).rejects.toThrow(/Не изображение: a\.txt/);
  });

  it('нет файла — «не найден», а не «не изображение»', async () => {
    const { root, ws } = await setup();
    await expect(ws.readImage(path.join(root, 'нет.png'))).rejects.toThrow(/не найден/i);
  });

  it('слишком большая — предел назван числом', async () => {
    const { root, ws } = await setup();
    // Пишем файл больше предела, но не держим его в памяти.
    const file = path.join(root, 'big.png');
    await fs.writeFile(file, PNG);
    const limit = 32 * 1024 * 1024;
    await fs.truncate(file, limit + 1024 * 1024);
    await expect(ws.readImage(file)).rejects.toThrow(/больше предела \d+ МБ/);
  });
});

describe('документ Office', () => {
  it('не .docx и не .xlsx — отказ, а не пустая страница', async () => {
    const { root, ws } = await setup();
    await fs.writeFile(path.join(root, 'a.pdf'), 'x\n');
    await expect(ws.readOffice(path.join(root, 'a.pdf'))).rejects.toThrow(/\.docx и \.xlsx/);
  });

  it('нет файла — «не найден»', async () => {
    const { root, ws } = await setup();
    await expect(ws.readOffice(path.join(root, 'нет.docx'))).rejects.toThrow(/не найден/i);
  });

  it('битый zip — внятный отказ, а не падение', async () => {
    const { root, ws } = await setup();
    const file = path.join(root, 'битый.docx');
    await fs.writeFile(file, 'это не zip, а текст\n');
    await expect(ws.readOffice(file)).rejects.toThrow(/Не удалось прочитать документ/);
  });
});
