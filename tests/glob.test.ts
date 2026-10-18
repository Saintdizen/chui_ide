import { describe, expect, it } from 'vitest';
import { globToRegExp, maskToRegExp } from '../src/shared/glob';

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

  it('`?` — ровно один символ, но не слэш', () => {
    expect(match('router.?s', 'router.ts')).toBe(true);
    expect(match('router.?s', 'router.js')).toBe(true);
    expect(match('router.?s', 'router.tsx')).toBe(false);
    // Уровень пути `?` не переходит: сегмент остаётся одним.
    expect(match('src/?.ts', 'src/a.ts')).toBe(true);
    expect(match('src/?.ts', 'src/a/b.ts')).toBe(false);
  });

  it('`?` не ломает экранирование: точка и скобки остаются буквами', () => {
    expect(match('a.ts', 'a.ts')).toBe(true);
    expect(match('a.ts', 'ats')).toBe(false);
    expect(match('{a}', '{a}')).toBe(true);
  });
});

/**
 * Маска из настроек (значки дерева, исключённые файлы): та же арифметика знаков,
 * но без учёта регистра и без особого случая «двойная звёздочка со слэшем» —
 * такую маску сверяют и с именем, и с путём по отдельности.
 */
describe('maskToRegExp', () => {
  const matches = (mask: string, value: string): boolean => maskToRegExp(mask).test(value);

  it('регистр не важен: маска пришла из настроек, а не из кода', () => {
    expect(matches('*.min.js', 'app.MIN.JS')).toBe(true);
    expect(matches('README*', 'readme.md')).toBe(true);
  });

  it('`*` и `**` работают на своих уровнях', () => {
    expect(matches('*.ts', 'chat.ts')).toBe(true);
    expect(matches('generated/*', 'generated/api.ts')).toBe(true);
    expect(matches('generated/**', 'generated/a/b.ts')).toBe(true);
  });

  it('без обрамляющих пробелов: маску из настроек пишут руками', () => {
    expect(matches('  dist  ', 'dist')).toBe(true);
  });

  it('точка и скобки остаются буквами', () => {
    expect(matches('a+b.ts', 'a+b.ts')).toBe(true);
    expect(matches('a+b.ts', 'aab.ts')).toBe(false);
  });
});
