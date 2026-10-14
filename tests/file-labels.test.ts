import { describe, expect, it } from 'vitest';
import {
  FILE_LABEL_IDS,
  fileLabelName,
  isFileLabelId,
  labelCounts,
  labelOf,
  sanitizeLabels,
  setLabel,
  type FileLabelRecord,
} from '../src/shared/file-labels';

describe('fileLabelName и набор меток', () => {
  it('у каждой метки есть читаемое имя', () => {
    expect(fileLabelName('red')).toBe('Красная');
    expect(FILE_LABEL_IDS.every((id) => fileLabelName(id).length > 0)).toBe(true);
  });

  it('чужие значения не проходят проверку', () => {
    expect(isFileLabelId('red')).toBe(true);
    expect(isFileLabelId('crimson')).toBe(false);
    expect(isFileLabelId(42)).toBe(false);
    expect(isFileLabelId(null)).toBe(false);
  });
});

describe('sanitizeLabels: записи из сессии', () => {
  const root = '/p/root';

  it('оставляет годные записи внутри проекта', () => {
    const records = [
      { path: '/p/root/a.ts', label: 'red' },
      { path: '/p/root/src/b.ts', label: 'green' },
    ];
    expect(sanitizeLabels(records, root)).toEqual([
      { path: '/p/root/a.ts', label: 'red' },
      { path: '/p/root/src/b.ts', label: 'green' },
    ]);
  });

  it('отбрасывает чужие пути, неизвестные цвета и мусор', () => {
    const records = [
      { path: '/other/a.ts', label: 'red' },
      { path: '/p/root/a.ts', label: 'crimson' },
      { path: 7, label: 'red' },
      null,
      'строка',
      { path: '/p/root/b.ts', label: 'blue' },
    ];
    expect(sanitizeLabels(records, root)).toEqual([{ path: '/p/root/b.ts', label: 'blue' }]);
  });

  it('дубли по пути схлопываются: остаётся последняя метка', () => {
    const records = [
      { path: '/p/root/a.ts', label: 'red' },
      { path: '/p/root/a.ts', label: 'purple' },
    ];
    expect(sanitizeLabels(records, root)).toEqual([{ path: '/p/root/a.ts', label: 'purple' }]);
  });

  it('без корня и на не-массиве — пусто', () => {
    expect(sanitizeLabels([{ path: '/p/root/a.ts', label: 'red' }], null)).toEqual([]);
    expect(sanitizeLabels(undefined, root)).toEqual([]);
  });
});

describe('setLabel: поставить, заменить, снять', () => {
  const base: FileLabelRecord[] = [
    { path: '/p/a.ts', label: 'red' },
    { path: '/p/b.ts', label: 'blue' },
  ];

  it('ставит метку новому файлу', () => {
    expect(setLabel(base, '/p/c.ts', 'green')).toEqual([...base, { path: '/p/c.ts', label: 'green' }]);
  });

  it('заменяет прежнюю метку, не плодя вторую', () => {
    expect(setLabel(base, '/p/a.ts', 'yellow')).toEqual([
      { path: '/p/b.ts', label: 'blue' },
      { path: '/p/a.ts', label: 'yellow' },
    ]);
  });

  it('снимает метку при `null`', () => {
    expect(setLabel(base, '/p/a.ts', null)).toEqual([{ path: '/p/b.ts', label: 'blue' }]);
  });

  it('снятие отсутствующей метки ничего не меняет', () => {
    expect(setLabel(base, '/p/нет.ts', null)).toEqual(base);
  });
});

describe('labelOf и labelCounts', () => {
  const records: FileLabelRecord[] = [
    { path: '/p/a.ts', label: 'red' },
    { path: '/p/b.ts', label: 'red' },
    { path: '/p/c.ts', label: 'blue' },
  ];

  it('читает метку файла', () => {
    expect(labelOf(records, '/p/a.ts')).toBe('red');
    expect(labelOf(records, '/p/нет.ts')).toBeNull();
  });

  it('считает файлы по меткам', () => {
    const counts = labelCounts(records);
    expect(counts.red).toBe(2);
    expect(counts.blue).toBe(1);
    expect(counts.green).toBe(0);
  });
});
