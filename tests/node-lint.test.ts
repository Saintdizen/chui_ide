import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lintNode } from '../src/main/node/lint';
import { lintProject } from '../src/main/project/lint';

/**
 * Проверка линтером инструментом проекта — это про процессы и `node_modules`,
 * поэтому проверяем на настоящем проекте в temp-каталоге: заглушки инструментов —
 * обычные скрипты, которые печатают заранее заданный машиночитаемый ответ.
 *
 * Так проверяется вся связка: поиск скрипта по полю `bin`, запуск найденным Node,
 * аргументы под конкретный инструмент и разбор ответа.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** Заглушка biome: печатает свой JSON-ответ и ничего больше не делает. */
const BIOME_STUB = [
  'process.stdout.write(JSON.stringify({',
  "  command: 'lint',",
  '  diagnostics: [',
  '    {',
  "      severity: 'warning',",
  "      message: 'This variable unused is unused.',",
  "      category: 'lint/correctness/noUnusedVariables',",
  "      location: { path: 'a.js', start: { line: 2, column: 9 } },",
  '    },',
  '  ],',
  '}));',
].join('\n');

/** Заглушка eslint: путь к цели делает абсолютным, как настоящий eslint. */
const ESLINT_STUB = [
  "const path = require('node:path');",
  'const target = process.argv[2];',
  'process.stdout.write(JSON.stringify([',
  '  {',
  '    filePath: path.resolve(target),',
  "    messages: [{ ruleId: 'no-unused-vars', severity: 2, message: 'unused', line: 3, column: 5 }],",
  '  },',
  ']));',
].join('\n');

/** Проект в temp-каталоге: `package.json` и заглушки пакетов с их `bin`. */
async function makeProject(input: {
  declared?: readonly string[];
  manifests?: Record<string, string>;
  installed?: ReadonlyArray<{ pkg: string; tool: string; script: string }>;
}): Promise<string> {
  // Каталог разворачиваем: на macOS `tmpdir()` — `/var/folders/…` через симлинк
  // на `/private/var/…`, а заглушка eslint (как и настоящая) печатает путь от
  // `process.cwd()` дочернего процесса — тот же канонический вид. Иначе
  // относительный путь в отчёте обрастал бы `../../..`. Приём — как в `debug.test.ts`.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-node-lint-')));
  roots.push(root);

  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      dependencies: Object.fromEntries((input.declared ?? []).map((n) => [n, '^1.0.0'])),
    }),
  );
  for (const [name, contents] of Object.entries(input.manifests ?? {})) {
    await fs.writeFile(path.join(root, name), contents);
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

describe('lintNode', () => {
  it('запускает biome проекта и разбирает его ответ', async () => {
    const root = await makeProject({ installed: [{ pkg: '@biomejs/biome', tool: 'biome', script: BIOME_STUB }] });

    const outcome = await lintNode(root, '.');

    expect(outcome.tool).toBe('biome');
    expect(outcome.problems).toEqual([
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

  it('eslint зовётся со своим форматом, а абсолютные пути становятся относительными', async () => {
    const root = await makeProject({ installed: [{ pkg: 'eslint', tool: 'eslint', script: ESLINT_STUB }] });

    const outcome = await lintNode(root, 'a.ts');

    expect(outcome.tool).toBe('eslint');
    expect(outcome.problems).toEqual([
      { path: 'a.ts', line: 3, column: 5, severity: 'error', code: 'no-unused-vars', message: 'unused' },
    ]);
  });

  it('объявленный в проекте инструмент важнее просто установленного', async () => {
    const root = await makeProject({
      declared: ['eslint'],
      installed: [
        { pkg: 'eslint', tool: 'eslint', script: ESLINT_STUB },
        { pkg: '@biomejs/biome', tool: 'biome', script: BIOME_STUB },
      ],
    });

    expect((await lintNode(root, '.')).tool).toBe('eslint');
  });

  it('инструментов нет — «нечем проверить», а не «проблем нет»', async () => {
    const root = await makeProject({});
    expect(await lintNode(root, '.')).toEqual({ tool: null, problems: [] });
  });

  it('инструмент ответил не своим форматом — считаем, что он не отработал', async () => {
    const root = await makeProject({
      installed: [{ pkg: '@biomejs/biome', tool: 'biome', script: "process.stdout.write('not json');" }],
    });

    expect(await lintNode(root, '.')).toEqual({ tool: null, problems: [] });
  });
});

describe('lintProject', () => {
  it('в Node-проекте (package.json) берётся инструмент Node', async () => {
    const root = await makeProject({ installed: [{ pkg: '@biomejs/biome', tool: 'biome', script: BIOME_STUB }] });

    expect((await lintProject(root, 'python3')).tool).toBe('biome');
  });

  it('цель с расширением .py уходит питоновскому движку, а не Node', async () => {
    // biome установлен, но цель — python-файл: движок выбирается по расширению,
    // поэтому Node-инструмент не трогаем (а питона по заведомо битому имени нет).
    const root = await makeProject({ installed: [{ pkg: '@biomejs/biome', tool: 'biome', script: BIOME_STUB }] });

    const outcome = await lintProject(root, 'chui-no-such-python-xyz', path.join(root, 'src', 'a.py'));

    expect(outcome).toEqual({ tool: null, problems: [] });
  });
});
