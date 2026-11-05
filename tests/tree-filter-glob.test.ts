import { describe, expect, it } from 'vitest';
import {
  countMatches,
  filterTreePaths,
  matchName,
  withNestedHosts,
  type NestedRowInfo,
  matchesName,
  parseFilterQuery,
  type FilterRow,
} from '../src/renderer/core/tree-filter';

/**
 * Фильтр дерева: шаблоны и несколько слов.
 *
 * Без шаблонов искали только подстроку — на `*.test.ts` дерево оставляло пустой
 * экран, хотя совпадения есть. И одно слово — тоже тесно: помнишь куски имени
 * (`button ts`), а не имя целиком, и получаешь или всё, или ничего.
 */

const row = (path: string): FilterRow => {
  const cut = path.lastIndexOf('/');
  return { path, name: cut < 0 ? path : path.slice(cut + 1), parent: cut < 0 ? '' : path.slice(0, cut) };
};

const rows: FilterRow[] = [
  row('src'),
  row('src/button.ts'),
  row('src/button.test.ts'),
  row('src/util'),
  row('src/util/format.ts'),
  row('docs'),
  row('docs/readme.md'),
];

const kept = (query: string): string[] => [...filterTreePaths(rows, query)].sort();

describe('шаблоны в запросе', () => {
  it('`*` — любая часть имени, сравнение по всей строке', () => {
    expect(matchesName('button.test.ts', '*.test.ts')).toBe(true);
    expect(matchesName('button.ts', '*.test.ts')).toBe(false);
    // Без шаблона это была бы подстрока и нашла бы оба.
    expect(matchesName('button.test.ts', '.test.')).toBe(true);
  });

  it('`?` — ровно один символ', () => {
    expect(matchesName('util', 'util?')).toBe(false);
    expect(matchesName('utils', 'util?')).toBe(true);
    expect(matchesName('utils', 'u?ils')).toBe(true);
  });

  it('`*` в середине и в начале', () => {
    expect(matchesName('button.test.ts', 'button*ts')).toBe(true);
    expect(matchesName('button.test.ts', '*.test.*')).toBe(true);
  });

  it('шаблонное слово в дереве оставляет найденное и его предков', () => {
    expect(kept('*.test.ts')).toEqual(['src', 'src/button.test.ts']);
  });

  it('два шаблона — оба обязательны', () => {
    expect(matchesName('button.test.ts', '*.test.* *.ts')).toBe(true);
    expect(matchesName('button.test.ts', '*.test.ts *.md')).toBe(false);
  });
});

describe('несколько слов в любом порядке', () => {
  it('порядок слов не важен', () => {
    expect(matchesName('button.ts', 'ts button')).toBe(true);
    expect(matchesName('button.ts', 'button ts')).toBe(true);
  });

  it('лишние пробелы не мешают и не создают пустых слов', () => {
    expect(parseFilterQuery('  button   ts ').map((token) => token.text)).toEqual(['button', 'ts']);
    expect(matchesName('button.ts', '  button   ts ')).toBe(true);
  });

  it('не хватает одного слова — не совпало', () => {
    expect(matchesName('button.ts', 'button md')).toBe(false);
  });

  it('дерево: `ts format` оставляет только то, где есть оба слова', () => {
    expect(kept('ts format')).toEqual(['src', 'src/util', 'src/util/format.ts']);
  });
});

describe('что подсветить', () => {
  it('слово без шаблона — все его вхождения', () => {
    // `tt` в `button-title` одно: в конце `t` и `i` — уже не пара.
    expect(matchName('button-title', 'tt').ranges).toEqual([[2, 4]]);
  });

  it('шаблон подсвечивает свои символы, `*` — ничего', () => {
    // button.test.ts: совпали 't' перед 'est'... точнее всё, кроме того, что съел `*`.
    expect(matchName('main.test.ts', '*.test.ts').ranges).toEqual([[4, 12]]);
  });

  it('пустой запрос ничего не подсвечивает и совпадает со всем', () => {
    expect(matchName('button.ts', '   ')).toEqual({ matched: true, ranges: [] });
  });

  it('при промахе диапазонов нет — нечего рисовать', () => {
    expect(matchName('button.ts', 'zzz').ranges).toEqual([]);
  });
});

describe('счёт совпадений с шаблонами', () => {
  it('считает строки, а не предков', () => {
    expect(countMatches(rows, '*.test.ts')).toBe(1);
    expect(countMatches(rows, 'ts')).toBe(3);
  });
});

describe('вложенность не рвётся фильтром', () => {
  /** Папка src: хозяин Button.tsx и его спутники. */
  const rows: NestedRowInfo[] = [
    { path: 'src', nested: false, dir: '', depth: 0 },
    { path: 'src/Button.tsx', nested: false, dir: 'src', depth: 1 },
    { path: 'src/Button.test.tsx', nested: true, dir: 'src', depth: 2 },
    { path: 'src/Button.css', nested: true, dir: 'src', depth: 2 },
    { path: 'src/other.ts', nested: false, dir: 'src', depth: 1 },
  ];

  it('совпал спутник — хозяин едет с ним', () => {
    const keep = withNestedHosts(rows, new Set(['src', 'src/Button.test.tsx']));
    // Иначе спутник висел бы с отступом под пустотой.
    expect(keep.has('src/Button.tsx')).toBe(true);
  });

  it('совпал хозяин — спутники остаются: они часть его строки', () => {
    const keep = withNestedHosts(rows, new Set(['src', 'src/Button.tsx']));
    expect(keep.has('src/Button.test.tsx')).toBe(true);
    expect(keep.has('src/Button.css')).toBe(true);
  });

  it('чужая строка не притягивается', () => {
    const keep = withNestedHosts(rows, new Set(['src', 'src/Button.tsx']));
    expect(keep.has('src/other.ts')).toBe(false);
  });

  it('входной набор не меняется', () => {
    const original = new Set(['src/Button.test.tsx']);
    withNestedHosts(rows, original);
    expect([...original]).toEqual(['src/Button.test.tsx']);
  });
});
