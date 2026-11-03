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

describe('folderChain: пересборка', () => {
  it('склеенный хвост переиспользуется, а не считается заново', () => {
    const children = new Map<string, DirEntry[]>([
      ['/p/a', [dir('/p/a/b')]],
      ['/p/a/b', [dir('/p/a/b/c')]],
      ['/p/a/b/c', [file('/p/a/b/c/x.ts')]],
    ]);
    const cache = new Map();
    const top = folderChain(dir('/p/a'), children, '/', cache);
    // Вложенную папку дерево собирает отдельной строкой только при раскрытии —
    // и берёт готовый хвост от родителя.
    const inner = folderChain(dir('/p/a/b'), children, '/', cache);
    expect(top.label).toBe('a/b/c');
    expect(inner.label).toBe('b/c');
    expect(cache.get('/p/a/b')?.path).toBe('/p/a/b/c');
  });

  it('без карты всё работает как раньше', () => {
    const children = new Map<string, DirEntry[]>([['/p/a', [dir('/p/a/b')]]]);
    expect(folderChain(dir('/p/a'), children).parts).toEqual(['a', 'b']);
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
