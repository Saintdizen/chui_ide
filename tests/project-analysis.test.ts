import { describe, expect, it } from 'vitest';
import { limitProblems, lintProblems, lineOfJsonKey, missingDependencyProblems } from '../src/shared/project-analysis';

/** Форма ответа проверки проекта: правила чистые, поэтому и тесты без файлов и процессов. */

const MANIFEST = [
  '{',
  '  "name": "fixture",',
  '  "dependencies": {',
  '    "react": "^18.0.0",',
  '    "react-dom": "^18.0.0"',
  '  }',
  '}',
].join('\n');

describe('lineOfJsonKey', () => {
  it('находит строку объявления по имени целиком, а не по началу', () => {
    expect(lineOfJsonKey(MANIFEST, 'react')).toBe(4);
    expect(lineOfJsonKey(MANIFEST, 'react-dom')).toBe(5);
  });

  it('не нашлось — первая строка: пометка без строки не кликается', () => {
    expect(lineOfJsonKey(MANIFEST, 'vue')).toBe(1);
  });
});

describe('missingDependencyProblems', () => {
  it('каждая неустановленная зависимость — пометка на своей строке', () => {
    const problems = missingDependencyProblems('/p/package.json', MANIFEST, ['react-dom'], 'npm install');
    expect(problems).toEqual([
      {
        path: '/p/package.json',
        line: 5,
        column: 1,
        severity: 'error',
        message: 'Зависимость «react-dom» объявлена, но не установлена: npm install',
        source: 'deps',
      },
    ]);
  });
});

describe('lintProblems', () => {
  it('путь линтера становится абсолютным, а код правила сохраняется', () => {
    const problems = lintProblems('/p', [
      { path: 'src/a.ts', line: 3, column: 2, severity: 'warning', message: 'unused', code: 'noUnusedVariables' },
    ]);
    expect(problems).toEqual([
      {
        path: '/p/src/a.ts',
        line: 3,
        column: 2,
        severity: 'warning',
        message: 'unused',
        source: 'lint',
        code: 'noUnusedVariables',
      },
    ]);
  });

  it('абсолютный путь не переклеивается и хвостовой слэш корня не удваивается', () => {
    const [first] = lintProblems('/p/', [
      { path: '/abs/a.ts', line: 1, column: 1, severity: 'error', message: 'x', code: 'c' },
    ]);
    expect(first?.path).toBe('/abs/a.ts');
    const [second] = lintProblems('/p/', [
      { path: 'b.ts', line: 1, column: 1, severity: 'error', message: 'x', code: 'c' },
    ]);
    expect(second?.path).toBe('/p/b.ts');
  });

  it('Windows: разделитель берётся от корня, а не от того, что прислал инструмент', () => {
    // eslint отдаёт путь с «/» даже на Windows, biome и ruff — тоже.
    const [first] = lintProblems('C:\\work\\p', [
      { path: 'src/a.ts', line: 1, column: 1, severity: 'error', message: 'x', code: 'c' },
    ]);
    expect(first?.path).toBe('C:\\work\\p\\src\\a.ts');

    // Абсолютный путь с чужими разделителями приводим к своим: иначе он не совпадёт
    // ни с одним файлом проекта (`C:/work/p/src/a.ts` ≠ `C:\\work\\p\\src\\a.ts`).
    const [second] = lintProblems('C:\\work\\p', [
      { path: 'C:/work/p/src/b.ts', line: 1, column: 1, severity: 'error', message: 'x', code: 'c' },
    ]);
    expect(second?.path).toBe('C:\\work\\p\\src\\b.ts');
  });
});

describe('limitProblems', () => {
  it('маленький список не трогает', () => {
    expect(limitProblems([])).toEqual({ problems: [], dropped: 0 });
  });

  it('потолок режет список и говорит, сколько осталось за кадром', () => {
    const many = Array.from({ length: 2003 }, () => ({
      path: '/p/a.ts',
      line: 1,
      column: 1,
      severity: 'error' as const,
      message: 'x',
      source: 'lint',
    }));
    const result = limitProblems(many);
    expect(result.problems).toHaveLength(2000);
    expect(result.dropped).toBe(3);
  });
});
