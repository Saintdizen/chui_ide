import { describe, expect, it } from 'vitest';
import { parseSubmodules, submoduleStateLabel } from '../src/shared/git-submodules';

/**
 * Разбор `git submodule status`: первый символ строки — состояние, дальше хеш,
 * путь и необязательное описание в скобках. Строки взяты в том виде, в каком их
 * печатает git.
 */
describe('parseSubmodules', () => {
  it('подмодуль на месте и на нужном коммите', () => {
    const out = ' 71f36be2ce155eb65ffcf44db772fe8f76bb54be mods/sub (heads/master)\n';
    expect(parseSubmodules(out)).toEqual([
      {
        hash: '71f36be2ce155eb65ffcf44db772fe8f76bb54be',
        path: 'mods/sub',
        description: 'heads/master',
        state: 'ok',
      },
    ]);
  });

  it('плюс — в подмодуле другой коммит', () => {
    expect(parseSubmodules('+abc1234 mods/lib (v1.2.0)\n')[0]).toMatchObject({
      state: 'modified',
      path: 'mods/lib',
      description: 'v1.2.0',
    });
  });

  it('минус — подмодуль не забран', () => {
    expect(parseSubmodules('-abc1234 mods/lib\n')[0]).toMatchObject({ state: 'missing', description: '' });
  });

  it('U — конфликт слияния в подмодуле', () => {
    expect(parseSubmodules('Uabc1234 mods/lib (heads/main)\n')[0]?.state).toBe('conflict');
  });

  it('несколько строк и пустые строки пропускаются', () => {
    const out = ' abc1234 a\n\n-abc1234 b (heads/x)\n';
    expect(parseSubmodules(out).map((item) => item.path)).toEqual(['a', 'b']);
  });

  it('путь с пробелом не разваливает разбор', () => {
    expect(parseSubmodules(' abc1234 mods/my sub\n')[0]).toMatchObject({
      path: 'mods/my sub',
      description: '',
    });
  });

  it('пустой вывод — пустой список', () => {
    expect(parseSubmodules('')).toEqual([]);
  });
});

describe('submoduleStateLabel', () => {
  it('у каждого состояния есть подпись', () => {
    for (const state of ['ok', 'modified', 'missing', 'conflict'] as const) {
      expect(submoduleStateLabel(state).length).toBeGreaterThan(0);
    }
  });
});
