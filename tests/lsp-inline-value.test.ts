import { describe, expect, it } from 'vitest';
import { expressionFor, inlineLabel, toInlineValues, type InlineValue } from '../src/shared/lsp-inline-value';

/**
 * Разбор inline-значений (`textDocument/inlineValue`). Три вида ответа различаются по полям:
 * готовый текст, поиск переменной (по `caseSensitiveLookup`) и выражение. Проверяем и перевод
 * координат (сервер шлёт 0-based, редактор ждёт 1-based), и выбор выражения для отладчика.
 */

const range = (line: number, start: number, end: number): Record<string, unknown> => ({
  range: { start: { line, character: start }, end: { line, character: end } },
});

describe('toInlineValues', () => {
  it('готовый текст переносится как есть, координаты — в 1-based', () => {
    const values = toInlineValues([{ ...range(1, 2, 5), text: '≈ 3.14' }]);

    expect(values).toEqual([{ line: 2, startColumn: 3, endColumn: 6, action: { kind: 'text', text: '≈ 3.14' } }]);
  });

  it('поиск переменной: имя и чувствительность к регистру', () => {
    const values = toInlineValues([{ ...range(0, 0, 1), variableName: 'total', caseSensitiveLookup: true }]);

    expect(values[0]!.action).toEqual({ kind: 'lookup', variableName: 'total', caseSensitive: true });
  });

  it('поиск переменной без имени сохраняется: имя возьмут из текста участка', () => {
    const values = toInlineValues([{ ...range(0, 0, 5), caseSensitiveLookup: false }]);

    expect(values[0]!.action).toEqual({ kind: 'lookup', variableName: '', caseSensitive: false });
  });

  it('вычисляемое выражение с выражением и без', () => {
    const withExpr = toInlineValues([{ ...range(2, 0, 3), expression: 'a + b' }]);
    expect(withExpr[0]!.action).toEqual({ kind: 'evaluate', expression: 'a + b' });

    const without = toInlineValues([{ ...range(2, 0, 3) }]);
    expect(without[0]!.action).toEqual({ kind: 'evaluate', expression: '' });
  });

  it('многострочное и битое пропускается', () => {
    expect(
      toInlineValues([
        { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 2 } }, text: 'x' },
        null,
        {},
        'мусор',
      ]),
    ).toEqual([]);
  });

  it('не-массив — пустой список', () => {
    expect(toInlineValues(null)).toEqual([]);
    expect(toInlineValues({ text: 'x' } as unknown)).toEqual([]);
  });
});

describe('expressionFor', () => {
  const value = (action: InlineValue['action']): InlineValue => ({
    line: 1,
    startColumn: 1,
    endColumn: 2,
    action,
  });

  it('имя переменной важнее текста участка', () => {
    expect(expressionFor(value({ kind: 'lookup', variableName: 'items', caseSensitive: false }), 'items.length')).toBe(
      'items',
    );
  });

  it('без имени переменной и без выражения берётся текст участка', () => {
    expect(expressionFor(value({ kind: 'lookup', variableName: '', caseSensitive: false }), 'items.length')).toBe(
      'items.length',
    );
    expect(expressionFor(value({ kind: 'evaluate', expression: '' }), 'a + b')).toBe('a + b');
  });

  it('готовый текст не пересчитываем', () => {
    expect(expressionFor(value({ kind: 'text', text: 'x' }), 'что угодно')).toBe('что угодно');
  });
});

describe('inlineLabel', () => {
  it('имя и значение через знак равенства', () => {
    expect(inlineLabel('x', '42')).toBe('x = 42');
  });
});
