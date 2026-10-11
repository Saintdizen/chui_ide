import { describe, expect, it } from 'vitest';
import type { DocumentStore } from '../src/renderer/core/document-store';
import type { RpcClient } from '../src/renderer/core/rpc';
import { createTsProjectFeed, scriptFiles, type ExtraLibTarget } from '../src/renderer/core/ts-project';

describe('scriptFiles', () => {
  const paths = ['/proj/src/a.ts', '/proj/src/b.js', '/proj/src/c.py', '/proj/README.md', '/proj/src/d.tsx'];

  it('берём только то, что разбирает сервис TypeScript', () => {
    expect(scriptFiles(paths, new Set())).toEqual(['/proj/src/a.ts', '/proj/src/b.js', '/proj/src/d.tsx']);
  });

  it('открытые пропускаем: они уже модели сервиса', () => {
    expect(scriptFiles(paths, new Set(['/proj/src/a.ts']))).toEqual(['/proj/src/b.js', '/proj/src/d.tsx']);
  });

  it('потолок набора соблюдается', () => {
    expect(scriptFiles(paths, new Set(), 1)).toEqual(['/proj/src/a.ts']);
  });
});

/* ── набор файлов у сервиса ─────────────────────────────────────────────── */

/** Набор сервиса: запоминает, что в него положили и что убрали. */
function fakeTarget(): ExtraLibTarget & { added: Map<string, string>; disposed: string[] } {
  const added = new Map<string, string>();
  const disposed: string[] = [];
  return {
    added,
    disposed,
    addExtraLib(text: string, filePath: string) {
      added.set(filePath, text);
      return {
        dispose: () => {
          added.delete(filePath);
          disposed.push(filePath);
        },
      };
    },
  };
}

interface Harness {
  feed: ReturnType<typeof createTsProjectFeed>;
  target: ReturnType<typeof fakeTarget>;
  openDocument: (path: string) => void;
  removeFile: (name: string) => void;
}

function harness(files: Record<string, string>): Harness {
  const open = new Set<string>();
  // Ключи набора — относительные, как их отдаёт `listFiles`, а читает сервис уже
  // абсолютные пути: в подставном чтении переводим одно в другое.
  const contents = new Map(Object.entries(files).map(([name, text]) => [`/proj/${name}`, text]));
  const rpc = {
    request: (method: string, params?: { path?: string }) => {
      if (method === 'workspace.listFiles') {
        return Promise.resolve([...contents.keys()].map((path) => path.slice('/proj/'.length)));
      }
      if (method === 'workspace.readFile') {
        const text = params?.path ? contents.get(params.path) : undefined;
        return text === undefined ? Promise.reject(new Error('нет файла')) : Promise.resolve({ text, mtimeMs: 0 });
      }
      return Promise.reject(new Error(method));
    },
  } as unknown as RpcClient;

  const documents = { all: () => [...open].map((path) => ({ path })) } as unknown as DocumentStore;
  const target = fakeTarget();
  // Задержка сборки нулевая: тесту важно, что получится, а не пауза.
  const feed = createTsProjectFeed({ rpc, documents, root: () => '/proj', targets: [target], delay: 0 });

  return {
    feed,
    target,
    openDocument: (path) => open.add(path),
    removeFile: (name) => contents.delete(`/proj/${name}`),
  };
}

/** Дождаться сборки: задержка нулевая, но она всё равно отдельная задача. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('createTsProjectFeed', () => {
  it('отдаёт сервису скрипты проекта с адресом в виде ссылки', async () => {
    const { feed, target } = harness({ 'src/a.ts': 'export const a = 1;', 'src/readme.md': '# нет' });

    feed.refresh();
    await settle();

    expect([...target.added.keys()]).toEqual(['file:///proj/src/a.ts']);
    expect(target.added.get('file:///proj/src/a.ts')).toBe('export const a = 1;');
  });

  it('повторный сбор ничего не перекладывает', async () => {
    const { feed, target } = harness({ 'src/a.ts': 'let a = 1;' });

    feed.refresh();
    await settle();
    target.disposed.length = 0;
    feed.refresh();
    await settle();

    expect(target.disposed).toEqual([]);
    expect(target.added.size).toBe(1);
  });

  it('открытый файл уходит из набора: его видно как модель', async () => {
    const { feed, target, openDocument } = harness({ 'src/a.ts': 'let a = 1;' });

    feed.refresh();
    await settle();
    expect(target.added.size).toBe(1);

    openDocument('/proj/src/a.ts');
    feed.refresh();
    await settle();

    expect(target.added.size).toBe(0);
    expect(target.disposed).toEqual(['file:///proj/src/a.ts']);
  });

  it('исчезнувший файл убирается из набора', async () => {
    const { feed, target, removeFile } = harness({ 'src/a.ts': 'let a = 1;', 'src/b.ts': 'let b = 2;' });

    feed.refresh();
    await settle();
    expect(target.added.size).toBe(2);

    removeFile('src/b.ts');
    feed.refresh();
    await settle();

    expect([...target.added.keys()]).toEqual(['file:///proj/src/a.ts']);
  });

  it('у dispose набор пустеет', async () => {
    const { feed, target } = harness({ 'src/a.ts': 'let a = 1;' });

    feed.refresh();
    await settle();
    feed.dispose();

    expect(target.added.size).toBe(0);
  });

  it('серия событий собирает набор один раз', async () => {
    const { feed, target } = harness({ 'src/a.ts': 'let a = 1;' });

    feed.refresh();
    feed.refresh();
    feed.refresh();
    await settle();

    expect(target.added.size).toBe(1);
  });
});
