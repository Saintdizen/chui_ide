/**
 * П.30: поиск сразу по обоим файлам сравнения.
 *
 * Ряды сравнения не равны двум текстам: в ряду `replace` слева и справа лежат
 * разные строки, а у `insert`/`delete` одной стороны нет вовсе. Тесты держат
 * именно эти случаи — на них наивный поиск по строке файла ошибается.
 */
import { describe, expect, it } from 'vitest';
import type { DiffRow } from '../src/renderer/editor/host/diff-model';
import { nextHit, searchDiff } from '../src/renderer/core/diff-search';

const row = (kind: DiffRow['kind'], o: number | null, m: number | null, ot: string, mt: string): DiffRow => ({
  kind,
  originalLine: o,
  modifiedLine: m,
  originalText: ot,
  modifiedText: mt,
});

const rows: DiffRow[] = [
  row('equal', 1, 1, 'const a = 1;', 'const a = 1;'),
  row('replace', 2, 2, 'let name = "старое";', 'let name = "новое";'),
  row('delete', 3, null, 'name = name.trim();', ''),
  row('insert', null, 3, '', 'name = name.toLowerCase();'),
];

describe('поиск по обеим сторонам сравнения', () => {
  it('пустой запрос ничего не находит', () => {
    const result = searchDiff(rows, '');
    expect(result.hits).toEqual([]);
    expect(result.both).toBe(false);
  });

  it('считает стороны отдельно и говорит, есть ли в обеих', () => {
    const result = searchDiff(rows, 'name');
    expect(result.both).toBe(true);
    // Считаются вхождения, а не строки: слева 1 + 2 = 3 (в удалённой строке
    // «name = name.trim()» два), справа 1 + 2 = 3 (в «name = name.toLowerCase()»
    // тоже два). Число попаданий при этом 4 — по одному на строку.
    expect(result.original).toBe(3);
    expect(result.modified).toBe(3);
    expect(result.hits.map((hit) => `${hit.side}:${hit.line}`)).toEqual([
      'original:2',
      'original:3',
      'modified:2',
      'modified:3',
    ]);
  });

  it('есть только справа — это не «в обоих файлах»', () => {
    const result = searchDiff(rows, 'toLowerCase');
    expect(result.original).toBe(0);
    expect(result.modified).toBe(1);
    expect(result.both).toBe(false);
  });

  it('вхождения в строке не перекрываются', () => {
    const once = searchDiff([row('equal', 1, 1, 'ааа', 'ааа')], 'аа');
    expect(once.original).toBe(1);
    expect(once.modified).toBe(1);
  });

  it('регистр по умолчанию не важен, а по флагу — важен', () => {
    const relaxed = searchDiff(rows, 'NAME');
    expect(relaxed.original).toBe(3);
    const strict = searchDiff(rows, 'NAME', { caseSensitive: true });
    expect(strict.hits).toEqual([]);
  });

  it('переход по кругу в обе стороны', () => {
    const hits = searchDiff(rows, 'name').hits;
    expect(nextHit(hits, -1, 1)).toBe(0);
    expect(nextHit(hits, hits.length - 1, 1)).toBe(0);
    expect(nextHit(hits, 0, -1)).toBe(hits.length - 1);
    expect(nextHit([], 0, 1)).toBe(-1);
  });
});
