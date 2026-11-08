import { describe, expect, it } from 'vitest';
import { replaceInText } from '../src/renderer/core/multibuffer';

/**
 * Замена с снятыми строками идёт пофайлово: каждую строку меняем отдельно и
 * пропускаем снятые. Тест держит суть этой логики на чистой функции — номера
 * строк и пропуск.
 */
function replaceLinesExcept(
  lines: readonly string[],
  excluded: ReadonlySet<number>,
  query: string,
  replacement: string,
): { lines: string[]; replaced: number } {
  let replaced = 0;
  const out = lines.map((line, index) => {
    const number = index + 1;
    if (excluded.has(number)) return line;
    const result = replaceInText(line, query, replacement);
    if (result.kind !== 'ok') return line;
    replaced += result.count;
    return result.text;
  });
  return { lines: out, replaced };
}

describe('замена в выдаче с снятыми строками', () => {
  const lines = ['foo = 1', 'bar = foo', 'foo2 = 2'];

  it('снятая строка остаётся как была', () => {
    const { lines: out, replaced } = replaceLinesExcept(lines, new Set([2]), 'foo', 'baz');
    expect(out).toEqual(['baz = 1', 'bar = foo', 'baz2 = 2']);
    expect(replaced).toBe(2);
  });

  it('без снятых заменяется всё', () => {
    const { lines: out, replaced } = replaceLinesExcept(lines, new Set(), 'foo', 'baz');
    expect(out).toEqual(['baz = 1', 'bar = baz', 'baz2 = 2']);
    expect(replaced).toBe(3);
  });

  it('сняты все строки — ничего не меняется', () => {
    const { lines: out, replaced } = replaceLinesExcept(lines, new Set([1, 2, 3]), 'foo', 'baz');
    expect(out).toEqual(lines);
    expect(replaced).toBe(0);
  });

  it('номер строки считается с единицы, как в панели', () => {
    // Снимаем первую строку: ноль в Set был бы промахом на единицу.
    const { lines: out } = replaceLinesExcept(lines, new Set([1]), 'foo', 'baz');
    expect(out[0]).toBe('foo = 1');
    expect(out[1]).toBe('bar = baz');
  });
});
