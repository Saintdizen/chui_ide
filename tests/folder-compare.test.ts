import { describe, expect, it } from 'vitest';
import { buildFolderDiff, splitFolderLists } from '../src/shared/folder-compare';

/**
 * Сравнение двух папок: разбор списков относительных путей и сборка различий.
 * Порядок результата — по пути: список должен читаться как оглавление, а не как
 * порядок обхода диска (он у двух папок разный).
 */
describe('splitFolderLists', () => {
  it('раскладывает пути на «только слева», «только справа» и общие', () => {
    const lists = splitFolderLists(['a.ts', 'b.ts', 'dir/c.ts'], ['a.ts', 'dir/d.ts']);
    expect(lists.leftOnly).toEqual(['b.ts', 'dir/c.ts']);
    expect(lists.rightOnly).toEqual(['dir/d.ts']);
    expect(lists.common).toEqual(['a.ts']);
  });

  it('повторы в списке не дают двойных записей', () => {
    const lists = splitFolderLists(['a.ts', 'a.ts'], []);
    expect(lists.leftOnly).toEqual(['a.ts']);
  });

  it('две пустые папки — различий нет', () => {
    const lists = splitFolderLists([], []);
    expect(lists).toEqual({ leftOnly: [], rightOnly: [], common: [] });
  });
});

describe('buildFolderDiff', () => {
  it('слева-только — удалён, справа-только — добавлен, общие решает содержимое', () => {
    const lists = splitFolderLists(['gone.ts', 'same.ts', 'diff.ts'], ['fresh.ts', 'same.ts', 'diff.ts']);
    const result = buildFolderDiff(lists, (path) => path === 'diff.ts');
    expect(result.files).toEqual([
      { path: 'diff.ts', change: 'modified' },
      { path: 'fresh.ts', change: 'added' },
      { path: 'gone.ts', change: 'deleted' },
    ]);
    expect(result.identical).toBe(1);
  });

  it('совпавшие по содержимому считаются, но в список не идут', () => {
    const lists = splitFolderLists(['a.ts', 'b.ts'], ['a.ts', 'b.ts']);
    const result = buildFolderDiff(lists, () => false);
    expect(result.files).toEqual([]);
    expect(result.identical).toBe(2);
  });
});
