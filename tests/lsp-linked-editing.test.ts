import { describe, expect, it } from 'vitest';
import { toLinkedRanges } from '../src/shared/lsp-linked-editing';

/**
 * Разбор связанных участков (`textDocument/linkedEditingRange`). Проверяем перевод
 * координат (сервер шлёт 0-based, редактор ждёт 1-based) и отсев записей, по которым
 * синхронизировать нечего: одиночный участок, пустой, многострочный.
 */

const range = (startLine: number, startChar: number, endLine: number, endChar: number): Record<string, unknown> => ({
  start: { line: startLine, character: startChar },
  end: { line: endLine, character: endChar },
});

describe('toLinkedRanges', () => {
  it('переводит участки в 1-based', () => {
    const result = toLinkedRanges({ ranges: [range(0, 1, 0, 4), range(0, 12, 0, 15)] });

    expect(result).toEqual([
      { line: 1, startColumn: 2, endColumn: 5 },
      { line: 1, startColumn: 13, endColumn: 16 },
    ]);
  });

  it('один участок — не связь: синхронизировать не с чем', () => {
    expect(toLinkedRanges({ ranges: [range(0, 1, 0, 4)] })).toEqual([]);
  });

  it('дубли участков схлопываются', () => {
    const result = toLinkedRanges({ ranges: [range(1, 2, 1, 5), range(1, 2, 1, 5), range(1, 8, 1, 11)] });

    expect(result).toEqual([
      { line: 2, startColumn: 3, endColumn: 6 },
      { line: 2, startColumn: 9, endColumn: 12 },
    ]);
  });

  it('многострочный и пустой участки отбрасываются', () => {
    expect(toLinkedRanges({ ranges: [range(0, 1, 1, 4), range(2, 5, 2, 5)] })).toEqual([]);
  });

  it('мусор даёт пустой список', () => {
    expect(toLinkedRanges(null)).toEqual([]);
    expect(toLinkedRanges({})).toEqual([]);
    expect(toLinkedRanges({ ranges: 'nope' })).toEqual([]);
    expect(toLinkedRanges({ ranges: [null, {}, { start: {}, end: {} }] })).toEqual([]);
  });
});
