import { describe, expect, it } from 'vitest';
import { bestFullLine, lineHead } from '../src/shared/full-line';

/**
 * Подсказка целой строки: продолжение берётся из того, что уже написано в
 * проекте. Ошибка здесь не роняет ничего, но подсказка становится шумом —
 * а шум люди выключают вместе с функцией.
 */
describe('bestFullLine', () => {
  const corpus = [
    'const value = compute();',
    'const value = compute();',
    'const volume = measure();',
    'console.log(value);',
    '  const inner = 1;',
  ];

  it('продолжает по частому началу', () => {
    expect(bestFullLine('const va', corpus)).toEqual({ insert: 'lue = compute();', count: 2 });
  });

  it('берёт хвост, который встречается чаще', () => {
    // `const v` подходит и value дважды, и volume один раз.
    expect(bestFullLine('const v', corpus)?.insert).toBe('alue = compute();');
  });

  it('не приклеивает продолжение к концу слова', () => {
    // `const val` не должно дать `const value`... но `value` начинается с `val`.
    expect(bestFullLine('const val', corpus)?.insert).toBe('ue = compute();');
    // А `const val` + `ue` — целое слово; а вот `const valu` + `e` уже нет продолжения.
    expect(bestFullLine('const valu', corpus)).toEqual({ insert: 'e = compute();', count: 2 });
  });

  it('короткое начало не подсказывает', () => {
    expect(bestFullLine('c', corpus)).toBeNull();
  });

  it('набранная целиком строка не продолжается', () => {
    expect(bestFullLine('const value = compute();', corpus)).toBeNull();
  });

  it('отдельный разделитель — не продолжение', () => {
    expect(bestFullLine('const value', ['const value;'])).toBeNull();
  });

  it('отступ набранного сохраняется в голове', () => {
    expect(bestFullLine('  const in', corpus)?.insert).toBe('ner = 1;');
  });
});

describe('lineHead', () => {
  it('отрезает отступ', () => {
    expect(lineHead('    const a = 1;')).toBe('const a = 1;');
  });
});
