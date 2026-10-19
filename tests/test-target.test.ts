import { describe, expect, it } from 'vitest';
import {
  MAX_TEST_TARGET_CHARS,
  looksLikePath,
  testTargetArgs,
  testTargetLabel,
  testTargetProblem,
} from '../src/shared/test-target';

/**
 * Запуск части тестов вместо всего набора.
 *
 * Прогон всего набора — единственное, что умел `run_tests`. На большом проекте
 * это десятки тысяч строк вывода: агент поправил одну функцию и получил отчёт на
 * четыре тысячи тестов, а контекст уже занят. Раннеры умеют гонять часть — надо
 * только правильно позвать, и по-разному: `-k` у pytest, `-t` у vitest и jest,
 * `--test-name-pattern` у встроенного `node --test`.
 */

describe('testTargetProblem', () => {
  it('пустая цель — не цель', () => {
    expect(testTargetProblem('')).not.toBeNull();
    expect(testTargetProblem('   ')).not.toBeNull();
  });

  it('перевод строки в цели отвергается: это подмешивание второй команды', () => {
    expect(testTargetProblem('src/a.test.ts\nrm -rf /')).not.toBeNull();
  });

  it('слишком длинная цель отвергается', () => {
    expect(testTargetProblem('x'.repeat(MAX_TEST_TARGET_CHARS + 1))).not.toBeNull();
  });

  it('обычные цели проходят', () => {
    expect(testTargetProblem('src/app.test.ts')).toBeNull();
    expect(testTargetProblem('гоняет команду')).toBeNull();
  });
});

describe('looksLikePath', () => {
  it('разделитель каталога — путь', () => {
    expect(looksLikePath('src/app.test.ts')).toBe(true);
    expect(looksLikePath('tests\\unit\\a.py')).toBe(true);
  });

  it('расширение файла — путь', () => {
    expect(looksLikePath('app.test.ts')).toBe(true);
    expect(looksLikePath('test_view.py')).toBe(true);
  });

  it('имя теста — не путь', () => {
    expect(looksLikePath('гоняет команду')).toBe(false);
    expect(looksLikePath('testCommand')).toBe(false);
  });
});

describe('testTargetArgs', () => {
  it('без цели аргументов нет — гоняется весь набор', () => {
    for (const runner of ['pytest', 'vitest', 'jest', 'node'] as const) {
      expect(testTargetArgs(runner, undefined)).toEqual([]);
      expect(testTargetArgs(runner, '  ')).toEqual([]);
    }
  });

  it('путь передаётся позиционно — так понимают все раннеры', () => {
    for (const runner of ['pytest', 'vitest', 'jest', 'node'] as const) {
      expect(testTargetArgs(runner, 'src/app.test.ts')).toEqual(['src/app.test.ts']);
    }
  });

  it('имя теста — своим ключом у каждого раннера', () => {
    expect(testTargetArgs('pytest', 'гоняет команду')).toEqual(['-k', 'гоняет команду']);
    expect(testTargetArgs('vitest', 'гоняет команду')).toEqual(['-t', 'гоняет команду']);
    expect(testTargetArgs('jest', 'гоняет команду')).toEqual(['-t', 'гоняет команду']);
    expect(testTargetArgs('node', 'гоняет команду')).toEqual(['--test-name-pattern', 'гоняет команду']);
  });
});

describe('testTargetLabel', () => {
  it('цель видна в подписи карточки', () => {
    expect(testTargetLabel('vitest')).toBe('vitest');
    expect(testTargetLabel('vitest', 'src/a.test.ts')).toBe('vitest · src/a.test.ts');
  });
});
