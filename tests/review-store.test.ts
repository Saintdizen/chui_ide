import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewStore } from '../src/main/project/review-store';
import { makeComment, makeThread } from '../src/shared/review';

/**
 * Хранилище замечаний: файл в проекте и его терпимость к битому содержимому.
 * Замечания пишутся одним файлом с версией, читаются тем же разбором, что и в
 * интерфейсе, — значит, испорченный файл не роняет открытие проекта.
 */
describe('ReviewStore', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeRoot(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'chui-review-'));
    dirs.push(dir);
    return dir;
  }

  async function writeReviewFile(root: string, content: string): Promise<void> {
    const file = path.join(root, '.chui_ide', 'review.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  }

  it('в проекте без файла замечаний нет', async () => {
    const store = new ReviewStore();
    expect(await store.load(await makeRoot())).toEqual([]);
  });

  it('записывает и читает замечания обратно', async () => {
    const store = new ReviewStore();
    const root = await makeRoot();
    const thread = makeThread('src/a.ts', 'modified', 4, 'const a = 1;', 'тут не хватает проверки');
    await store.save(root, [thread]);

    const file = path.join(root, '.chui_ide', 'review.json');
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { version: number };
    expect(parsed.version).toBe(1);

    const loaded = await store.load(root);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.path).toBe('src/a.ts');
    expect(loaded[0]?.line).toBe(4);
    expect(loaded[0]?.comments[0]?.text).toBe('тут не хватает проверки');
  });

  it('сохраняет ответы и пометку «решено»', async () => {
    const store = new ReviewStore();
    const root = await makeRoot();
    const thread = makeThread('a.ts', 'modified', 2, 'x', 'первое', 'вы', 1000);
    thread.resolved = true;
    thread.comments.push(makeComment('ответ', 'вы', 2000));
    await store.save(root, [thread]);

    const [loaded] = await store.load(root);
    expect(loaded?.resolved).toBe(true);
    expect(loaded?.comments.map((comment) => comment.text)).toEqual(['первое', 'ответ']);
  });

  it('битый файл читается как «замечаний нет», а не отказ', async () => {
    const store = new ReviewStore();
    const root = await makeRoot();
    await writeReviewFile(root, '{ это не json');
    expect(await store.load(root)).toEqual([]);
  });

  it('чужой формат внутри файла тоже переживается', async () => {
    const store = new ReviewStore();
    const root = await makeRoot();
    await writeReviewFile(root, JSON.stringify({ threads: [{ path: '/a.ts', comments: [{ text: 'ок' }] }] }));
    const loaded = await store.load(root);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.side).toBe('modified');
  });

  it('сохранение возвращает то, что легло на диск (уже проверенное)', async () => {
    const store = new ReviewStore();
    const root = await makeRoot();
    const saved = await store.save(root, [
      // Тред без пути не имеет смысла — в файл он не попадёт.
      { id: 't1', path: '', side: 'modified', line: 1, anchor: '', resolved: false, comments: [] },
    ]);
    expect(saved).toEqual([]);
  });
});
