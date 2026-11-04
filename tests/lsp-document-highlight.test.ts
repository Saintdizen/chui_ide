import { describe, expect, it } from 'vitest';
import { toDocumentHighlights } from '../src/shared/lsp-document-highlight';

function entry(line: number, start: number, end: number, kind?: number) {
  return { range: { start: { line, character: start }, end: { line, character: end } }, kind };
}

describe('toDocumentHighlights: где ещё встречается символ', () => {
  it('переводит нумерацию с нуля в нашу — с единицы', () => {
    // Сервер отдаёт {line: 4, character: 7}; человек считает с 1 — и подсветка тоже.
    const [span] = toDocumentHighlights([entry(4, 7, 12)]);
    expect(span).toEqual({ line: 5, column: 8, endColumn: 13, length: 5, kind: 'text' });
  });

  it('различает чтение и запись — этого текстовый поиск не даёт', () => {
    const spans = toDocumentHighlights([entry(0, 0, 3, 2), entry(1, 0, 3, 3)]);
    expect(spans.map((s) => s.kind)).toEqual(['read', 'write']);
  });

  it('без kind считается обычным текстом', () => {
    expect(toDocumentHighlights([entry(0, 0, 2)])[0]?.kind).toBe('text');
  });

  it('неведомый код не ломает раскраску', () => {
    expect(toDocumentHighlights([entry(0, 0, 2, 99)])[0]?.kind).toBe('text');
  });

  it('нулевая длина отбрасывается: её не видно, только шум', () => {
    expect(toDocumentHighlights([entry(3, 5, 5)])).toEqual([]);
  });

  it('битые записи пропускаются, хорошие остаются', () => {
    const spans = toDocumentHighlights([null, { range: {} }, { range: { start: {} } }, entry(2, 1, 4)]);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.line).toBe(3);
  });

  it('remap пересчитывает границы utf-32 → utf-16', () => {
    // Эмодзи перед словом: utf-32 колонка 1 = utf-16 колонка 2.
    const entry = { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } } };
    const spans = toDocumentHighlights([entry], (_line, character) => character + 1);
    expect(spans[0]).toMatchObject({ line: 1, column: 3, endColumn: 6 });
  });

  it('не массив — пусто, а не падение', () => {
    expect(toDocumentHighlights(null)).toEqual([]);
    expect(toDocumentHighlights({})).toEqual([]);
  });
});
