import { describe, expect, it, vi } from 'vitest';
import { resolveInlineValues } from '../src/renderer/core/inline-values';
import type { InlineValue } from '../src/shared/lsp-inline-value';

/**
 * Сборка значений для показа: участки помечает языковой сервер, значения даёт отладчик.
 * Проверяем выбор выражения (имя переменной, выражение, текст участка), пропуск неудач и
 * место вставки (значение встаёт ПОСЛЕ участка).
 */

const item = (over: Partial<InlineValue> & { action: InlineValue['action'] }): InlineValue => ({
  line: 1,
  startColumn: 1,
  endColumn: 4,
  ...over,
});

describe('resolveInlineValues', () => {
  it('готовый текст показывается как есть, без отладчика', async () => {
    const evaluate = vi.fn();
    const values = await resolveInlineValues(
      [item({ action: { kind: 'text', text: '≈ 3.14' } })],
      'x = 3.14',
      evaluate,
    );

    expect(values).toEqual([{ line: 1, column: 3, label: '≈ 3.14' }]);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('переменную считает отладчик, подпись — имя и значение', async () => {
    const evaluate = vi.fn(async (expression: string) => ({ value: expression === 'total' ? '42' : '' }));
    const values = await resolveInlineValues(
      [
        item({
          line: 1,
          startColumn: 1,
          endColumn: 6,
          action: { kind: 'lookup', variableName: 'total', caseSensitive: false },
        }),
      ],
      'total = 42',
      evaluate,
    );

    expect(evaluate).toHaveBeenCalledWith('total');
    expect(values).toEqual([{ line: 1, column: 5, label: 'total = 42' }]);
  });

  it('без имени берётся текст участка', async () => {
    const evaluate = vi.fn(async () => ({ value: '7' }));
    const values = await resolveInlineValues(
      [
        item({
          line: 2,
          startColumn: 1,
          endColumn: 6,
          action: { kind: 'lookup', variableName: '', caseSensitive: false },
        }),
      ],
      'first line\nitems.length',
      evaluate,
    );

    expect(evaluate).toHaveBeenCalledWith('items');
    expect(values).toEqual([{ line: 2, column: 5, label: 'items = 7' }]);
  });

  it('не вычислилось или пусто — пропускаем', async () => {
    const evaluate = vi.fn(async (expression: string) => (expression === 'a' ? null : { value: '' }));
    const values = await resolveInlineValues(
      [
        item({ action: { kind: 'evaluate', expression: 'a' } }),
        item({ line: 2, startColumn: 1, endColumn: 2, action: { kind: 'evaluate', expression: 'b' } }),
      ],
      'aa\nbb',
      evaluate,
    );

    expect(values).toEqual([]);
  });

  it('ошибка отладчика на одном выражении не срывает остальные', async () => {
    const evaluate = vi.fn(async (expression: string) => {
      if (expression === 'bad') throw new Error('нет переменной');
      return { value: '5' };
    });
    const values = await resolveInlineValues(
      [
        item({ line: 1, startColumn: 1, endColumn: 4, action: { kind: 'evaluate', expression: 'bad' } }),
        item({ line: 2, startColumn: 1, endColumn: 4, action: { kind: 'evaluate', expression: 'ok' } }),
      ],
      'bad\nok',
      evaluate,
    );

    expect(values).toEqual([{ line: 2, column: 3, label: 'ok = 5' }]);
  });
});
