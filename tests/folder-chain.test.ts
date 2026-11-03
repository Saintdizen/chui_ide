import { describe, expect, it } from 'vitest';
import type { DirEntry } from '../src/shared/api';
import { chainDepth, folderChain } from '../src/renderer/core/folder-chain';

const dir = (path: string): DirEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  kind: 'directory',
  size: 0,
  mtimeMs: 0,
});
const file = (path: string): DirEntry => ({ ...dir(path), kind: 'file' });

const map = (...lists: DirEntry[][]): Map<string, DirEntry[]> => {
  const result = new Map<string, DirEntry[]>();
  for (const list of lists) {
    if (list.length > 0) result.set(list[0]!.path.slice(0, list[0]!.path.lastIndexOf('/')), list);
  }
  return result;
};

/**
 * Свёрнутые цепочки папок. Правило одно и жёсткое: склеиваем только пока в папке
 * ровно одна запись и это папка. Файл обрывает цепочку — иначе `src/index.ts` и
 * `src/utils/` слились бы в бессмысленное `src/index.ts/utils`.
 */
describe('folderChain', () => {
  it('цепочка из трёх папок склеивается в одну подпись', () => {
    const children = new Map<string, DirEntry[]>([
      ['/p/a', [dir('/p/a/b')]],
      ['/p/a/b', [dir('/p/a/b/c')]],
      ['/p/a/b/c', [file('/p/a/b/c/x.ts')]],
    ]);
    expect(folderChain(dir('/p/a'), children)).toMatchObject({ label: 'a/b/c', path: '/p/a/b/c' });
  });

  it('файл в папке обрывает цепочку', () => {
    const children = new Map<string, DirEntry[]>([['/p/a', [dir('/p/a/b'), file('/p/a/index.ts')]]]);
    expect(folderChain(dir('/p/a'), children)).toMatchObject({ label: 'a', path: '/p/a' });
  });

  it('непрочитанная папка не удлиняет строку', () => {
    expect(folderChain(dir('/p/a'), new Map())).toMatchObject({ label: 'a', path: '/p/a' });
  });

  it('пустая папка не удлиняет строку', () => {
    const children = new Map<string, DirEntry[]>([['/p/a', []]]);
    expect(folderChain(dir('/p/a'), children).label).toBe('a');
  });

  it('две записи в папке — цепочки нет', () => {
    const children = new Map<string, DirEntry[]>([['/p/a', [dir('/p/a/b'), dir('/p/a/c')]]]);
    expect(folderChain(dir('/p/a'), children).label).toBe('a');
  });

  it('состав не меняется на несвоих данных', () => {
    const children = new Map<string, DirEntry[]>([['/p/a', [file('/p/a/b')]]]);
    expect(folderChain(dir('/p/a'), children).label).toBe('a');
  });
});

describe('chainDepth', () => {
  it('считает звенья, а не символы', () => {
    const chain = { label: 'a/b/c', parts: ['a', 'b', 'c'], path: '/p/a/b/c' };
    expect(chainDepth(chain)).toBe(3);
  });

  it('одна папка — глубина один', () => {
    expect(chainDepth({ label: 'a', parts: ['a'], path: '/p/a' })).toBe(1);
  });
});
