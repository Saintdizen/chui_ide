import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SymbolIndexer, orderFiles } from '../src/main/symbols/indexer';
import { SymbolStore, indexFilePath } from '../src/main/symbols/store';
import type { FileSymbol } from '../src/shared/lsp-symbols';

/**
 * Сборка карты символов и её кэш на диске.
 *
 * Языкового сервера в проверке нет — и не должно быть: сборщик знает про сервер
 * ровно одно («дай скелет файла»), поэтому подменяется функцией. Так проверяется
 * главное: карта разбирает только изменившиеся файлы, переживает «перезапуск»
 * (новый сборщик читает кэш) и не выдумывает объявления там, где сервер молчит.
 */

const tempDirs: string[] = [];

function project(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'chui-symbols-'));
  tempDirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Скелет по имени файла: сборщик спрашивает сервер, мы отвечаем как он. */
function fakeOutline(decls: Record<string, FileSymbol[] | null>) {
  const asked: string[] = [];
  const outline = async (target: string): Promise<readonly FileSymbol[] | null> => {
    const relative = path.basename(target);
    asked.push(relative);
    // `in` — а не `?? []`: `null` здесь значит «сервер молчит», и это другое, чем «объявлений нет».
    return relative in decls ? (decls[relative] ?? null) : [];
  };
  return { outline, asked };
}

const parserSkeleton: FileSymbol[] = [
  {
    name: 'Parser',
    kind: 'класс',
    line: 1,
    endLine: 5,
    children: [{ name: 'run', kind: 'метод', line: 3, endLine: 4, children: [] }],
  },
];

describe('SymbolIndexer', () => {
  it('собирает карту по файлам своего языка и отдаёт их в поиск', async () => {
    const root = project({ 'main.py': 'class Parser(Base):\n    def run(self):\n        pass\n', 'style.css': 'a{}' });
    const { outline } = fakeOutline({ 'main.py': parserSkeleton });
    const index = new SymbolIndexer({ root: () => root, outline, store: new SymbolStore(path.join(root, '.idx')) });

    index.refresh();
    await index.settled();

    expect(index.status()).toMatchObject({ phase: 'ready', files: 1, decls: 2 });
    expect(index.find('Parser')[0]).toMatchObject({ name: 'Parser', path: 'main.py', line: 1 });
    // Файл другого языка в карту не попал: объявлений в CSS нет, а сервера — тоже.
    expect(index.find('zzz')).toEqual([]);
  });

  it('предков берёт из текста: сервер их не сообщает', async () => {
    const root = project({ 'main.py': 'class Parser(Base):\n    def run(self):\n        pass\n' });
    const { outline } = fakeOutline({ 'main.py': parserSkeleton });
    const index = new SymbolIndexer({ root: () => root, outline, store: new SymbolStore(path.join(root, '.idx')) });

    index.refresh();
    await index.settled();

    const stored = await new SymbolStore(path.join(root, '.idx')).load(root);
    expect(stored[0]?.decls[0]?.bases).toEqual(['Base']);
  });

  it('второй раз разбирает только изменившийся файл', async () => {
    const root = project({ 'a.py': 'x = 1\n', 'b.py': 'y = 2\n' });
    const first = fakeOutline({ 'a.py': parserSkeleton, 'b.py': parserSkeleton });
    const store = new SymbolStore(path.join(root, '.idx'));

    const index = new SymbolIndexer({ root: () => root, outline: first.outline, store });
    index.refresh();
    await index.settled();
    expect(first.asked).toHaveLength(2);

    // Новый сборщик — как после перезапуска: карта читается с диска, файлы не менялись.
    const second = fakeOutline({ 'a.py': parserSkeleton, 'b.py': parserSkeleton });
    const restarted = new SymbolIndexer({ root: () => root, outline: second.outline, store });
    restarted.refresh();
    await restarted.settled();
    expect(second.asked).toEqual([]);
    expect(restarted.status()).toMatchObject({ files: 2, decls: 4 });

    // Правим один файл — в сервер уходит только он.
    writeFileSync(path.join(root, 'b.py'), 'y = 3\n', 'utf8');
    const third = fakeOutline({ 'a.py': parserSkeleton, 'b.py': parserSkeleton });
    const reopened = new SymbolIndexer({ root: () => root, outline: third.outline, store });
    reopened.refresh();
    await reopened.settled();
    expect(third.asked).toEqual(['b.py']);
  });

  it('молчание сервера не кэшируется: файл спросят снова', async () => {
    const root = project({ 'a.py': 'x = 1\n' });
    const store = new SymbolStore(path.join(root, '.idx'));

    const silent = fakeOutline({ 'a.py': null });
    const first = new SymbolIndexer({ root: () => root, outline: silent.outline, store });
    first.refresh();
    await first.settled();
    expect(first.status()).toMatchObject({ files: 0, skipped: 1 });
    expect(await store.load(root)).toEqual([]);
  });

  it('смена проекта не оставляет чужих объявлений', async () => {
    const one = project({ 'a.py': 'x = 1\n' });
    const two = project({ 'b.py': 'y = 2\n' });
    let root = one;
    const { outline } = fakeOutline({ 'a.py': parserSkeleton, 'b.py': parserSkeleton });
    const index = new SymbolIndexer({ root: () => root, outline, store: new SymbolStore(path.join(one, '.idx')) });

    index.refresh();
    await index.settled();
    expect(index.find('Parser').map((hit) => hit.path)).toEqual(['a.py']);

    root = two;
    index.refresh();
    await index.settled();
    expect(index.find('Parser').map((hit) => hit.path)).toEqual(['b.py']);
    expect(index.status().root).toBe(two);
  });

  it('без проекта карта пуста, а не «готова»', async () => {
    const { outline } = fakeOutline({});
    const index = new SymbolIndexer({ root: () => null, outline, store: new SymbolStore(path.join(tmpdir(), 'nope')) });
    index.refresh();
    await index.settled();
    expect(index.status()).toMatchObject({ phase: 'idle', root: null, files: 0 });
  });
});

describe('порядок разбора', () => {
  it('точки входа и обычный код раньше тестов, чужие языки — прочь', () => {
    const files = ['tests/test_a.py', 'src/parser.py', 'main.py', 'style.css', 'b.test.ts'];
    expect(orderFiles(files)).toEqual(['main.py', 'src/parser.py', 'tests/test_a.py', 'b.test.ts']);
  });
});

describe('кэш карты на диске', () => {
  it('путь кэша свой у каждого корня и узнаваемый', () => {
    const dir = path.join(tmpdir(), 'chui-index-files');
    const one = indexFilePath(dir, path.join(tmpdir(), 'proj'));
    const two = indexFilePath(dir, path.join(tmpdir(), 'other'));

    expect(one).not.toBe(two);
    expect(path.dirname(one)).toBe(dir);
    expect(path.basename(one)).toMatch(/-[0-9a-f]{16}\.json$/);
  });

  it('битый файл читается как пустая карта, а не падает', async () => {
    const root = project({ 'a.py': 'x = 1\n' });
    const dir = path.join(root, '.idx');
    const store = new SymbolStore(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(store.fileFor(root), '{это не json', 'utf8');

    expect(await store.load(root)).toEqual([]);
  });
});
