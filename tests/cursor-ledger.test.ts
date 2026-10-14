import { describe, expect, it } from 'vitest';
import { CursorLedger } from '../src/renderer/editor/core/cursor-ledger';

const change = (start: number, removed: string, inserted: string) => ({ start, removed, inserted });

describe('CursorLedger: учёт правок по кареткам', () => {
  it('помнит правки раздельно по кареткам', () => {
    const ledger = new CursorLedger();
    ledger.record(1, change(2, '', 'a'), 'typing', 1000);
    ledger.record(2, change(8, '', 'b'), 'typing', 1000);
    expect(ledger.canUndo(1)).toBe(true);
    expect(ledger.canUndo(2)).toBe(true);
    expect(ledger.canUndo(3)).toBe(false);
    expect(ledger.depth(1)).toEqual({ undone: 1, done: 0 });
  });

  it('набор подряд схлопывается в слово', () => {
    const ledger = new CursorLedger();
    for (let i = 0; i < 3; i += 1) {
      const edit = change(i, '', 'x');
      const rec = ledger.record(1, edit, 'typing', 1000 + i * 10);
      ledger.shift(edit, rec);
    }
    expect(ledger.depth(1)).toEqual({ undone: 1, done: 0 });
    // Отмена снимает всё слово сразу: цельное удаление от 0.
    expect(ledger.takeUndo(1)).toEqual({ start: 0, removed: 'xxx', inserted: '' });
  });

  it('чужая правка сдвигает запись: место остаётся верным', () => {
    const ledger = new CursorLedger();
    ledger.record(1, change(6, '', 'X'), 'typing', 1000);
    // Правка ЛЕВЕЕ записи сдвигает её вправо на 2.
    ledger.shift(change(1, '', 'ab'));
    expect(ledger.takeUndo(1)).toEqual({ start: 8, removed: 'X', inserted: '' });
  });

  it('правка правее записи её не двигает', () => {
    const ledger = new CursorLedger();
    ledger.record(1, change(2, '', 'X'), 'typing', 1000);
    ledger.shift(change(20, '', 'yy'));
    expect(ledger.takeUndo(1)).toEqual({ start: 2, removed: 'X', inserted: '' });
  });

  it('независимый повтор возвращает снятую правку', () => {
    const ledger = new CursorLedger();
    ledger.record(1, change(4, '', 'Z'), 'typing', 1000);
    expect(ledger.takeUndo(1)).toEqual({ start: 4, removed: 'Z', inserted: '' });
    expect(ledger.canRedo(1)).toBe(true);
    expect(ledger.takeRedo(1)).toEqual({ start: 4, removed: '', inserted: 'Z' });
    expect(ledger.canRedo(1)).toBe(false);
    expect(ledger.canUndo(1)).toBe(true);
  });

  it('новая правка сбрасывает повтор и не задевает другие каретки', () => {
    const ledger = new CursorLedger();
    ledger.record(1, change(0, '', 'a'), 'typing', 1000);
    ledger.record(2, change(9, '', 'b'), 'typing', 1000);
    ledger.takeUndo(1);
    expect(ledger.canRedo(1)).toBe(true);
    ledger.record(1, change(0, '', 'c'), 'typing', 2000);
    expect(ledger.canRedo(1)).toBe(false);
    // Правка каретки 2 не тронута.
    expect(ledger.canUndo(2)).toBe(true);
  });

  it('clear и forget забывают', () => {
    const ledger = new CursorLedger();
    ledger.record(1, change(0, '', 'a'), 'typing', 1000);
    ledger.forget(1);
    expect(ledger.canUndo(1)).toBe(false);
    ledger.record(2, change(0, '', 'a'), 'typing', 1000);
    ledger.clear();
    expect(ledger.canUndo(2)).toBe(false);
  });
});
