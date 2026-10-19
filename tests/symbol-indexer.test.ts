import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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

/** Имена файлов из выдачи: `find` отдаёт абсолютные пути — так по ним открывается файл. */
function names(hits: readonly { path: string }[]): string[] {
  return hits.map((hit) => path.basename(hit.path));
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Дождаться условия: разбор сохранённого файла идёт по таймеру, а не сразу. */
async function waitFor(done: () => boolean, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('условие не наступило');
    await wait(20);
  }
}

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
    expect(index.find('Parser')[0]).toMatchObject({ name: 'Parser', path: path.join(root, 'main.py'), line: 1 });
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
    expect(names(index.find('Parser'))).toEqual(['a.py']);

    root = two;
    index.refresh();
    await index.settled();
    expect(names(index.find('Parser'))).toEqual(['b.py']);
    expect(index.status().root).toBe(two);
  });

  it('без проекта карта пуста, а не «готова»', async () => {
    const { outline } = fakeOutline({});
    const index = new SymbolIndexer({ root: () => null, outline, store: new SymbolStore(path.join(tmpdir(), 'nope')) });
    index.refresh();
    await index.settled();
    expect(index.status()).toMatchObject({ phase: 'idle', root: null, files: 0 });
  });

  it('сохранённый файл перечитывается, остальные не трогаются', async () => {
    const root = project({ 'a.py': 'class Old:\n    pass\n', 'b.py': 'y = 2\n' });
    // Скелет зависит от текста файла: так видно, что перечитался именно новый текст.
    const outline = async (target: string): Promise<readonly FileSymbol[] | null> => [
      { ...parserSkeleton[0]!, name: readFileSync(target, 'utf8').includes('class New') ? 'New' : 'Old' },
    ];
    const target = path.join(root, 'a.py');
    // Время файла ставим сами и ЗАРАНЕЕ: так правка ниже выйдет того же размера и с тем
    // же временем, что карта уже видела. Именно так выглядит быстрое сохранение (а на
    // файловой системе с грубым временем — любое), и по отпечатку «размер + время» его
    // не отличить от «не менялось». Карта обязана перечитать файл: о правке ей сказали
    // прямо. Стережёт от потери сохранения — на CI это ловилось случайно, когда файл
    // успевал измениться в ту же миллисекунду.
    const stamp = new Date(2020, 0, 1);
    utimesSync(target, stamp, stamp);

    const index = new SymbolIndexer({ root: () => root, outline, store: new SymbolStore(path.join(root, '.idx')) });

    index.refresh();
    await index.settled();
    expect(names(index.find('Old'))).toEqual(['a.py', 'b.py']);

    const was = statSync(target);
    writeFileSync(target, 'class New:\n    pass\n', 'utf8');
    utimesSync(target, stamp, stamp);
    const now = statSync(target);
    expect(now.size).toBe(was.size);
    expect(now.mtimeMs).toBe(was.mtimeMs);

    index.noteChanged(target);
    await waitFor(() => index.find('New').length > 0);

    expect(names(index.find('New'))).toEqual(['a.py']);
    expect(names(index.find('Old'))).toEqual(['b.py']);
  });

  it('удалённый файл уходит из карты', async () => {
    const root = project({ 'a.py': 'x = 1\n' });
    const { outline } = fakeOutline({ 'a.py': parserSkeleton });
    const index = new SymbolIndexer({ root: () => root, outline, store: new SymbolStore(path.join(root, '.idx')) });

    index.refresh();
    await index.settled();
    expect(index.find('Parser')).toHaveLength(1);

    rmSync(path.join(root, 'a.py'));
    index.noteChanged(path.join(root, 'a.py'));
    await waitFor(() => index.find('Parser').length === 0);
  });

  it('объявления зависимостей попадают в карту, но ниже своих', async () => {
    const root = project({
      'app.py': 'class Saved:\n    pass\n',
      'node_modules/lib/index.d.ts': 'export declare class Saved {}\nexport declare function libOnly(): void;\n',
    });
    // Скелет по языку: так же отвечает сервер — объявления из текста файла.
    const outline = async (target: string, language: string): Promise<readonly FileSymbol[]> => {
      const text = readFileSync(target, 'utf8');
      const names = [...text.matchAll(/(?:class|function)\s+(\w+)/g)].map((match) => match[1]!);
      return names.map((name) => ({
        name,
        kind: language === 'python' ? 'класс' : 'класс',
        line: 1,
        endLine: 1,
        children: [],
      }));
    };
    const dirs: string[][] = [];
    const index = new SymbolIndexer({
      root: () => root,
      outline,
      store: new SymbolStore(path.join(root, '.idx')),
      onDependencyDirs: (list) => dirs.push([...list]),
    });

    index.refresh();
    await index.settled();

    expect(index.status()).toMatchObject({ files: 2, dependencyFiles: 1, dependencyPackages: 1 });
    // Одноимённое своё объявление идёт первым: `Saved` есть и в пакете, и в проекте.
    expect(names(index.find('Saved'))).toEqual(['app.py', 'index.d.ts']);
    const [lib] = index.find('libOnly');
    expect(lib).toMatchObject({ name: 'libOnly', origin: 'dependency', package: 'lib' });
    // Каталог зависимости назван рабочей папке: оттуда файл можно открыть.
    expect(dirs[0]).toEqual([path.join(root, 'node_modules', 'lib')]);
  });

  it('что умеет тип: по карте, без сервера, с абсолютными путями', async () => {
    const root = project({
      'base.py': 'class Base:\n    def reset(self):\n        pass\n',
      'app.py': 'class Parser(Base):\n    def run(self):\n        pass\n',
    });
    const skeletons: Record<string, FileSymbol[]> = {
      'base.py': [
        {
          name: 'Base',
          kind: 'класс',
          line: 1,
          endLine: 3,
          children: [{ name: 'reset', kind: 'метод', line: 2, endLine: 3, children: [] }],
        },
      ],
      'app.py': [
        {
          name: 'Parser',
          kind: 'класс',
          line: 1,
          endLine: 3,
          children: [{ name: 'run', kind: 'метод', line: 2, endLine: 3, children: [] }],
        },
      ],
    };
    const index = new SymbolIndexer({
      root: () => root,
      outline: async (target) => skeletons[path.basename(target)] ?? [],
      store: new SymbolStore(path.join(root, '.idx')),
    });

    index.refresh();
    await index.settled();

    const result = index.inherited('Parser');
    expect(result.ancestors).toEqual(['Base']);
    expect(result.members.map((member) => `${member.from}:${member.name}`)).toEqual(['Parser:run', 'Base:reset']);
    expect(result.declared?.path).toBe(path.join(root, 'app.py'));
    expect(result.members.every((member) => path.isAbsolute(member.path))).toBe(true);
  });

  it('чужой язык и путь вне проекта — не наше дело', async () => {
    const root = project({ 'a.py': 'x = 1\n' });
    const { outline, asked } = fakeOutline({ 'a.py': parserSkeleton });
    const index = new SymbolIndexer({ root: () => root, outline, store: new SymbolStore(path.join(root, '.idx')) });

    index.refresh();
    await index.settled();
    asked.length = 0;

    writeFileSync(path.join(root, 'style.css'), 'a{}', 'utf8');
    index.noteChanged(path.join(root, 'style.css'));
    index.noteChanged(path.join(root, '..', 'outside.py'));
    await wait(400);

    // Сервер не звали ни разу: ни стили, ни файл вне корня в карту не входят.
    expect(asked).toEqual([]);
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
