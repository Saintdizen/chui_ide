import { describe, expect, it } from 'vitest';
import {
  combineMeaning,
  meaningRegex,
  meaningTerms,
  scoreText,
  type MeaningLine,
  type MeaningSymbol,
} from '../src/shared/meaning-search';

const symbol = (over: Partial<MeaningSymbol>): MeaningSymbol => ({
  name: 'readFile',
  kind: 'функция',
  container: null,
  path: 'src/a.ts',
  line: 42,
  column: 1,
  ...over,
});

describe('meaningTerms', () => {
  it('разбивает запрос на слова, включая CamelCase', () => {
    expect(meaningTerms('read file')).toEqual(['read', 'file']);
    expect(meaningTerms('readFile')).toEqual(['read', 'file']);
    expect(meaningTerms('  git.diff  ')).toEqual(['git', 'diff']);
  });

  it('кириллица не теряется', () => {
    expect(meaningTerms('чтение файла')).toEqual(['чтение', 'файла']);
  });

  it('пустой запрос — нет слов', () => {
    expect(meaningTerms('   ')).toEqual([]);
  });
});

describe('scoreText', () => {
  it('слово целиком весит больше вхождения внутри слова', () => {
    expect(scoreText('read', ['read'])).toBeGreaterThan(scoreText('reading', ['read']));
  });

  it('строка со всеми словами получает надбавку', () => {
    // «read file» — оба слова целиком; «read only» — только одно.
    expect(scoreText('const readFile = 1;', ['read', 'file'])).toBeGreaterThan(
      scoreText('read only', ['read', 'file']),
    );
  });

  it('ни одного слова — ноль', () => {
    expect(scoreText('write output', ['read', 'file'])).toBe(0);
  });

  it('пустой список слов — ноль', () => {
    expect(scoreText('readFile', [])).toBe(0);
  });
});

describe('meaningRegex', () => {
  it('слова запроса — через «или»', () => {
    expect(meaningRegex('read file')).toBe('read|file');
  });

  it('спецсимволы экранируются: слово — литерал, а не шаблон', () => {
    expect(meaningRegex('a+b')).toBe('a|b');
    expect(meaningRegex('$x')).toBe('x');
  });

  it('пустой запрос не превращается в пустую регулярку', () => {
    expect(meaningRegex('   ')).toBe('');
  });
});

describe('combineMeaning', () => {
  it('символы идут впереди текста, точное имя — первым', () => {
    const hits = combineMeaning(
      [symbol({ name: 'readFiles', line: 70 }), symbol({ name: 'readFile', line: 42 })],
      [{ path: 'b.ts', line: 5, text: 'read file helper' }],
      'readFile',
      10,
    );
    expect(hits[0]).toMatchObject({ kind: 'symbol', label: 'readFile' });
    expect(hits[1]).toMatchObject({ kind: 'symbol', label: 'readFiles' });
    expect(hits[2]).toMatchObject({ kind: 'text', path: 'b.ts' });
  });

  it('строка на позиции символа отбрасывается: имя говорит больше', () => {
    const hits = combineMeaning(
      [symbol({ name: 'readFile', path: 'a.ts', line: 42 })],
      [{ path: 'a.ts', line: 42, text: 'const readFile = makeReader()' }],
      'readFile',
      10,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe('symbol');
  });

  it('повторы одной строки схлопываются', () => {
    const lines: MeaningLine[] = [
      { path: 'a.ts', line: 5, text: 'read file' },
      { path: 'a.ts', line: 5, text: 'read file' },
    ];
    expect(combineMeaning([], lines, 'read file', 10)).toHaveLength(1);
  });

  it('текстовые строки упорядочены по числу слов запроса', () => {
    const hits = combineMeaning(
      [],
      [
        { path: 'a.ts', line: 1, text: 'reading files' },
        { path: 'b.ts', line: 2, text: 'read file here' },
      ],
      'read file',
      10,
    );
    expect(hits.map((hit) => hit.path)).toEqual(['b.ts', 'a.ts']);
  });

  it('предел соблюдается', () => {
    const symbols = [symbol({ name: 'readFile' }), symbol({ name: 'readFiles', line: 70 })];
    expect(combineMeaning(symbols, [], 'readFile', 1)).toHaveLength(1);
  });

  it('пустой запрос не находит ничего', () => {
    expect(combineMeaning([symbol({})], [{ path: 'a.ts', line: 1, text: 'readFile' }], '   ', 10)).toEqual([]);
  });

  it('чужое имя символа в ответ не попадает', () => {
    const hits = combineMeaning([symbol({ name: 'writeFile' })], [], 'readFile', 10);
    expect(hits).toEqual([]);
  });
});
