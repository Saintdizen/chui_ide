import { describe, expect, it } from 'vitest';
import { parseNodeCoverage } from '../src/shared/node-coverage';

/**
 * Разбор отчёта покрытия Node (istanbul `coverage-final.json`) — тот, что пишут
 * vitest и jest. Главное здесь: непокрытые строки (по `statementMap`/`s`) и
 * «частично пройденная ветвь» — строка, где часть дуг исполнена, а часть нет.
 * Если считать ветвь частичной по любому неполному проходу, подсветка загорится
 * на всех условиях подряд.
 */
describe('parseNodeCoverage', () => {
  const report = {
    '/p/src/a.ts': {
      path: '/p/src/a.ts',
      statementMap: {
        0: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        1: { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
        2: { start: { line: 5, column: 0 }, end: { line: 5, column: 10 } },
      },
      s: { 0: 3, 1: 0, 2: 1 },
      branchMap: { 0: { line: 5, type: 'if', locations: [{ start: { line: 5 } }, { start: { line: 6 } }] } },
      b: { 0: [1, 0] },
    },
    '/p/src/ok.ts': {
      path: '/p/src/ok.ts',
      statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 4 } } },
      s: { 0: 2 },
      branchMap: {},
      b: {},
    },
  };
  const json = JSON.stringify(report);

  it('читает непокрытые строки и общий процент', () => {
    const parsed = parseNodeCoverage(json);
    const a = parsed.files.find((file) => file.path === '/p/src/a.ts');
    expect(a?.missingLines).toEqual([2]);
    expect(a?.missing).toBe(1);
    expect(a?.statements).toBe(3);
    // Из четырёх строк исполнены три.
    expect(parsed.total).toBe(75);
  });

  it('строка покрыта, если исполнен хоть один оператор на ней', () => {
    // На строке 5 лежит и непокрытый оператор, но другой там исполнен — строка не «непокрыта».
    const parsed = parseNodeCoverage(
      JSON.stringify({
        '/p/a.ts': {
          statementMap: { 0: { start: { line: 5 } }, 1: { start: { line: 5 } } },
          s: { 0: 0, 1: 1 },
          branchMap: {},
          b: {},
        },
      }),
    );
    expect(parsed.files[0]?.missingLines).toEqual([]);
  });

  it('частичная ветвь — где есть и исполненные дуги, и неисполненные', () => {
    const parsed = parseNodeCoverage(json);
    const a = parsed.files.find((file) => file.path === '/p/src/a.ts');
    expect(a?.branchPartial).toBe(1);
    expect(a?.partialLines).toEqual([5]);
    expect(a?.branches).toBe(2);
  });

  it('ветвь со всеми исполненными или всеми неисполненными дугами частичной не считается', () => {
    const parsed = parseNodeCoverage(
      JSON.stringify({
        '/p/a.ts': {
          statementMap: { 0: { start: { line: 1 } } },
          s: { 0: 1 },
          branchMap: { 0: { line: 1 }, 1: { line: 2 } },
          b: { 0: [1, 1], 1: [0, 0] },
        },
      }),
    );
    expect(parsed.files[0]?.branches).toBe(4);
    expect(parsed.files[0]?.branchPartial).toBe(0);
    expect(parsed.files[0]?.partialLines).toEqual([]);
  });

  it('файлы без операторов пропускаются', () => {
    const parsed = parseNodeCoverage(
      JSON.stringify({ '/p/empty.ts': { statementMap: {}, s: {}, branchMap: {}, b: {} } }),
    );
    expect(parsed.files).toEqual([]);
    expect(parsed.total).toBeNull();
  });

  it('файлы отсортированы: самое проблемное — вперёд', () => {
    const parsed = parseNodeCoverage(json);
    expect(parsed.files.map((file) => file.path)).toEqual(['/p/src/a.ts', '/p/src/ok.ts']);
  });

  it('битый JSON и чужой формат дают пустой отчёт', () => {
    expect(parseNodeCoverage('не json')).toEqual({ files: [], total: null });
    expect(parseNodeCoverage('[]')).toEqual({ files: [], total: null });
    expect(parseNodeCoverage('123')).toEqual({ files: [], total: null });
  });

  it('нечисловые счётчики читаются как ноль (строка/undefined)', () => {
    const parsed = parseNodeCoverage(
      JSON.stringify({ '/p/a.ts': { statementMap: { 0: { start: { line: 1 } } }, s: { 0: '0' } } }),
    );
    expect(parsed.files[0]?.missingLines).toEqual([1]);
  });
});
