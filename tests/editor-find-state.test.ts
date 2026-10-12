import { describe, expect, it } from 'vitest';
import { FindState } from '../src/renderer/editor/find/find-state';

/** Источник строк для поиска: обычный массив. */
function source(text: string) {
  const lines = text.split('\n');
  return { getLine: (line0: number) => lines[line0] ?? '', lineCount: lines.length };
}

describe('FindState', () => {
  it('пустой запрос — ничего не найдено и курсор ни на чём', () => {
    const state = new FindState(source('текст'));
    state.setQuery('', {}, 0);
    expect(state.count).toBe(0);
    expect(state.currentMatch).toBeNull();
    expect(state.isEmpty).toBe(true);
  });

  it('находит совпадения и ставит текущим ближайшее к курсору', () => {
    const state = new FindState(source('cat\ncat\ncat'));
    // Курсор во второй строке (смещение 5 — уже второе совпадение).
    state.setQuery('cat', {}, 5);
    expect(state.count).toBe(3);
    expect(state.currentMatch?.line).toBe(2);
  });

  it('переход по кругу: после последнего — первое, до первого — последнее', () => {
    const state = new FindState(source('a\na\na'));
    state.setQuery('a', {}, 0);
    expect(state.currentMatch?.line).toBe(1);
    state.move(1);
    expect(state.currentMatch?.line).toBe(2);
    state.move(1);
    expect(state.currentMatch?.line).toBe(3);
    // Круг замкнулся.
    state.move(1);
    expect(state.currentMatch?.line).toBe(1);
    // И назад через начало — на последнее.
    state.move(-1);
    expect(state.currentMatch?.line).toBe(3);
  });

  it('настройки меняют поиск: регистр и слово целиком', () => {
    const state = new FindState(source('Cat cat category'));
    state.setQuery('cat', {}, 0);
    expect(state.count).toBe(3);

    state.setQuery('cat', { caseSensitive: true }, 0);
    expect(state.count).toBe(2);

    state.setQuery('cat', { wholeWord: true }, 0);
    expect(state.count).toBe(1);
  });

  it('ошибка регулярки видна в состоянии, а поиск не падает', () => {
    const state = new FindState(source('текст'));
    state.setQuery('(', { regex: true }, 0);
    expect(state.count).toBe(0);
    expect(state.snapshot.error).not.toBeNull();
  });

  it('смена документа пересчитывает совпадения по новым строкам', () => {
    const state = new FindState(source('нет тут'));
    state.setQuery('тут', {}, 0);
    expect(state.count).toBe(1);

    state.setSource(source('тут и тут'));
    expect(state.count).toBe(2);
  });

  it('выбор совпадения по номеру', () => {
    const state = new FindState(source('x\nx\nx'));
    state.setQuery('x', {}, 0);
    expect(state.select(2)?.line).toBe(3);
    // Номер вне списка — ничего не выбирается и текущее не меняется.
    expect(state.select(9)).toBeNull();
    expect(state.currentMatch?.line).toBe(3);
  });

  it('переход без совпадений ничего не делает', () => {
    const state = new FindState(source('текст'));
    state.setQuery('zzz', {}, 0);
    expect(state.move(1)).toBeNull();
  });
});
