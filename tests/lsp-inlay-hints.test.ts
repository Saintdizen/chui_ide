import { describe, expect, it } from 'vitest';
import { toInlayHints } from '../src/shared/lsp-inlay-hints';

/**
 * Разбор подсказок-вставок из ответа LSP. Позиции там 0-based — приводим к нашим
 * 1-based; подпись бывает строкой и списком частей; вид переводим в понятное слово.
 */
describe('toInlayHints', () => {
  it('читает место, подпись и вид', () => {
    expect(toInlayHints([{ position: { line: 2, character: 4 }, label: ': int', kind: 1 }])).toEqual([
      { line: 3, column: 5, label: ': int', kind: 'type' },
    ]);
  });

  it('подпись из частей склеивается', () => {
    const hints = toInlayHints([
      { position: { line: 0, character: 0 }, label: [{ value: 'name' }, { value: ':' }], kind: 2 },
    ]);
    expect(hints[0]!.label).toBe('name:');
    expect(hints[0]!.kind).toBe('parameter');
  });

  it('вид без номера — «иное»', () => {
    expect(toInlayHints([{ position: { line: 0, character: 0 }, label: 'x' }])[0]!.kind).toBe('other');
  });

  it('битые записи и пустые подписи пропускаются', () => {
    expect(toInlayHints([null, {}, { position: {} }, { label: 'x' }, { position: { line: 0, character: 0 } }])).toEqual(
      [],
    );
    expect(toInlayHints([{ position: { line: 0, character: 0 }, label: '' }])).toEqual([]);
  });

  it('не список — пусто', () => {
    expect(toInlayHints(null)).toEqual([]);
    expect(toInlayHints({ position: { line: 0, character: 0 } })).toEqual([]);
  });
});
