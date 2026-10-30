import { describe, expect, it } from 'vitest';
import { toDocumentColors } from '../src/shared/lsp-document-color';

/** Ответ сервера одной записью — как его присылает `textDocument/documentColor`. */
function entry(line: number, character: number, color: Record<string, unknown>) {
  return { range: { start: { line, character }, end: { line, character: character + 7 } }, color };
}

describe('toDocumentColors: цвета из ответа сервера', () => {
  it('собирает цвет и место (строка и столбец с 1)', () => {
    expect(toDocumentColors([entry(3, 16, { red: 0.23, green: 0.51, blue: 0.96, alpha: 1 })])).toEqual([
      { line: 4, column: 17, hex: '#3b82f5', alpha: 1 },
    ]);
  });

  it('непрозрачный цвет без альфы в ответе — обычный hex', () => {
    expect(toDocumentColors([entry(0, 0, { red: 1, green: 0, blue: 0 })])[0]?.hex).toBe('#ff0000');
  });

  it('полупрозрачный цвет несёт альфу и значение прозрачности', () => {
    const [color] = toDocumentColors([entry(0, 0, { red: 0, green: 0, blue: 1, alpha: 0.5 })]);
    expect(color?.hex).toBe('#0000ff80');
    expect(color?.alpha).toBe(0.5);
  });

  it('каналы наружу диапазона и мусор от сервера не дают сломанного hex', () => {
    expect(toDocumentColors([entry(0, 0, { red: 2, green: -1, blue: 0.5 })])[0]?.hex).toBe('#ff0080');
  });

  it('битые записи пропускаются, а не ломают разбор', () => {
    const raw = [
      null,
      'цвет',
      {},
      { range: { start: { line: 'a', character: 0 } }, color: { red: 0, green: 0, blue: 0 } },
      { range: { start: { line: 1, character: 2 } }, color: { red: Number.NaN, green: 0, blue: 0 } },
      entry(5, 1, { red: 0, green: 0.5, blue: 0 }),
    ];
    expect(toDocumentColors(raw).map((c) => c.line)).toEqual([6]);
  });

  it('не массив — пустой список, а не падение', () => {
    expect(toDocumentColors(null)).toEqual([]);
    expect(toDocumentColors({})).toEqual([]);
  });

  it('две цифры на канал: короткие значения не теряют ноль', () => {
    expect(toDocumentColors([entry(0, 0, { red: 0.01, green: 0, blue: 0 })])[0]?.hex).toBe('#030000');
  });
});
