import { describe, expect, it } from 'vitest';
import {
  countLines,
  describeAge,
  formatClock,
  historyEntryLabel,
  historyKey,
  reasonLabel,
  sanitizeHistoryEntries,
  type HistoryEntry,
} from '../src/shared/file-history';

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: 'snap-1',
  path: '/p/src/a.ts',
  name: 'a.ts',
  mtimeMs: 0,
  size: 0,
  lines: 3,
  hash: 'h',
  reason: 'save',
  ...over,
});

describe('countLines', () => {
  it('считает строки как редактор — по переводам плюс одна', () => {
    expect(countLines('')).toBe(1);
    expect(countLines('one')).toBe(1);
    expect(countLines('one\ntwo')).toBe(2);
    expect(countLines('one\ntwo\n')).toBe(3);
  });
});

describe('reasonLabel', () => {
  it('различает сохранение и удаление', () => {
    expect(reasonLabel('save')).toBe('сохранение');
    expect(reasonLabel('delete')).toBe('перед удалением');
  });
});

describe('describeAge', () => {
  const base = 1_700_000_000_000;

  it('переводит возраст в удобные единицы', () => {
    expect(describeAge(base - 10_000, base)).toBe('только что');
    expect(describeAge(base - 5 * 60_000, base)).toBe('5 мин назад');
    expect(describeAge(base - 2 * 3_600_000, base)).toBe('2 ч назад');
    expect(describeAge(base - 3 * 86_400_000, base)).toBe('3 дн назад');
    expect(describeAge(base - 60 * 86_400_000, base)).toBe('2 мес назад');
  });

  it('будущее не показывается отрицательным возрастом', () => {
    expect(describeAge(base + 10_000, base)).toBe('только что');
  });
});

describe('formatClock', () => {
  it('печатает местное время с ведущими нулями', () => {
    expect(formatClock(new Date(2020, 0, 1, 9, 5, 7).getTime())).toBe('09:05:07');
  });
});

describe('historyEntryLabel', () => {
  it('собирает время, возраст, размер и причину', () => {
    const at = new Date(2020, 0, 1, 9, 5, 7).getTime();
    expect(historyEntryLabel(entry({ mtimeMs: at, lines: 12 }), at + 300_000)).toBe(
      '09:05:07 · 5 мин назад · 12 стр. · сохранение',
    );
  });
});

describe('historyKey', () => {
  it('берёт путь от корня рабочей области', () => {
    expect(historyKey('/p', '/p/src/a.ts')).toBe('src/a.ts');
  });

  it('путь вне корня оставляет абсолютным', () => {
    expect(historyKey('/p', '/q/b.ts')).toBe('/q/b.ts');
  });

  it('сам корень даёт имя файла, а не пустую строку', () => {
    expect(historyKey('/p', '/p')).toBe('p');
  });

  it('разбирает пути Windows', () => {
    expect(historyKey('C:\\p', 'C:\\p\\src\\a.ts')).toBe('src\\a.ts');
  });
});

describe('sanitizeHistoryEntries', () => {
  it('на не-массив даёт пустой список', () => {
    expect(sanitizeHistoryEntries(null)).toEqual([]);
    expect(sanitizeHistoryEntries({ id: 'x' })).toEqual([]);
  });

  it('отбрасывает записи без id или пути', () => {
    const raw = [{ id: 'ok', path: '/p/a.ts' }, { path: '/p/b.ts' }, { id: 'no-path' }, 42, null];
    expect(sanitizeHistoryEntries(raw).map((item) => item.id)).toEqual(['ok']);
  });

  it('дополняет недостающие поля разумными умолчаниями', () => {
    const [only] = sanitizeHistoryEntries([{ id: 'x', path: '/p/dir/a.ts' }]);
    expect(only).toEqual({
      id: 'x',
      path: '/p/dir/a.ts',
      name: 'a.ts',
      mtimeMs: 0,
      size: 0,
      lines: 1,
      hash: '',
      reason: 'save',
    });
  });

  it('незнакомая причина сводится к сохранению', () => {
    const [only] = sanitizeHistoryEntries([{ id: 'x', path: '/p/a.ts', reason: 'ebf' }]);
    expect(only!.reason).toBe('save');
  });
});
