import { describe, expect, it } from 'vitest';
import { parseLineNumber } from '../src/renderer/editor/widgets/goto-widget';

describe('parseLineNumber', () => {
  it('обычный номер', () => {
    expect(parseLineNumber('42', 100)).toBe(42);
  });

  it('пробелы по краям не мешают', () => {
    expect(parseLineNumber('  7  ', 100)).toBe(7);
  });

  it('номер за концом файла прижимается к последней строке', () => {
    expect(parseLineNumber('9999', 100)).toBe(100);
  });

  it('ноль и отрицательные прижимаются к первой строке', () => {
    expect(parseLineNumber('0', 100)).toBe(1);
    // Минус не проходит проверку на число — перехода не будет.
    expect(parseLineNumber('-5', 100)).toBeNull();
  });

  it('не число — перехода нет', () => {
    expect(parseLineNumber('', 100)).toBeNull();
    expect(parseLineNumber('abc', 100)).toBeNull();
    expect(parseLineNumber('12a', 100)).toBeNull();
    expect(parseLineNumber('1.5', 100)).toBeNull();
  });

  it('пустой файл — первая строка и при вводе большего номера', () => {
    expect(parseLineNumber('5', 1)).toBe(1);
  });
});
