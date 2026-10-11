import { describe, expect, it } from 'vitest';
import { lineChanges } from '../src/shared/git-line-changes';

const kinds = (text: string): string[] => lineChanges('', text).map((change) => change.kind);

describe('lineChanges', () => {
  it('одинаковые версии — изменений нет', () => {
    expect(lineChanges('a\nb\nc\n', 'a\nb\nc\n')).toEqual([]);
    expect(lineChanges('', '')).toEqual([]);
  });

  it('новый файл (нет HEAD) — все строки добавлены', () => {
    expect(lineChanges('', 'a\nb\n')).toEqual([
      { line: 1, kind: 'added' },
      { line: 2, kind: 'added' },
    ]);
    expect(kinds('a\nb\n')).toEqual(['added', 'added']);
  });

  it('строка в начале', () => {
    expect(lineChanges('b\nc\n', 'a\nb\nc\n')).toEqual([{ line: 1, kind: 'added' }]);
  });

  it('строка в середине', () => {
    expect(lineChanges('a\nc\n', 'a\nb\nc\n')).toEqual([{ line: 2, kind: 'added' }]);
  });

  it('строка в конце', () => {
    expect(lineChanges('a\nb\n', 'a\nb\nc\n')).toEqual([{ line: 3, kind: 'added' }]);
  });

  it('изменение строки — это «изменено», а не «удалил и добавил»', () => {
    expect(lineChanges('a\nb\nc\n', 'a\nB\nc\n')).toEqual([{ line: 2, kind: 'modified' }]);
  });

  it('удаление строки в середине — полоска на строке перед пропуском', () => {
    expect(lineChanges('a\nb\nc\n', 'a\nc\n')).toEqual([{ line: 1, kind: 'deleted' }]);
  });

  it('удаление строки в начале', () => {
    expect(lineChanges('x\na\n', 'a\n')).toEqual([{ line: 1, kind: 'deleted' }]);
  });

  it('несколько блоков сразу, каждый на своей строке', () => {
    const before = 'one\ntwo\nthree\nfour\n';
    const after = 'one\nTWO\nthree\nfour\nfive\n';
    expect(lineChanges(before, after)).toEqual([
      { line: 2, kind: 'modified' },
      { line: 5, kind: 'added' },
    ]);
  });

  it('заменённый блок строк — изменённые строки', () => {
    const result = lineChanges('a\nb\nc\nd\n', 'a\nX\nY\nZ\nd\n');
    expect(result.map((change) => change.line)).toEqual([2, 3, 4]);
    expect(result.every((change) => change.kind === 'modified')).toBe(true);
  });

  it('полностью переписанный файл — все строки изменены', () => {
    const result = lineChanges('a\nb\n', 'x\ny\nz\n');
    expect(result.map((change) => change.line)).toEqual([1, 2, 3]);
    expect(result.every((change) => change.kind === 'modified')).toBe(true);
  });

  it('номера строк 1-based и в порядке возрастания', () => {
    const result = lineChanges('a\n', 'a\nb\nc\n');
    expect(result.map((change) => change.line)).toEqual([2, 3]);
  });

  it('удаление всех строк даёт одну метку удаления', () => {
    expect(lineChanges('a\nb\nc\n', '')).toEqual([{ line: 1, kind: 'deleted' }]);
  });

  it('инверсия меняет местами добавление и удаление', () => {
    const added = lineChanges('a\nc\n', 'a\nb\nc\n');
    const removed = lineChanges('a\nb\nc\n', 'a\nc\n');
    expect(added).toEqual([{ line: 2, kind: 'added' }]);
    expect(removed).toEqual([{ line: 1, kind: 'deleted' }]);
  });
});
