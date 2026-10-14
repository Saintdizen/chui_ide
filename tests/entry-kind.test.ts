import { describe, expect, it } from 'vitest';
import type { DirEntry, SymlinkInfo } from '../src/shared/api';
import { compareEntries, entryIsDirectory, entryIsFile, entryIsSymlink, symlinkLabel } from '../src/shared/entry-kind';

const file = (name: string): DirEntry => ({ name, path: `/p/${name}`, kind: 'file', size: 0, mtimeMs: 0 });
const dir = (name: string): DirEntry => ({ name, path: `/p/${name}`, kind: 'directory', size: 0, mtimeMs: 0 });

const link = (name: string, symlink: SymlinkInfo): DirEntry => ({
  name,
  path: `/p/${name}`,
  kind: 'symlink',
  size: 0,
  mtimeMs: 0,
  symlink,
});

const toDir: SymlinkInfo = { target: '/p/target', kind: 'directory', broken: false };
const toFile: SymlinkInfo = { target: '/p/target.ts', kind: 'file', broken: false };
const broken: SymlinkInfo = { target: 'нет-такого', kind: 'file', broken: true };

describe('как ведёт себя запись', () => {
  it('обычные файл и папка — как есть', () => {
    expect(entryIsDirectory(dir('src'))).toBe(true);
    expect(entryIsDirectory(file('a.ts'))).toBe(false);
    expect(entryIsFile(file('a.ts'))).toBe(true);
    expect(entryIsFile(dir('src'))).toBe(false);
  });

  it('ссылка на папку — папка, на файл — файл', () => {
    expect(entryIsDirectory(link('link-dir', toDir))).toBe(true);
    expect(entryIsFile(link('link-dir', toDir))).toBe(false);
    expect(entryIsFile(link('link-file', toFile))).toBe(true);
    expect(entryIsDirectory(link('link-file', toFile))).toBe(false);
  });

  it('битая ссылка — ни файл, ни папка', () => {
    const entry = link('dead', broken);
    expect(entryIsDirectory(entry)).toBe(false);
    expect(entryIsFile(entry)).toBe(false);
  });

  it('ссылка без разобранной цели не считается ни тем, ни другим', () => {
    // Такую запись контракт допускает (вид есть, цели нет) — её просто не трогаем.
    const entry: DirEntry = { name: 'x', path: '/p/x', kind: 'symlink', size: 0, mtimeMs: 0 };
    expect(entryIsDirectory(entry)).toBe(false);
    expect(entryIsFile(entry)).toBe(false);
    expect(entryIsSymlink(entry)).toBe(true);
  });

  it('ссылка опознаётся как ссылка независимо от цели', () => {
    expect(entryIsSymlink(link('a', toDir))).toBe(true);
    expect(entryIsSymlink(link('b', broken))).toBe(true);
    expect(entryIsSymlink(file('c.ts'))).toBe(false);
  });
});

describe('подпись ссылки', () => {
  it('называет цель, а у битой — что она битая', () => {
    expect(symlinkLabel(link('a', toDir))).toBe('символическая ссылка → /p/target');
    expect(symlinkLabel(link('b', broken))).toBe('битая символическая ссылка → нет-такого');
  });

  it('для несвязанных записей подписи нет', () => {
    expect(symlinkLabel(file('a.ts'))).toBeNull();
    expect(symlinkLabel(dir('src'))).toBeNull();
  });
});

describe('порядок записей папки', () => {
  const names = (entries: readonly DirEntry[]): string[] => [...entries].sort(compareEntries).map((item) => item.name);

  it('сначала папки (в том числе ссылки на них), потом файлы, внутри — по имени', () => {
    const entries = [file('b.ts'), link('z-link-dir', toDir), file('a.ts'), dir('a-dir'), link('y-link-file', toFile)];
    expect(names(entries)).toEqual(['a-dir', 'z-link-dir', 'a.ts', 'b.ts', 'y-link-file']);
  });
});
