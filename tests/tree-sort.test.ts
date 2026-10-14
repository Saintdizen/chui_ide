import { describe, expect, it } from 'vitest';
import type { DirEntry, GitChange } from '../src/shared/api';
import { extensionOf, sortTree } from '../src/renderer/core/tree-sort';

const entry = (name: string, kind: DirEntry['kind'], extra: Partial<DirEntry> = {}): DirEntry => ({
  name,
  path: `/p/${name}`,
  kind,
  size: 0,
  mtimeMs: 0,
  ...extra,
});

const names = (entries: readonly DirEntry[]): string[] => entries.map((item) => item.name);

/**
 * Порядок строк дерева: имя, тип, время правки и пометки git. Папки выше файлов —
 * первым ключом во всех режимах, поэтому проверяем и его.
 */
describe('sortTree: по имени', () => {
  it('сортирует по имени и держит папки выше файлов', () => {
    const entries = [entry('b.ts', 'file'), entry('a', 'directory'), entry('a.ts', 'file')];
    expect(names(sortTree(entries, { foldersFirst: true, sort: 'name' }))).toEqual(['a', 'a.ts', 'b.ts']);
  });

  it('ссылка на папку — среди папок, а не среди файлов', () => {
    const entries = [
      entry('a.ts', 'file'),
      entry('link-dir', 'symlink', { symlink: { target: '/p/dir', kind: 'directory', broken: false } }),
      entry('dir', 'directory'),
    ];
    expect(names(sortTree(entries, { foldersFirst: true, sort: 'name' }))).toEqual(['dir', 'link-dir', 'a.ts']);
  });

  it('без «папки выше» сортирует всё вместе по имени', () => {
    const entries = [entry('b.ts', 'file'), entry('a', 'directory')];
    expect(names(sortTree(entries, { foldersFirst: false, sort: 'name' }))).toEqual(['a', 'b.ts']);
  });
});

describe('sortTree: по типу файла', () => {
  it('группирует по расширению, внутри — по имени', () => {
    const entries = [entry('b.ts', 'file'), entry('a.css', 'file'), entry('a.ts', 'file')];
    expect(names(sortTree(entries, { foldersFirst: true, sort: 'type' }))).toEqual(['a.css', 'a.ts', 'b.ts']);
  });

  it('файл без расширения идёт первым', () => {
    const entries = [entry('b.ts', 'file'), entry('makefile', 'file')];
    expect(names(sortTree(entries, { foldersFirst: true, sort: 'type' }))).toEqual(['makefile', 'b.ts']);
  });
});

describe('sortTree: по времени правки', () => {
  it('свежие выше, при равном времени — по имени', () => {
    const entries = [
      entry('old.ts', 'file', { mtimeMs: 100 }),
      entry('new.ts', 'file', { mtimeMs: 300 }),
      entry('same.ts', 'file', { mtimeMs: 300 }),
    ];
    expect(names(sortTree(entries, { foldersFirst: true, sort: 'modified' }))).toEqual(['new.ts', 'same.ts', 'old.ts']);
  });

  it('папки выше файлов и в этом режиме', () => {
    const entries = [entry('a.ts', 'file', { mtimeMs: 999 }), entry('dir', 'directory', { mtimeMs: 1 })];
    expect(names(sortTree(entries, { foldersFirst: true, sort: 'modified' }))).toEqual(['dir', 'a.ts']);
  });
});

describe('sortTree: по пометкам git', () => {
  it('файлы с правками выше чистых, внутри — по имени', () => {
    const entries = [entry('clean.ts', 'file'), entry('changed.ts', 'file'), entry('added.ts', 'file')];
    const changeOf = (path: string): GitChange | undefined => (path.endsWith('clean.ts') ? undefined : 'modified');
    expect(names(sortTree(entries, { foldersFirst: true, sort: 'git', changeOf }))).toEqual([
      'added.ts',
      'changed.ts',
      'clean.ts',
    ]);
  });

  it('без пометок порядок — как по имени', () => {
    const entries = [entry('b.ts', 'file'), entry('a.ts', 'file')];
    expect(names(sortTree(entries, { foldersFirst: true, sort: 'git', changeOf: () => undefined }))).toEqual([
      'a.ts',
      'b.ts',
    ]);
  });
});

describe('extensionOf', () => {
  it('берёт расширение в нижнем регистре', () => {
    expect(extensionOf('Button.TSX')).toBe('tsx');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
  });

  it('точечные файлы и файлы без точки расширения не имеют', () => {
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('makefile')).toBe('');
  });
});
