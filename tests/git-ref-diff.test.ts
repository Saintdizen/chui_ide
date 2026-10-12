import { describe, expect, it } from 'vitest';
import { mergeRefDiff, parseNameStatus, parseNumstat } from '../src/shared/git-ref-diff';

/**
 * Разбор сравнения двух ссылок. Записи разделены NUL (git печатает так с `-z`),
 * поэтому и в тесте строки собираются с ним: так проверяется именно то, что даёт git.
 */
const NUL = '\u0000';

describe('parseNameStatus', () => {
  it('обычные статусы читаются как слова', () => {
    const stdout = `M${NUL}src/a.ts${NUL}A${NUL}src/b.ts${NUL}D${NUL}src/c.ts${NUL}`;
    expect([...parseNameStatus(stdout)]).toEqual([
      ['src/a.ts', 'modified'],
      ['src/b.ts', 'added'],
      ['src/c.ts', 'deleted'],
    ]);
  });

  it('переименование берёт НОВЫЙ путь', () => {
    const stdout = `R100${NUL}old/name.ts${NUL}new/name.ts${NUL}`;
    expect([...parseNameStatus(stdout)]).toEqual([['new/name.ts', 'renamed']]);
  });

  it('копия тоже читается как renamed', () => {
    const stdout = `C75${NUL}from.ts${NUL}to.ts${NUL}`;
    expect([...parseNameStatus(stdout)]).toEqual([['to.ts', 'renamed']]);
  });

  it('пустой вывод — пустая карта', () => {
    expect([...parseNameStatus('')]).toEqual([]);
  });
});

describe('parseNumstat', () => {
  it('числа добавленных и удалённых строк', () => {
    const stdout = `3\t1\tsrc/a.ts${NUL}10\t0\tsrc/b.ts${NUL}`;
    expect(parseNumstat(stdout).get('src/a.ts')).toEqual({ additions: 3, deletions: 1 });
    expect(parseNumstat(stdout).get('src/b.ts')).toEqual({ additions: 10, deletions: 0 });
  });

  it('двоичный файл — дефисы вместо чисел, читаем как null', () => {
    expect(parseNumstat(`-${'\t'}-${'\t'}logo.png${NUL}`).get('logo.png')).toEqual({
      additions: null,
      deletions: null,
    });
  });

  it('переименование: путь идёт двумя полями, берём новое', () => {
    const stdout = `5\t2\t${NUL}old.ts${NUL}new.ts${NUL}`;
    expect(parseNumstat(stdout).get('new.ts')).toEqual({ additions: 5, deletions: 2 });
    expect(parseNumstat(stdout).get('old.ts')).toBeUndefined();
  });
});

describe('mergeRefDiff', () => {
  it('сводит статусы и статистику по пути', () => {
    const names = `M${NUL}a.ts${NUL}A${NUL}b.ts${NUL}`;
    const stats = `2\t2\ta.ts${NUL}9\t0\tb.ts${NUL}`;
    expect(mergeRefDiff(names, stats)).toEqual([
      { path: 'a.ts', change: 'modified', additions: 2, deletions: 2 },
      { path: 'b.ts', change: 'added', additions: 9, deletions: 0 },
    ]);
  });

  it('файл без статистики получает null, а не ноль', () => {
    const names = `M${NUL}a.ts${NUL}`;
    expect(mergeRefDiff(names, '')).toEqual([{ path: 'a.ts', change: 'modified', additions: null, deletions: null }]);
  });
});
