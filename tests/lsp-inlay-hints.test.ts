import { describe, expect, it } from 'vitest';
import { resolveInlayHints, toInlayHints } from '../src/shared/lsp-inlay-hints';

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

/**
 * `inlayHint/resolve`: сервер с `resolveProvider: true` присылает место без
 * подписи, а подпись — по отдельному запросу. Раньше такие подсказки просто
 * отбрасывались, и подсказок типов не было видно вовсе.
 */
describe('resolveInlayHints', () => {
  it('дотягивает только подсказки без подписи', async () => {
    const asked: unknown[] = [];
    const result = await resolveInlayHints(
      [
        { position: { line: 0, character: 5 }, kind: 1, data: { id: 1 } },
        { position: { line: 1, character: 0 }, label: ': string' },
      ],
      async (hint) => {
        asked.push(hint);
        return { ...(hint as object), label: ': number' };
      },
    );
    // Готовая подсказка не спрошена повторно: сервер уже сказал про неё всё.
    expect(asked).toHaveLength(1);
    expect(toInlayHints(result)).toEqual([
      { line: 1, column: 6, label: ': number', kind: 'type' },
      { line: 2, column: 1, label: ': string', kind: 'other' },
    ]);
  });

  it('неудача резолва оставляет подсказку как была — без падения', async () => {
    const result = await resolveInlayHints([{ position: { line: 0, character: 0 }, data: {} }], async () => {
      throw new Error('сервер упал');
    });
    // Подпись пустая, значит на экран она не попадёт (toInlayHints её отбросит),
    // но и весь набор из-за одной неудачи не теряется.
    expect(toInlayHints(result)).toEqual([]);
  });
});
