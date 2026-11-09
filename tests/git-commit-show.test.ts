import { describe, expect, it } from 'vitest';
import { parseNumstat } from '../src/main/git/show-commit';

/**
 * Разбор `git show --numstat` для «#commit»: список файлов с числом строк.
 * Здесь единственное, что можно проверить без живого репозитория.
 */
describe('parseNumstat', () => {
  it('читает добавленные и удалённые строки', () => {
    const status = new Map([['src/a.ts', 'modified' as const]]);
    const files = parseNumstat(['12\t3\tsrc/a.ts'], status);
    expect(files).toEqual([
      { path: 'src/a.ts', status: 'modified', insertions: 12, deletions: 3 },
    ]);
  });

  it('бинарник (`-`) даёт нули, а не выдуманное число', () => {
    const files = parseNumstat(['-\t-\tlogo.png'], new Map());
    expect(files[0]).toMatchObject({ path: 'logo.png', insertions: 0, deletions: 0 });
  });

  it('путь с табуляцией не рвётся на части', () => {
    const files = parseNumstat(['1\t1\tweird\tname.ts'], new Map());
    expect(files[0]!.path).toBe('weird\tname.ts');
  });

  it('строки статуса и пустые пропускаются', () => {
    const files = parseNumstat(['', 'M\tsrc/a.ts', '3\t1\tsrc/b.ts'], new Map());
    expect(files.map((file) => file.path)).toEqual(['src/b.ts']);
  });

  it('неизвестный статус — other, а не выдуманный «изменён»', () => {
    expect(parseNumstat(['1\t0\tx.ts'], new Map())[0]!.status).toBe('other');
  });
});
