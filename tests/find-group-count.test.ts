import { describe, expect, it } from 'vitest';
import { countByGroup, groupCountLabel } from '../src/renderer/editor/find/group-count';
import type { FindMatch } from '../src/renderer/editor/find/search';

const match = (line: number, groups?: (string | undefined)[]): FindMatch => ({
  start: line * 10,
  end: line * 10 + 5,
  line,
  ...(groups ? { groups } : {}),
});

describe('countByGroup: счёт по группам регэкспа', () => {
  it('считает каждую группу по числу совпадений', () => {
    const counts = countByGroup([
      match(1, ['getUser', 'user']),
      match(2, ['setUser', 'user']),
      match(3, ['deleteUser', 'user']),
    ]);
    expect(counts).toEqual([
      { index: 1, count: 3, sample: 'getUser' },
      { index: 2, count: 3, sample: 'user' },
    ]);
  });

  it('необязательная группа, не участвовавшая в матче, не считается', () => {
    const counts = countByGroup([match(1, ['a', undefined]), match(2, ['b', 'x'])]);
    expect(counts).toEqual([
      { index: 1, count: 2, sample: 'a' },
      { index: 2, count: 1, sample: 'x' },
    ]);
  });

  it('без групп — пусто: группировать нечего', () => {
    expect(countByGroup([match(1), match(2)])).toEqual([]);
  });

  it('пустые совпадения — пустой счёт', () => {
    expect(countByGroup([])).toEqual([]);
  });
});

describe('groupCountLabel: строка для панели', () => {
  it('показывает номер, счёт и пример', () => {
    const counts = countByGroup([match(1, ['foo', 'bar']), match(2, ['foo', 'baz'])]);
    expect(groupCountLabel(counts, 2)).toBe('группы: 1 — 2 (foo), 2 — 2 (bar) из 2');
  });

  it('без групп строки нет: панель не добавляет пустой подсказки', () => {
    expect(groupCountLabel([], 5)).toBe('');
  });
});
