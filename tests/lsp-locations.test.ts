import { describe, expect, it } from 'vitest';
import { formatLocations, toLocations, uniqueLocations } from '../src/shared/lsp-locations';

/**
 * Разбор ответов LSP про локации (определение и ссылки) и сборка отчёта. Правило,
 * а не запуск: проверяем на строках ответа, а не на живом сервере — у серверов
 * формы ответа разные (`Location` и `LocationLink`), и разбор это единственное,
 * что у нас тут своего.
 */

const toPath = (uri: string): string => uri.replace('file://', '');

describe('toLocations', () => {
  it('читает Location с uri и range, переводя позиции в 1-based', () => {
    const raw = [
      { uri: 'file:///proj/a.ts', range: { start: { line: 4, character: 6 }, end: { line: 4, character: 9 } } },
    ];
    expect(toLocations(raw, toPath)).toEqual([{ path: '/proj/a.ts', line: 5, column: 7 }]);
  });

  it('понимает LocationLink (targetUri и targetSelectionRange)', () => {
    const raw = [
      {
        targetUri: 'file:///proj/b.ts',
        targetSelectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      },
    ];
    expect(toLocations(raw, toPath)).toEqual([{ path: '/proj/b.ts', line: 1, column: 1 }]);
  });

  it('одиночный Location, а не массив, тоже принимается', () => {
    const raw = { uri: 'file:///proj/a.ts', range: { start: { line: 1, character: 2 } } };
    expect(toLocations(raw, toPath)).toEqual([{ path: '/proj/a.ts', line: 2, column: 3 }]);
  });

  it('битые записи пропускаются, а не ломают разбор', () => {
    const raw = [null, {}, { uri: 42 }, { uri: 'file:///ok.ts', range: { start: { line: 2 } } }];
    expect(toLocations(raw, toPath)).toEqual([{ path: '/ok.ts', line: 3, column: 1 }]);
  });

  it('пустой ответ — пустой список', () => {
    expect(toLocations(null, toPath)).toEqual([]);
    expect(toLocations([], toPath)).toEqual([]);
  });
});

describe('uniqueLocations', () => {
  it('убирает повторы и сортирует по файлу и позиции', () => {
    const locations = [
      { path: '/b.ts', line: 1, column: 1 },
      { path: '/a.ts', line: 5, column: 1 },
      { path: '/a.ts', line: 1, column: 3 },
      { path: '/a.ts', line: 1, column: 3 },
    ];
    expect(uniqueLocations(locations)).toEqual([
      { path: '/a.ts', line: 1, column: 3 },
      { path: '/a.ts', line: 5, column: 1 },
      { path: '/b.ts', line: 1, column: 1 },
    ]);
  });
});

describe('formatLocations', () => {
  const relative = (path: string): string => path.replace('/proj/', '');

  it('без мест говорит об этом словами', () => {
    const report = formatLocations('ссылки на X', [], relative);
    expect(report.summary).toBe('ссылки на X: ничего не найдено');
    expect(report.detail).toContain('не нашёл мест');
  });

  it('считает места и файлы, пути отдаёт относительными', () => {
    const report = formatLocations(
      'ссылки на X',
      [
        { path: '/proj/src/a.ts', line: 3, column: 1 },
        { path: '/proj/src/b.ts', line: 7, column: 2 },
      ],
      relative,
    );
    expect(report.summary).toBe('ссылки на X: мест 2 в 2 файлах');
    expect(report.detail.split('\n')).toEqual(['src/a.ts:3:1', 'src/b.ts:7:2']);
  });

  it('одно место в одном файле — согласование в единственном числе', () => {
    const report = formatLocations('определение Y', [{ path: '/proj/a.ts', line: 1, column: 1 }], relative);
    expect(report.summary).toBe('определение Y: мест 1 в 1 файле');
  });

  it('длинный список обрезается, но число мест названо', () => {
    const locations = Array.from({ length: 105 }, (_value, index) => ({
      path: `/proj/a.ts`,
      line: index + 1,
      column: 1,
    }));
    const report = formatLocations('ссылки', locations, relative);
    expect(report.summary).toBe('ссылки: мест 105 в 1 файле');
    expect(report.detail).toContain('… ещё мест: 5');
  });
});
