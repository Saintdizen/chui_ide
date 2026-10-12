import { describe, expect, it } from 'vitest';
import { hasPrefix, prefixAt, prefixStart } from '../src/renderer/editor/complete/prefix';

describe('префикс под курсором', () => {
  it('берёт слово перед курсором', () => {
    // Набрано «форм», курсор после него: подсказка предлагается по этому началу.
    expect(prefixAt('формат', 4)).toBe('форм');
    expect(prefixAt('const value', 11)).toBe('value');
  });

  it('останавливается на разделителе', () => {
    expect(prefixAt('a.b', 3)).toBe('b');
    expect(prefixAt('foo(bar', 7)).toBe('bar');
    expect(prefixAt('x = y', 1)).toBe('x');
  });

  it('подчёркивание и цифры — часть слова', () => {
    expect(prefixAt('active_row2', 11)).toBe('active_row2');
  });

  it('кириллица считается словом', () => {
    // «переменная» — курсор после шестого знака: взято первых шесть («переме»).
    expect(prefixAt('переменная', 6)).toBe('переме');
    expect(prefixAt('переменная', 10)).toBe('переменная');
  });

  it('курсор не в слове — префикса нет', () => {
    expect(prefixAt('слово ', 6)).toBe('');
    expect(prefixAt('', 0)).toBe('');
    expect(prefixAt('()', 1)).toBe('');
  });

  it('курсор в середине слова: префикс — только левая часть', () => {
    expect(prefixAt('формат', 2)).toBe('фо');
    expect(prefixStart('формат', 2)).toBe(0);
  });

  it('начало префикса — за его длину до курсора', () => {
    expect(prefixStart('const value', 11)).toBe(6);
    expect(prefixStart('слово ', 6)).toBe(6);
  });

  it('смещения за пределами строки прижимаются', () => {
    expect(prefixAt('abc', 99)).toBe('abc');
    expect(prefixAt('abc', -5)).toBe('');
    expect(prefixStart('abc', 99)).toBe(0);
  });

  it('есть ли что подсказывать', () => {
    expect(hasPrefix('слово', 5)).toBe(true);
    expect(hasPrefix('()', 1)).toBe(false);
  });
});
