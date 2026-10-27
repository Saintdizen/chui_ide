import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { typecheckProject } from '../src/main/project/typecheck';
import { tscProblems } from '../src/shared/project-analysis';

/**
 * Разбор вывода tsc: две формы строки, продолжения игнорируются.
 *
 * Вторая форма (`файл:3:5 - error`) приходит из `tsc -b`, и если её не знать,
 * половина проекта выглядит чистой — ровно та ложь, ради которой всё затевалось.
 */

describe('tscProblems', () => {
  it('разбирает форму файл(строка,колонка)', () => {
    const problems = tscProblems(
      '/proj',
      "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    );

    expect(problems).toEqual([
      {
        path: '/proj/src/a.ts',
        line: 3,
        column: 5,
        severity: 'error',
        message: "Type 'string' is not assignable to type 'number'.",
        source: 'types',
        code: 'TS2322',
      },
    ]);
  });

  it('разбирает форму файл:строка:колонка - error', () => {
    const [problem] = tscProblems('/proj', 'src/b.ts:10:2 - warning TS6133: unused var');

    expect(problem).toMatchObject({ path: '/proj/src/b.ts', line: 10, column: 2, severity: 'warning' });
  });

  it('строки-продолжения и болтовню не считает пометками', () => {
    const text = [
      'src/a.ts(1,1): error TS1: первая строка',
      '  Тип A несовместим с B', // продолжение — не отдельная пометка
      '',
      'Found 1 error.',
    ].join('\n');

    expect(tscProblems('/proj', text)).toHaveLength(1);
  });

  it('абсолютный путь не удваивает корень', () => {
    const [problem] = tscProblems('/proj', '/tmp/x.ts(1,1): error TS1: чужая ошибка');

    expect(problem?.path).toBe('/tmp/x.ts');
  });

  it('пустой вывод — пустой список, а не выдумка', () => {
    expect(tscProblems('/proj', '')).toEqual([]);
  });
});

describe('typecheckProject: называет причину, а не молчит', () => {
  let root = '';
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = '';
  });

  const makeRoot = async (): Promise<string> => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-types-'));
    return root;
  };

  it('нет tsconfig.json — говорим прямо', async () => {
    const dir = await makeRoot();
    const result = await typecheckProject(dir, { budgetMs: 0 });

    expect(result.tool).toBeNull();
    expect(result.problems).toEqual([]);
    expect(result.note).toContain('tsconfig.json');
  });

  it('нет typescript в node_modules — тоже называем причину', async () => {
    const dir = await makeRoot();
    await fs.writeFile(path.join(dir, 'tsconfig.json'), '{"compilerOptions":{}}');

    const result = await typecheckProject(dir, { budgetMs: 0 });

    expect(result.tool).toBeNull();
    expect(result.note).toContain('typescript');
  });
});
