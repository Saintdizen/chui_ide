import { describe, expect, it } from 'vitest';
import { EditHistory, forwardChanges, inverseChanges, type HistoryEntry } from '../src/renderer/editor/core/history';

function typing(start: number, inserted: string, time: number): HistoryEntry {
  return {
    changes: [{ start, removed: '', inserted }],
    before: [{ anchor: start, active: start }],
    after: [{ anchor: start + inserted.length, active: start + inserted.length }],
    kind: 'typing',
    time,
  };
}

function backspace(start: number, removed: string, time: number): HistoryEntry {
  return {
    changes: [{ start, removed, inserted: '' }],
    before: [{ anchor: start + removed.length, active: start + removed.length }],
    after: [{ anchor: start, active: start }],
    kind: 'delete',
    time,
  };
}

describe('EditHistory', () => {
  it('пустая история: отменять нечего', () => {
    const history = new EditHistory();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
  });

  it('набор подряд схлопывается в один шаг', () => {
    const history = new EditHistory();
    const word = 'слово';
    for (let index = 0; index < word.length; index += 1) {
      history.push(typing(index, word[index], 1000 + index * 10), { merge: true, now: 1000 + index * 10 });
    }
    expect(history.depth).toBe(1);
    const entry = history.undo();
    // Отмена возвращает слово целиком, а не по букве.
    expect(entry?.changes.map((change) => change.inserted).join('')).toBe(word);
  });

  it('пауза в наборе начинает новый шаг', () => {
    const history = new EditHistory();
    history.push(typing(0, 'а', 1000), { merge: true, now: 1000 });
    history.push(typing(1, 'б', 5000), { merge: true, now: 5000 });
    expect(history.depth).toBe(2);
  });

  it('разрыв в месте правки начинает новый шаг', () => {
    const history = new EditHistory();
    history.push(typing(10, 'а', 1000), { merge: true, now: 1000 });
    // Правка не впритык — это уже другое действие.
    history.push(typing(40, 'б', 1010), { merge: true, now: 1010 });
    expect(history.depth).toBe(2);
  });

  it('удаление назад схлопывается, а разные действия — нет', () => {
    const history = new EditHistory();
    history.push(backspace(9, 'а', 1000), { merge: true, now: 1000 });
    history.push(backspace(8, 'б', 1010), { merge: true, now: 1010 });
    expect(history.depth).toBe(1);

    // Набор после удаления — другое действие, шаг отдельный.
    history.push(typing(8, 'в', 1020), { merge: true, now: 1020 });
    expect(history.depth).toBe(2);
  });

  it('«прочие» правки не схлопываются никогда', () => {
    const history = new EditHistory();
    const first: HistoryEntry = {
      changes: [{ start: 0, removed: 'старое', inserted: 'новое' }],
      before: [],
      after: [],
      kind: 'other',
      time: 1000,
    };
    history.push(first, { merge: true, now: 1000 });
    history.push({ ...first, time: 1001 }, { merge: true, now: 1001 });
    expect(history.depth).toBe(2);
  });

  it('отмена и повтор идут туда-обратно', () => {
    const history = new EditHistory();
    history.push(typing(0, 'раз', 1000), { now: 1000 });
    history.push(typing(3, 'два', 2000), { now: 2000 });

    const undone = history.undo();
    expect(undone?.changes[0].inserted).toBe('два');
    expect(history.canRedo).toBe(true);
    expect(history.undo()?.changes[0].inserted).toBe('раз');
    expect(history.canUndo).toBe(false);

    expect(history.redo()?.changes[0].inserted).toBe('раз');
    expect(history.redo()?.changes[0].inserted).toBe('два');
    expect(history.canRedo).toBe(false);
  });

  it('новая правка после отмены сбрасывает повтор', () => {
    const history = new EditHistory();
    history.push(typing(0, 'а', 1000), { now: 1000 });
    history.undo();
    expect(history.canRedo).toBe(true);
    history.push(typing(0, 'б', 2000), { now: 2000 });
    expect(history.canRedo).toBe(false);
  });

  it('обратные правки идут с конца и меняют местами «было» и «стало»', () => {
    const entry: HistoryEntry = {
      changes: [
        { start: 2, removed: '', inserted: 'XX' },
        { start: 8, removed: 'yy', inserted: '' },
      ],
      before: [],
      after: [],
      kind: 'other',
      time: 0,
    };
    expect(inverseChanges(entry)).toEqual([
      { start: 8, removed: '', inserted: 'yy' },
      { start: 2, removed: 'XX', inserted: '' },
    ]);
    expect(forwardChanges(entry)).toBe(entry.changes);
  });

  it('глубина ограничена: старые шаги уходят', () => {
    const history = new EditHistory(3);
    for (let index = 0; index < 5; index += 1) {
      history.push(typing(index, 'а', 1000 + index), { now: 1000 + index });
    }
    expect(history.depth).toBe(3);
    // Отменяются только три последних.
    expect(history.undo()?.changes[0].start).toBe(4);
    expect(history.undo()?.changes[0].start).toBe(3);
    expect(history.undo()?.changes[0].start).toBe(2);
    expect(history.undo()).toBeNull();
  });

  it('сброс очищает обе стороны', () => {
    const history = new EditHistory();
    history.push(typing(0, 'а', 1000), { now: 1000 });
    history.undo();
    history.clear();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });
});
