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

/**
 * TypeScript 7 — это два пакета: оболочка `typescript` и платформенный
 * `@typescript/typescript-<платформа>` с самим компилятором. Копия одной оболочки
 * падает с «Unable to resolve … Either your platform is unsupported», поэтому
 * копируем оба: иначе тест проверял бы не проект, а собственную подготовку.
 */
async function copyTypeScript(dir: string): Promise<void> {
  await fs.cp(path.join(process.cwd(), 'node_modules', 'typescript'), path.join(dir, 'node_modules', 'typescript'), {
    recursive: true,
  });
  const platform = `typescript-${process.platform}-${process.arch}`;
  const from = path.join(process.cwd(), 'node_modules', '@typescript', platform);
  // Платформенный пакет необязателен: без него tsc в этой системе просто не работает,
  // и тогда тест не имеет смысла — о нём честно сообщаем пропуском.
  await fs
    .cp(from, path.join(dir, 'node_modules', '@typescript', platform), { recursive: true })
    .catch(() => undefined);
}

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

  it('настоящий прогон tsc находит ошибку типа и отдаёт её путём проекта', async () => {
    // Единственная проверка, где работает настоящий tsc: остальные проверяют отказы
    // до запуска. Здесь же — разбор живого вывода и превращение пути в абсолютный.
    const dir = await makeRoot();
    await fs.writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ['*.ts'] }),
    );
    await fs.writeFile(path.join(dir, 'bad.ts'), 'const n: number = "строка";\n');
    await copyTypeScript(dir);

    const result = await typecheckProject(dir, { budgetMs: 120_000 });

    expect(result.tool).toBe('tsc');
    const problem = result.problems.find((entry) => entry.path.endsWith('bad.ts'));
    expect(problem, `вывод tsc: ${result.note}`).toBeDefined();
    // tsc печатает путь со `/` даже на Windows — сравниваем по файлу, а не по строке.
    expect(problem?.path && path.normalize(problem.path)).toBe(path.join(dir, 'bad.ts'));
    expect(problem?.severity).toBe('error');
    expect(problem?.message).toContain('string');
    expect(problem?.code).toBe('TS2322');
  }, 180_000);

  it('нулевой бюджет значит «без ограничения», а не «не проверять»', async () => {
    // Ноль в контракте — именно «без потолка» (так гоняют тесты): проверка же
    // должна состояться, иначе пустой ответ читался бы как чистый проект.
    const dir = await makeRoot();
    await fs.writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { noEmit: true, skipLibCheck: true }, include: ['*.ts'] }),
    );
    await fs.writeFile(path.join(dir, 'clean.ts'), 'export const n: number = 1;\n');
    await copyTypeScript(dir);

    const result = await typecheckProject(dir, { budgetMs: 0 });

    expect(result.tool).toBe('tsc');
    expect(result.problems).toEqual([]);
    expect(result.timedOut).toBe(false);
  }, 180_000);
});
