import { describe, expect, it } from 'vitest';
import {
  formatLintReport,
  lintEngine,
  nodeLintOrder,
  nodeLintPackage,
  parseBiomeJson,
  parseEslintJson,
  parseRuffJson,
} from '../src/shared/lint';

/**
 * Разбор вывода линтеров и сборка отчёта. Правило, а не запуск: проверяем
 * на строках ответов, а не на живых инструментах — их аргументы и формы ответов
 * у каждого свои, и разбор это единственное, что у нас тут своего.
 */

describe('parseRuffJson', () => {
  it('читает форму location {row, column}', () => {
    const raw = JSON.stringify([
      { filename: 'src/a.py', code: 'F401', message: '`os` imported but unused', location: { row: 1, column: 8 } },
    ]);
    expect(parseRuffJson(raw)).toEqual([
      { path: 'src/a.py', line: 1, column: 8, severity: 'warning', code: 'F401', message: '`os` imported but unused' },
    ]);
  });

  it('понимает старое плоское {row, col}', () => {
    const raw = JSON.stringify([{ filename: 'a.py', code: 'E501', message: 'too long', row: 3, col: 90 }]);
    expect(parseRuffJson(raw)).toEqual([
      { path: 'a.py', line: 3, column: 90, severity: 'warning', code: 'E501', message: 'too long' },
    ]);
  });

  it('пустой массив — это «проблем нет», а не ошибка', () => {
    expect(parseRuffJson('[]')).toEqual([]);
  });

  it('не JSON-массив — не наш ответ', () => {
    expect(parseRuffJson('')).toBeNull();
    expect(parseRuffJson('No module named ruff')).toBeNull();
    expect(parseRuffJson('{"unexpected":true}')).toBeNull();
  });
});

describe('parseBiomeJson', () => {
  it('читает diagnostics и сокращает category до имени правила', () => {
    const raw = JSON.stringify({
      diagnostics: [
        {
          severity: 'warning',
          message: 'This variable unused is unused.',
          category: 'lint/correctness/noUnusedVariables',
          location: { path: 'a.js', start: { line: 2, column: 9 } },
        },
      ],
    });
    expect(parseBiomeJson(raw)).toEqual([
      {
        path: 'a.js',
        line: 2,
        column: 9,
        severity: 'warning',
        code: 'noUnusedVariables',
        message: 'This variable unused is unused.',
      },
    ]);
  });

  it('уровень error переносится как есть, прочие — предупреждение', () => {
    const raw = JSON.stringify({
      diagnostics: [
        {
          severity: 'error',
          message: 'e',
          category: 'a/b/x',
          location: { path: 'a.js', start: { line: 1, column: 1 } },
        },
        {
          severity: 'info',
          message: 'i',
          category: 'a/b/y',
          location: { path: 'a.js', start: { line: 1, column: 1 } },
        },
      ],
    });
    expect(parseBiomeJson(raw)?.map((problem) => problem.severity)).toEqual(['error', 'info']);
  });

  it('объект без diagnostics — не наш ответ', () => {
    expect(parseBiomeJson('{}')).toBeNull();
    expect(parseBiomeJson('[]')).toBeNull();
  });
});

describe('parseEslintJson', () => {
  it('разбирает сообщения по файлам и кодирует уровень числом', () => {
    const raw = JSON.stringify([
      {
        filePath: '/proj/src/a.ts',
        messages: [
          { ruleId: 'no-unused-vars', severity: 2, message: 'unused', line: 4, column: 7 },
          { ruleId: 'no-console', severity: 1, message: 'console', line: 9, column: 3 },
        ],
      },
    ]);
    expect(parseEslintJson(raw)).toEqual([
      { path: '/proj/src/a.ts', line: 4, column: 7, severity: 'error', code: 'no-unused-vars', message: 'unused' },
      { path: '/proj/src/a.ts', line: 9, column: 3, severity: 'warning', code: 'no-console', message: 'console' },
    ]);
  });

  it('пропуск позиции означает первую строку, а не мусор', () => {
    const raw = JSON.stringify([{ filePath: 'a.js', messages: [{ ruleId: 'x', severity: 2, message: 'm' }] }]);
    expect(parseEslintJson(raw)).toEqual([
      { path: 'a.js', line: 1, column: 1, severity: 'error', code: 'x', message: 'm' },
    ]);
  });

  it('не массив — не наш ответ', () => {
    expect(parseEslintJson('{"x":1}')).toBeNull();
    expect(parseEslintJson('')).toBeNull();
  });
});

describe('formatLintReport', () => {
  const problem = {
    path: 'b.ts',
    line: 2,
    column: 1,
    severity: 'warning' as const,
    code: 'noX',
    message: 'msg',
  };

  it('при отсутствии проблем говорит об этом словами', () => {
    const report = formatLintReport({ tool: 'biome', target: '.', problems: [] });
    expect(report.summary).toBe('biome: проблем нет');
    expect(report.detail).toContain('не нашёл проблем');
  });

  it('считает ошибки и предупреждения отдельно', () => {
    const report = formatLintReport({
      tool: 'ruff',
      target: 'src',
      problems: [problem, { ...problem, severity: 'error', code: 'E' }],
    });
    expect(report.summary).toBe('ruff: проблем 2 (ошибок 1, предупреждений 1)');
  });

  it('сортирует по файлу и позиции', () => {
    const report = formatLintReport({
      tool: 'biome',
      target: '.',
      problems: [
        { ...problem, path: 'z.ts', line: 2 },
        { ...problem, path: 'a.ts', line: 5 },
        { ...problem, path: 'a.ts', line: 1 },
      ],
    });
    expect(report.detail.split('\n').map((line) => line.split(' ')[0])).toEqual(['a.ts:1:1', 'a.ts:5:1', 'z.ts:2:1']);
  });

  it('длинный список обрезается, но число проблем названо', () => {
    const problems = Array.from({ length: 105 }, (_value, index) => ({ ...problem, line: index + 1 }));
    const report = formatLintReport({ tool: 'eslint', target: '.', problems });
    expect(report.summary).toBe('eslint: проблем 105 (ошибок 0, предупреждений 105)');
    expect(report.detail).toContain('… ещё проблем: 5');
  });
});

describe('выбор движка и инструментов', () => {
  it('язык называет движок, прочие — нечем проверять', () => {
    expect(lintEngine('python')).toBe('python');
    expect(lintEngine('typescript')).toBe('node');
    expect(lintEngine('markdown')).toBeNull();
    expect(lintEngine('')).toBeNull();
  });

  it('объявленный в проекте инструмент идёт первым', () => {
    expect(nodeLintOrder(['eslint'])[0]).toBe('eslint');
    expect(nodeLintOrder(['@biomejs/biome'])[0]).toBe('biome');
    // Не объявлен ни один — порядок обычный: eslint, затем biome.
    expect(nodeLintOrder([])).toEqual(['eslint', 'biome']);
  });

  it('пакет инструмента — по имени пакета в node_modules', () => {
    expect(nodeLintPackage('eslint')).toBe('eslint');
    expect(nodeLintPackage('biome')).toBe('@biomejs/biome');
  });
});
