import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeProject } from '../src/main/project/analyze';
import { removeTemp } from './temp';

/**
 * Анализ проекта целиком — это процессы (линтер) и файлы (`package.json`,
 * `node_modules`), поэтому проверяем на настоящем temp-проекте: линтер —
 * скрипт-заглушка, который печатает заданный ответ.
 *
 * Главное, что здесь стерегут: проверка говорит, чем она кончилась. «Проверять
 * нечем» и «всё чисто» — разные ответы, и путать их нельзя.
 */

const roots: string[] = [];

afterEach(async () => {
  await removeTemp(roots);
});

/** Заглушка biome: одна находка в `src/a.js`. */
const BIOME_STUB = [
  'process.stdout.write(JSON.stringify({',
  "  command: 'lint',",
  '  diagnostics: [',
  '    {',
  "      severity: 'warning',",
  "      message: 'unused',",
  "      category: 'lint/correctness/noUnusedVariables',",
  "      location: { path: 'src/a.js', start: { line: 2, column: 9 } },",
  '    },',
  '  ],',
  '}));',
].join('\n');

/** Temp-проект: манифест, установленные пакеты-заглушки и папка `src`. */
async function makeProject(input: {
  declared?: string[];
  installed?: { pkg: string; tool: string; script: string }[];
  source?: boolean;
}): Promise<string> {
  // `realpath` обязателен: в macOS `/var` — симлинк, и путь в пометках разошёлся бы с корнем.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-analyze-')));
  roots.push(root);

  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture',
        dependencies: Object.fromEntries((input.declared ?? []).map((name) => [name, '^1.0.0'])),
      },
      null,
      2,
    ),
  );
  if (input.source) {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.js'), 'export const a = 1;\n');
  }

  for (const { pkg, tool, script } of input.installed ?? []) {
    const dir = path.join(root, 'node_modules', pkg);
    await fs.mkdir(path.join(dir, 'bin'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: pkg, version: '1.0.0', bin: { [tool]: 'bin/cli.js' } }),
    );
    await fs.writeFile(path.join(dir, 'bin', 'cli.js'), script);
  }

  return root;
}

describe('analyzeProject', () => {
  it('находки линтера приходят с абсолютными путями и именем инструмента', async () => {
    const root = await makeProject({
      source: true,
      installed: [{ pkg: '@biomejs/biome', tool: 'biome', script: BIOME_STUB }],
    });

    const result = await analyzeProject(root, 'python3');

    expect(result.tool).toBe('biome');
    expect(result.timedOut).toBe(false);
    const [problem] = result.problems;
    expect(problem?.path).toBe(path.join(root, 'src', 'a.js'));
    expect(problem?.line).toBe(2);
    expect(problem?.column).toBe(9);
    expect(problem?.severity).toBe('warning');
    expect(problem?.message).toBe('unused');
    expect(problem?.code).toContain('noUnusedVariables');
  });

  it('неустановленная зависимость — ошибка на строке манифеста', async () => {
    // node_modules есть (иначе это отдельная история про «пустой установки»),
    // но объявленного пакета в нём нет.
    const root = await makeProject({
      declared: ['react'],
      installed: [{ pkg: '@biomejs/biome', tool: 'biome', script: 'process.exit(0);' }],
    });

    const result = await analyzeProject(root, 'python3');

    const dependency = result.problems.find((problem) => problem.source === 'deps');
    expect(dependency?.path).toBe(path.join(root, 'package.json'));
    expect(dependency?.severity).toBe('error');
    expect(dependency?.message).toContain('«react»');
  });
});

describe('analyzeProject: чего не хватило', () => {
  it('без линтера говорит «нечем», а не «чисто»', async () => {
    const root = await makeProject({ source: true });

    const result = await analyzeProject(root, 'python3');

    expect(result.tool).toBeNull();
    expect(result.problems).toEqual([]);
    expect(result.note).toContain('нечем');
  });

  it('пустой node_modules — одна общая ошибка вместо свалки по зависимостям', async () => {
    const root = await makeProject({ declared: ['react', 'vue'] });

    const result = await analyzeProject(root, 'python3');

    const dependency = result.problems.filter((problem) => problem.source === 'deps');
    expect(dependency).toHaveLength(1);
    expect(dependency[0]?.message).toContain('install');
  });

  it('проект без манифеста — зависимостей не проверяем, но код проверяем', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-analyze-')));
    roots.push(root);

    const result = await analyzeProject(root, 'python3');

    expect(result.problems).toEqual([]);
    expect(result.tool).toBeNull();
  });

  it('потолок времени: не успели — так и говорим, строки не выдумываем', async () => {
    const root = await makeProject({
      source: true,
      installed: [{ pkg: '@biomejs/biome', tool: 'biome', script: 'setTimeout(() => {}, 60000);' }],
    });

    const result = await analyzeProject(root, 'python3', { budgetMs: 50 });

    expect(result.timedOut).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.note).toContain('не уложилась');
  });
});
