import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HistoryStore } from '../src/main/project/history-store';
import { MAX_HISTORY_BYTES, MAX_HISTORY_ENTRIES } from '../src/shared/file-history';

/**
 * Локальная история: снимки содержимого перед перезаписью файла.
 *
 * Каталог хранилища задаётся снаружи, поэтому проверка идёт с временными папками:
 * одна — само хранилище, вторая — «проект». Так же, как в session-store, раскладка
 * ключуется путём проекта, и без явного каталога тест писал бы в userData.
 */
const roots: string[] = [];

afterEach(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
  roots.length = 0;
});

async function setup(): Promise<{ store: HistoryStore; root: string; base: string }> {
  // realpath убирает симлинк temp-каталога на macOS: иначе одинаковый каталог
  // выглядел бы двумя разными путями и хранилище разошлось бы с ожиданием.
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'chui-hist-')));
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'chui-proj-')));
  roots.push(base, root);
  return { store: new HistoryStore(path.join(base, 'history')), root, base };
}

/** Файл проекта и его путь. */
async function makeFile(root: string, name: string, text: string): Promise<string> {
  const file = path.join(root, name);
  await writeFile(file, text, 'utf8');
  return file;
}

describe('HistoryStore', () => {
  it('снимает содержимое и отдаёт его списком, новые в начале', async () => {
    const { store, root } = await setup();
    const file = await makeFile(root, 'a.ts', 'const a = 1;\n');

    await store.capture(root, file);
    await writeFile(file, 'const a = 2;\n', 'utf8');
    await store.capture(root, file);

    const list = await store.list(root, file);
    expect(list).toHaveLength(2);
    // Новый снимок — в начале списка, и это прежнее содержимое: capture снимает ДО записи.
    expect(await store.read(root, file, list[0]!.id)).toBe('const a = 2;\n');
    expect(await store.read(root, file, list[1]!.id)).toBe('const a = 1;\n');
    expect(list[0]!.name).toBe('a.ts');
    expect(list[0]!.reason).toBe('save');
  });

  it('тот же текст второй раз не сохраняет', async () => {
    const { store, root } = await setup();
    const file = await makeFile(root, 'a.ts', 'one\n');

    await store.capture(root, file);
    await store.capture(root, file);
    await store.capture(root, file);

    expect(await store.list(root, file)).toHaveLength(1);
  });

  it('снимок перед удалением берётся даже при неизменном тексте', async () => {
    const { store, root } = await setup();
    const file = await makeFile(root, 'a.ts', 'one\n');

    await store.capture(root, file);
    await store.capture(root, file, 'delete');

    const list = await store.list(root, file);
    expect(list).toHaveLength(2);
    expect(list[0]!.reason).toBe('delete');
  });

  it('держит не больше MAX_HISTORY_ENTRIES и вытесненные снимки убирает с диска', async () => {
    const { store, root, base } = await setup();
    const file = await makeFile(root, 'a.ts', 'v0\n');

    for (let i = 1; i <= MAX_HISTORY_ENTRIES + 5; i += 1) {
      await writeFile(file, `v${i}\n`, 'utf8');
      await store.capture(root, file);
    }

    expect(await store.list(root, file)).toHaveLength(MAX_HISTORY_ENTRIES);
    const [workspaceDir] = await readdir(path.join(base, 'history'));
    const snapshots = (await readdir(path.join(base, 'history', workspaceDir!))).filter((name) =>
      name.endsWith('.txt'),
    );
    expect(snapshots).toHaveLength(MAX_HISTORY_ENTRIES);
  });

  it('читает только существующий снимок и отвергает опасный id', async () => {
    const { store, root } = await setup();
    const file = await makeFile(root, 'a.ts', 'one\n');
    await store.capture(root, file);
    const [entry] = await store.list(root, file);

    expect(await store.read(root, file, entry!.id)).toBe('one\n');
    expect(await store.read(root, file, 'нет-такого')).toBeNull();
    // id — это имя файла в хранилище: выход из каталога недопустим.
    expect(await store.read(root, file, '../../../../etc/passwd')).toBeNull();
  });

  it('clear убирает и записи, и снимки на диске', async () => {
    const { store, root, base } = await setup();
    const file = await makeFile(root, 'a.ts', 'one\n');

    await store.capture(root, file);
    await writeFile(file, 'two\n', 'utf8');
    await store.capture(root, file);
    await store.clear(root, file);

    expect(await store.list(root, file)).toEqual([]);
    const [workspaceDir] = await readdir(path.join(base, 'history'));
    const snapshots = (await readdir(path.join(base, 'history', workspaceDir!))).filter((name) =>
      name.endsWith('.txt'),
    );
    expect(snapshots).toEqual([]);
  });

  it('слишком большой файл не копируется', async () => {
    const { store, root } = await setup();
    const file = await makeFile(root, 'big.bin', 'x'.repeat(MAX_HISTORY_BYTES + 1));

    await store.capture(root, file);

    expect(await store.list(root, file)).toEqual([]);
  });

  it('снимки разных файлов не смешиваются', async () => {
    const { store, root } = await setup();
    const a = await makeFile(root, 'a.ts', 'aaa\n');
    const b = await makeFile(root, 'b.ts', 'bbb\n');

    await store.capture(root, a);
    await store.capture(root, b);

    expect(await store.list(root, a)).toHaveLength(1);
    expect(await store.list(root, b)).toHaveLength(1);
    expect(await store.read(root, a, (await store.list(root, a))[0]!.id)).toBe('aaa\n');
  });
});
