import { describe, expect, it } from 'vitest';
import { PieceTable } from '../src/renderer/editor/core/piece-table';

describe('PieceTable', () => {
  it('пустой документ', () => {
    const table = new PieceTable();
    expect(table.length).toBe(0);
    expect(table.getText()).toBe('');
    expect(table.pieceCount).toBe(0);
  });

  it('текст при открытии не копируется, а лежит одним куском', () => {
    const table = new PieceTable('первая\nвторая\n');
    expect(table.length).toBe('первая\nвторая\n'.length);
    expect(table.pieceCount).toBe(1);
    expect(table.getText()).toBe('первая\nвторая\n');
  });

  it('вставка в начало, середину и конец', () => {
    const table = new PieceTable('мир');
    table.insert(0, 'привет, ');
    expect(table.getText()).toBe('привет, мир');
    table.insert(8, 'Большой ');
    expect(table.getText()).toBe('привет, Большой мир');
    table.insert(table.length, '!');
    expect(table.getText()).toBe('привет, Большой мир!');
  });

  it('удаление возвращает удалённый текст', () => {
    const table = new PieceTable('abcdef');
    expect(table.delete(2, 2)).toBe('cd');
    expect(table.getText()).toBe('abef');
    expect(table.delete(0, 0)).toBe('');
  });

  it('участок текста берётся по смещениям', () => {
    const table = new PieceTable('0123456789');
    table.insert(5, 'X');
    expect(table.getText(3, 8)).toBe('34X56');
    // «X» встал на смещение 5, значит его участок — [5, 6).
    expect(table.getText(5, 6)).toBe('X');
    expect(table.getText(0, 0)).toBe('');
  });

  it('замена участка возвращает прежний текст', () => {
    const table = new PieceTable('hello world');
    expect(table.replace(6, 5, 'мир')).toBe('world');
    expect(table.getText()).toBe('hello мир');
  });

  it('набор подряд не плодит куски: правка идёт в конец последнего', () => {
    const table = new PieceTable('начало ');
    for (const char of 'набираемый текст') table.insert(table.length, char);
    expect(table.getText()).toBe('начало набираемый текст');
    // Набор в конец — один кусок на весь ввод: слияние соседей работает.
    expect(table.pieceCount).toBe(2);
  });

  it('соседние куски одного буфера сливаются после удаления', () => {
    const table = new PieceTable('abcdef');
    table.insert(3, 'XYZ');
    table.delete(3, 3);
    expect(table.getText()).toBe('abcdef');
    expect(table.pieceCount).toBe(1);
  });

  it('вставка внутрь суррогатной пары не режет эмодзи', () => {
    const table = new PieceTable('a😀b');
    // Смещение 2 — ровно между половинами пары: правка должна встать перед эмодзи.
    table.insert(2, 'X');
    expect(table.getText()).toBe('aX😀b');
    expect(table.getText()).not.toContain('\uD83D\uD83D');
  });

  it('удаление половины суррогатной пары забирает символ целиком', () => {
    const table = new PieceTable('a😀b');
    // Запрос задевает только вторую половину пары — символ уходит целиком.
    table.delete(2, 1);
    expect(table.getText()).toBe('ab');
  });

  it('много правок подряд дают тот же текст, что и наивная модель', () => {
    const table = new PieceTable('старт');
    let naive = 'старт';
    const edits: ReadonlyArray<{ at: number; text: string }> = [
      { at: 0, text: '>> ' },
      { at: 5, text: 'AB' },
      { at: 2, text: '\n' },
      { at: 9, text: 'конец' },
    ];
    for (const edit of edits) {
      table.insert(edit.at, edit.text);
      naive = naive.slice(0, edit.at) + edit.text + naive.slice(edit.at);
    }
    expect(table.getText()).toBe(naive);
    expect(table.delete(1, 10)).toBe(naive.slice(1, 11));
    expect(table.getText()).toBe(naive.slice(0, 1) + naive.slice(11));
  });
});
