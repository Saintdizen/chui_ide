import { describe, expect, it } from 'vitest';
import { replaceAll } from '../src/shared/replace';

describe('replaceAll', () => {
  it('пустой запрос — текст без изменений', () => {
    expect(replaceAll('abc', '', 'x')).toEqual({ text: 'abc', count: 0 });
  });

  it('заменяет все вхождения', () => {
    expect(replaceAll('foo bar foo', 'foo', 'baz')).toEqual({ text: 'baz bar baz', count: 2 });
  });

  it('по умолчанию регистр не важен', () => {
    expect(replaceAll('Foo foo', 'foo', 'x')).toEqual({ text: 'x x', count: 2 });
  });

  it('с учётом регистра заменяется только точное совпадение', () => {
    expect(replaceAll('Foo foo', 'foo', 'x', { caseSensitive: true })).toEqual({ text: 'Foo x', count: 1 });
  });

  it('нет совпадений — count 0', () => {
    expect(replaceAll('abc', 'zzz', 'x')).toEqual({ text: 'abc', count: 0 });
  });

  it('буквальный запрос не трактуется как регулярка', () => {
    // Точка не должна совпасть с любым символом.
    expect(replaceAll('a.b axb', 'a.b', 'X')).toEqual({ text: 'X axb', count: 1 });
  });

  it('доллар в замене при литеральном поиске остаётся буквальным', () => {
    expect(replaceAll('цена 100', '100', '$5')).toEqual({ text: 'цена $5', count: 1 });
  });

  it('режим регулярки поддерживает ссылки на группы', () => {
    expect(replaceAll('Ivan Petrov', '(\\w+) (\\w+)', '$2 $1', { isRegex: true })).toEqual({
      text: 'Petrov Ivan',
      count: 1,
    });
  });

  it('некорректная регулярка не портит текст', () => {
    expect(replaceAll('abc', '(', 'x', { isRegex: true })).toEqual({ text: 'abc', count: 0 });
  });

  it('многострочная замена', () => {
    const text = 'line1\nline2\nline1';
    expect(replaceAll(text, 'line1', 'L')).toEqual({ text: 'L\nline2\nL', count: 2 });
  });
});
