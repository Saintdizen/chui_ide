import { describe, expect, it } from 'vitest';
import { parseCoverageJson } from '../src/shared/coverage-json';

/**
 * Разбор JSON-отчёта покрытия (coverage.py). Главное здесь — ветви: строка считается
 * «частично пройденной», только если с неё ушли и исполненные, и неисполненные дуги.
 * Если считать иначе, подсветка загорится на всех условиях подряд.
 */
describe('parseCoverageJson', () => {
  const report = {
    files: {
      'src/a.py': {
        executed_lines: [1, 2, 4],
        missing_lines: [5],
        executed_branches: [
          [3, 4],
          [3, 7],
        ],
        missing_branches: [[3, 9]],
      },
      'src/b.py': {
        executed_lines: [1],
        missing_lines: [2, 3],
        executed_branches: [],
        missing_branches: [],
      },
      'src/ok.py': {
        executed_lines: [1, 2],
        missing_lines: [],
        executed_branches: [],
        missing_branches: [],
      },
    },
    totals: { percent_covered: 87.5 },
  };

  it('читает непокрытые строки и общий процент', () => {
    const parsed = parseCoverageJson(JSON.stringify(report));
    expect(parsed.total).toBe(87.5);
    const a = parsed.files.find((file) => file.path === 'src/a.py');
    expect(a?.missingLines).toEqual([5]);
  });

  it('частичная ветвь — где есть и исполненные, и неисполненные дуги', () => {
    const parsed = parseCoverageJson(JSON.stringify(report));
    const a = parsed.files.find((file) => file.path === 'src/a.py');
    // Строка 3: две дуги исполнены, одна нет — значит ветвь пройдена наполовину.
    expect(a?.partialLines).toEqual([3]);
  });

  it('строка только с неисполненными дугами частичной не считается', () => {
    const parsed = parseCoverageJson(
      JSON.stringify({ files: { 'a.py': { missing_lines: [], executed_branches: [], missing_branches: [[5, 6]] } } }),
    );
    // Ни непокрытых строк, ни частичных ветвей — файлу нечего подсвечивать, он в отчёт не идёт.
    expect(parsed.files).toEqual([]);
  });

  it('строка только с исполненными дугами частичной тоже не считается', () => {
    const parsed = parseCoverageJson(
      JSON.stringify({ files: { 'a.py': { missing_lines: [], executed_branches: [[5, 6]], missing_branches: [] } } }),
    );
    // Файл вообще не попал в отчёт: подсвечивать нечего.
    expect(parsed.files).toEqual([]);
  });

  it('файлы без замечаний пропускаются', () => {
    const parsed = parseCoverageJson(JSON.stringify(report));
    expect(parsed.files.map((file) => file.path).sort()).toEqual(['src/a.py', 'src/b.py']);
  });

  it('непокрытые строки сортируются по номеру', () => {
    const parsed = parseCoverageJson(
      JSON.stringify({ files: { 'a.py': { missing_lines: [9, 2, 5], executed_branches: [], missing_branches: [] } } }),
    );
    expect(parsed.files[0]?.missingLines).toEqual([2, 5, 9]);
  });

  it('битый JSON и чужой формат дают пустой отчёт', () => {
    expect(parseCoverageJson('не json')).toEqual({ files: [], total: null });
    expect(parseCoverageJson('[]')).toEqual({ files: [], total: null });
    expect(parseCoverageJson('{"files": 5}')).toEqual({ files: [], total: null });
  });

  it('без totals процент не выдумывается', () => {
    expect(parseCoverageJson('{"files": {}}').total).toBeNull();
  });

  it('нечисловые строки в списках отбрасываются', () => {
    const parsed = parseCoverageJson(
      JSON.stringify({
        files: { 'a.py': { missing_lines: [1, 'нет', null, 2], executed_branches: [], missing_branches: [] } },
      }),
    );
    expect(parsed.files[0]?.missingLines).toEqual([1, 2]);
  });
});
