import { describe, expect, it } from 'vitest';
import { onTypeTriggers, toFormatEdits } from '../src/shared/lsp-formatting';

describe('toFormatEdits: разбор правок форматирования', () => {
  it('позиции LSP 0-based переводятся в наши 1-based', () => {
    const raw = [
      {
        range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } },
        newText: '  value = 1',
      },
    ];
    expect(toFormatEdits(raw)).toEqual([
      { startLine: 3, startColumn: 5, endLine: 3, endColumn: 11, newText: '  value = 1' },
    ]);
  });

  it('несколько правок сохраняют порядок', () => {
    const raw = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'a' },
      { range: { start: { line: 5, character: 0 }, end: { line: 5, character: 3 } }, newText: 'b' },
    ];
    expect(toFormatEdits(raw).map((edit) => edit.newText)).toEqual(['a', 'b']);
  });

  it('пустой ответ — пустой список (сервер менять нечего)', () => {
    expect(toFormatEdits([])).toEqual([]);
    expect(toFormatEdits(null)).toEqual([]);
    expect(toFormatEdits('нет')).toEqual([]);
  });

  it('битые записи пропускаются, годные остаются', () => {
    const raw = [
      { range: { start: { line: 0, character: 0 } }, newText: 'без конца' },
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, newText: 42 },
      null,
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, newText: 'ok' },
    ];
    expect(toFormatEdits(raw)).toEqual([{ startLine: 2, startColumn: 1, endLine: 2, endColumn: 2, newText: 'ok' }]);
  });

  it('пустой newText — законная правка (удаление)', () => {
    const raw = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: '' }];
    expect(toFormatEdits(raw)[0]!.newText).toBe('');
  });

  it('дробные и отрицательные номера поджимаются к целому', () => {
    const raw = [{ range: { start: { line: -3, character: 1.7 }, end: { line: 2.9, character: 0 } }, newText: 'x' }];
    expect(toFormatEdits(raw)).toEqual([{ startLine: 1, startColumn: 2, endLine: 3, endColumn: 1, newText: 'x' }]);
  });
});

describe('onTypeTriggers: знаки форматирования на вводе', () => {
  it('берёт список из возможностей сервера', () => {
    expect(onTypeTriggers({ documentOnTypeFormattingProvider: { triggerCharacters: ['}', ';'] } })).toEqual(['}', ';']);
  });

  it('сервер без этой возможности — пусто', () => {
    expect(onTypeTriggers({})).toEqual([]);
    expect(onTypeTriggers(null)).toEqual([]);
    expect(onTypeTriggers({ documentOnTypeFormattingProvider: {} })).toEqual([]);
  });

  it('мусор в списке отбрасывается', () => {
    expect(onTypeTriggers({ documentOnTypeFormattingProvider: { triggerCharacters: ['}', 4, '', null] } })).toEqual([
      '}',
    ]);
  });
});
