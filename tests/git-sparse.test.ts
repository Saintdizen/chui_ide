import { describe, expect, it } from 'vitest';
import {
  addSparseDirectory,
  emptySparseInfo,
  explicitPatterns,
  isConePatterns,
  normalizeSparseDirectory,
  parseSparseFlag,
  parseSparseList,
  removeSparseDirectory,
  sparseDirectories,
  sparseSummary,
} from '../src/shared/git-sparse';

describe('parseSparseFlag', () => {
  it('истина только на true', () => {
    expect(parseSparseFlag('true')).toBe(true);
    expect(parseSparseFlag('TRUE')).toBe(true);
    expect(parseSparseFlag(' true\n')).toBe(true);
    expect(parseSparseFlag('false')).toBe(false);
    expect(parseSparseFlag('')).toBe(false);
    expect(parseSparseFlag('1')).toBe(false);
  });
});

describe('parseSparseList', () => {
  it('по строке на шаблон, пустые строки мимо', () => {
    expect(parseSparseList('/*\n!/*/\n/src/\n')).toEqual(['/*', '!/*/', '/src/']);
    expect(parseSparseList('')).toEqual([]);
    expect(parseSparseList('\n\n')).toEqual([]);
  });

  it('пробелы по краям убираются', () => {
    expect(parseSparseList('  /src/  \n\t/tests/\t')).toEqual(['/src/', '/tests/']);
  });
});

describe('cone-режим', () => {
  const conePatterns = ['/*', '!/*/', '/src/', '!/src/*/', '/src/lib/'];

  it('служебная строка выдаёт cone-режим', () => {
    expect(isConePatterns(conePatterns)).toBe(true);
    expect(isConePatterns(['/src/', '/tests/'])).toBe(false);
  });

  it('каталоги — только строки-каталоги, без служебных', () => {
    expect(sparseDirectories(conePatterns)).toEqual(['src', 'src/lib']);
  });

  it('не-cone шаблоны каталогами не считаются', () => {
    expect(sparseDirectories(['*.md', '!docs/', '/src/'])).toEqual(['src']);
  });

  it('явные шаблоны — без служебных строк', () => {
    expect(explicitPatterns(conePatterns)).toEqual(['/src/', '!/src/*/', '/src/lib/']);
  });
});

describe('normalizeSparseDirectory', () => {
  it('снимает слэши и обратные слэши', () => {
    expect(normalizeSparseDirectory('src')).toBe('src');
    expect(normalizeSparseDirectory('/src/')).toBe('src');
    expect(normalizeSparseDirectory('src/lib')).toBe('src/lib');
    expect(normalizeSparseDirectory('src\\lib')).toBe('src/lib');
    expect(normalizeSparseDirectory('  tests  ')).toBe('tests');
  });

  it('отвергает небезопасное', () => {
    expect(normalizeSparseDirectory('')).toBeNull();
    expect(normalizeSparseDirectory('.')).toBeNull();
    expect(normalizeSparseDirectory('..')).toBeNull();
    expect(normalizeSparseDirectory('src/../etc')).toBeNull();
    expect(normalizeSparseDirectory('/')).toBeNull();
    expect(normalizeSparseDirectory('a//b')).toBeNull();
    expect(normalizeSparseDirectory('*.md')).toBeNull();
  });
});

describe('addSparseDirectory / removeSparseDirectory', () => {
  it('добавляет без повторов и мусора', () => {
    expect(addSparseDirectory(['src'], 'tests')).toEqual(['src', 'tests']);
    expect(addSparseDirectory(['src'], 'src')).toEqual(['src']);
    expect(addSparseDirectory(['src'], '/src/')).toEqual(['src']);
    expect(addSparseDirectory(['src'], '..')).toEqual(['src']);
  });

  it('вложенный каталог добавляется отдельно', () => {
    expect(addSparseDirectory(['src'], 'src/lib')).toEqual(['src', 'src/lib']);
  });

  it('удаляет по нормализованному виду', () => {
    expect(removeSparseDirectory(['src', 'tests'], '/src/')).toEqual(['tests']);
    expect(removeSparseDirectory(['src'], '..')).toEqual(['src']);
  });
});

describe('sparseSummary', () => {
  it('выключенный режим — весь репозиторий на диске', () => {
    expect(sparseSummary(emptySparseInfo())).toContain('весь репозиторий');
  });

  it('cone: число каталогов', () => {
    expect(sparseSummary({ enabled: true, cone: true, patterns: ['/*', '!/*/', '/src/', '/tests/'] })).toContain(
      'каталогов: 2',
    );
    expect(sparseSummary({ enabled: true, cone: true, patterns: ['/*', '!/*/', '/src/'] })).toContain('1 каталог');
  });

  it('cone без каталогов и не-cone с шаблонами', () => {
    expect(sparseSummary({ enabled: true, cone: true, patterns: ['/*', '!/*/'] })).toContain('каталоги не выбраны');
    expect(sparseSummary({ enabled: true, cone: false, patterns: ['*.md'] })).toContain('1 правило');
  });
});
