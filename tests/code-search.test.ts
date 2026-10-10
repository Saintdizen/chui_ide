import { describe, expect, it } from 'vitest';
import {
  digestHits,
  formatCodeSearch,
  rankSymbolName,
  rankSymbols,
  splitWords,
  type SearchSymbol,
} from '../src/shared/code-search';

const symbol = (over: Partial<SearchSymbol>): SearchSymbol => ({
  name: 'readFile',
  kind: 'функция',
  container: null,
  path: 'src/main/ai/agent-tools.ts',
  line: 10,
  column: 1,
  ...over,
});

/**
 * Ранжирование — суть инструмента: от него зависит, увидит модель место
 * объявления или шум из упоминаний. Поэтому проверяем именно порядок, а не
 * наличие: «нашли хоть что-то» здесь недостаточно.
 */
describe('splitWords', () => {
  it('разбивает camelCase и PascalCase', () => {
    expect(splitWords('readFile')).toEqual(['read', 'file']);
    expect(splitWords('HTTPServer')).toEqual(['http', 'server']);
    expect(splitWords('parseToolArguments')).toEqual(['parse', 'tool', 'arguments']);
  });

  it('разделители и кириллица', () => {
    expect(splitWords('read_file')).toEqual(['read', 'file']);
    expect(splitWords('git.diff')).toEqual(['git', 'diff']);
    expect(splitWords('чтение')).toEqual(['чтение']);
  });
});

describe('rankSymbolName', () => {
  it('точное совпадение лучше начала имени', () => {
    expect(rankSymbolName('readFile', 'readFile')).toBeLessThan(rankSymbolName('readFileSync', 'readFile')!);
  });

  it('начало имени лучше вхождения подстроки', () => {
    expect(rankSymbolName('readFileSync', 'readFile')).toBeLessThan(rankSymbolName('asyncReadFileHelper', 'readFile')!);
  });

  it('совпадение по словам лучше простого вхождения', () => {
    // «read file» → readFile (оба слова в имени) против misreadFiles, где read —
    // лишь часть слова misread: такому имени место ниже.
    expect(rankSymbolName('readFile', 'read file')).toBeLessThan(rankSymbolName('misreadFiles', 'read file')!);
  });

  it('регистр запроса не важен', () => {
    expect(rankSymbolName('WorkspaceSearch', 'workspacesearch')).toBe(0);
  });

  it('чужое имя не подходит', () => {
    expect(rankSymbolName('writeFile', 'readFile')).toBeNull();
    expect(rankSymbolName('readFile', '   ')).toBeNull();
  });
});

describe('rankSymbols', () => {
  const symbols: SearchSymbol[] = [
    symbol({ name: 'readFileContent', path: 'b.ts', line: 5 }),
    symbol({ name: 'readFile', path: 'a.ts', line: 42 }),
    symbol({ name: 'readFiles', kind: 'функция', path: 'a.ts', line: 70 }),
    symbol({ name: 'writeFile', path: 'c.ts', line: 1 }),
  ];

  it('точное совпадение идёт первым, чужое имя отброшено', () => {
    const ranked = rankSymbols(symbols, 'readFile', 10);
    expect(ranked.map((item) => item.name)).toEqual(['readFile', 'readFiles', 'readFileContent']);
  });

  it('порядок устойчив: короткое имя раньше при равной точности', () => {
    const same: SearchSymbol[] = [
      symbol({ name: 'readFiles', path: 'a.ts', line: 70 }),
      symbol({ name: 'readFileX', path: 'a.ts', line: 10 }),
    ];
    expect(rankSymbols(same, 'readFile', 10).map((item) => item.name)).toEqual(['readFileX', 'readFiles']);
  });

  it('предел соблюдается', () => {
    expect(rankSymbols(symbols, 'read', 2)).toHaveLength(2);
  });

  it('пустой запрос не находит ничего', () => {
    expect(rankSymbols(symbols, '  ', 10)).toEqual([]);
  });
});

describe('digestHits', () => {
  it('сводит совпадения по файлу и берёт первое по строке', () => {
    const digest = digestHits(
      [
        { path: 'b.ts', line: 90, text: ' readFile(x)' },
        { path: 'a.ts', line: 336, text: ' readFile(y)' },
        { path: 'a.ts', line: 12, text: ' const readFile = 1;' },
      ],
      10,
    );

    expect(digest).toHaveLength(2);
    expect(digest[0]).toEqual({
      path: 'a.ts',
      count: 2,
      line: 12,
      first: 'const readFile = 1;',
    });
    expect(digest[1].path).toBe('b.ts');
  });

  it('порядок при равном числе совпадений — по пути', () => {
    const digest = digestHits(
      [
        { path: 'b.ts', line: 1, text: 'x' },
        { path: 'a.ts', line: 1, text: 'x' },
      ],
      10,
    );
    expect(digest.map((file) => file.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('предел соблюдается и пустой список не ломает', () => {
    expect(digestHits([{ path: 'a.ts', line: 1, text: 'x' }], 0)).toEqual([]);
    expect(digestHits([], 10)).toEqual([]);
  });
});

describe('formatCodeSearch', () => {
  const base = { query: 'readFile', symbols: [], files: [], symbolTotal: 0, hitTotal: 0, scanned: 0, truncated: false };

  it('ничего не найдено — так и говорим, без выдумок', () => {
    const { summary, detail } = formatCodeSearch({ ...base, symbolsAvailable: true });
    expect(summary).toBe('«readFile»: ничего не найдено');
    expect(detail).toContain('Объявлений с таким именем не нашлось');
  });

  it('без языкового сервера честно предупреждаем, что искали текстом', () => {
    const { detail } = formatCodeSearch({
      ...base,
      symbolsAvailable: false,
      files: [{ path: 'a.ts', count: 3, line: 5, first: 'readFile(x)' }],
      hitTotal: 3,
    });
    expect(detail).toContain('Языковой сервер не подключён');
    expect(detail).toContain('Где встречается:');
    expect(detail).toContain('a.ts — совпадений: 3, первое на строке 5');
  });

  it('символ показывает вид, контейнер и место', () => {
    const { summary, detail } = formatCodeSearch({
      ...base,
      symbolsAvailable: true,
      symbols: [symbol({ name: 'diffText', kind: 'метод', container: 'GitService', path: 'git.ts', line: 162 })],
      symbolTotal: 1,
    });
    expect(summary).toBe('«readFile»: объявлений 1, файлов с совпадениями 0');
    expect(detail).toContain('git.ts:162 — метод diffText (в GitService)');
  });

  it('обрезанный список помечен', () => {
    const { detail } = formatCodeSearch({
      ...base,
      symbolsAvailable: true,
      symbols: [symbol({})],
      symbolTotal: 500,
      truncated: true,
    });
    expect(detail).toContain('Список обрезан');
  });
});
