import { describe, expect, it } from 'vitest';
import { globToRegExp } from '../src/shared/glob';

const match = (glob: string, path: string): boolean => globToRegExp(glob).test(path);

describe('globToRegExp', () => {
  it('точное имя файла', () => {
    expect(match('package.json', 'package.json')).toBe(true);
    expect(match('package.json', 'src/package.json')).toBe(false);
  });

  it('`*` — в пределах одного сегмента', () => {
    expect(match('*.ts', 'chat.ts')).toBe(true);
    expect(match('*.ts', 'src/chat.ts')).toBe(false);
  });

  it('`**/*.ts` — на любой глубине, включая корень', () => {
    expect(match('**/*.ts', 'chat.ts')).toBe(true);
    expect(match('**/*.ts', 'src/chat.ts')).toBe(true);
    expect(match('**/*.ts', 'src/renderer/ui/chat.ts')).toBe(true);
    expect(match('**/*.ts', 'src/chat.js')).toBe(false);
  });

  it('`src/**` — всё внутри папки, включая сами файлы', () => {
    expect(match('src/**', 'src/chat.ts')).toBe(true);
    expect(match('src/**', 'src/a/b/c.ts')).toBe(true);
    expect(match('src/**', 'lib/chat.ts')).toBe(false);
  });

  it('`src/**/*.ts` — файлы .ts на любой глубине под src', () => {
    expect(match('src/**/*.ts', 'src/a.ts')).toBe(true);
    expect(match('src/**/*.ts', 'src/a/b.ts')).toBe(true);
    expect(match('src/**/*.ts', 'src/a/b.js')).toBe(false);
  });

  it('точка в маске — не «любой символ»', () => {
    expect(match('a.ts', 'a.ts')).toBe(true);
    expect(match('a.ts', 'ats')).toBe(false);
  });

  it('спецсимволы регулярки экранируются', () => {
    expect(match('a+b.ts', 'a+b.ts')).toBe(true);
    expect(match('a+b.ts', 'aab.ts')).toBe(false);
  });

  it('`?` — обычный символ, не квантификатор', () => {
    expect(match('a?.ts', 'a?.ts')).toBe(true);
    expect(match('a?.ts', 'ab.ts')).toBe(false);
  });
});
