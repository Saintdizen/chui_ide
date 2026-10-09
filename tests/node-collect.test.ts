import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectNodeTests } from '../src/main/node/tests';

/**
 * Сбор тестов Node-проекта проверяем на настоящем проекте в temp-каталоге: сбор
 * идёт процессами (`vitest list --json`, `jest --listTests --json`), и подделать
 * это заглушкой нечего — заглушками становятся сами раннеры, а весь остальной
 * путь (поиск скрипта по `bin`, запуск, разбор вывода) остаётся настоящим.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** Заглушка раннера: печатает то, что просит тест, — с шумом перед JSON. */
async function writeRunner(root: string, pkg: string, bin: string, body: string): Promise<void> {
  const dir = path.join(root, 'node_modules', pkg);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: pkg, version: '1.0.0', bin: { [bin]: 'bin/cli.js' } }),
  );
  await fs.mkdir(path.join(dir, 'bin'), { recursive: true });
  await fs.writeFile(path.join(dir, 'bin', 'cli.js'), body);
}

async function makeProject(
  dependencies: readonly string[],
  files: readonly string[],
  runners: readonly { pkg: string; bin: string; body: string }[] = [],
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-node-collect-'));
  roots.push(root);

  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', devDependencies: Object.fromEntries(dependencies.map((name) => [name, '^1.0.0'])) }),
  );
  for (const file of files) {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '');
  }
  for (const runner of runners) await writeRunner(root, runner.pkg, runner.bin, runner.body);

  return root;
}

/** Заглушка vitest: печатает предупреждение, а затем JSON — как настоящий list. */
const VITEST_STUB = [
  "console.log('stderr-like noise');",
  'const tests = [',
  "  { name: 'сумма > складывает', file: process.cwd() + '/tests/a.test.ts', location: { line: 3, column: 1 } },",
  '];',
  'console.log(JSON.stringify(tests));',
].join('\n');

/** Заглушка jest: `--listTests --json` отдаёт пути файлов. */
const JEST_STUB = "console.log(JSON.stringify([process.cwd() + '/tests/a.test.js']));";

describe('collectNodeTests', () => {
  it('vitest: список тестов с именами и относительными путями', async () => {
    const root = await makeProject(['vitest'], ['tests/a.test.ts'], [{ pkg: 'vitest', bin: 'vitest', body: VITEST_STUB }]);

    const suite = await collectNodeTests(root);
    expect(suite.runner).toBe('vitest');
    expect(suite.errors).toEqual([]);
    expect(suite.tests).toEqual([
      { id: 'tests/a.test.ts::сумма > складывает', file: 'tests/a.test.ts', className: 'сумма', name: 'складывает' },
    ]);
  });

  it('шум перед JSON не мешает: массив вырезается из вывода', async () => {
    const root = await makeProject(['vitest'], ['tests/a.test.ts'], [{ pkg: 'vitest', bin: 'vitest', body: VITEST_STUB }]);
    expect((await collectNodeTests(root)).tests.length).toBe(1);
  });

  it('jest: узлы-файлы — имён он не отдаёт', async () => {
    const root = await makeProject(['jest'], ['tests/a.test.js'], [{ pkg: 'jest', bin: 'jest', body: JEST_STUB }]);

    const suite = await collectNodeTests(root);
    expect(suite.runner).toBe('jest');
    expect(suite.tests).toEqual([{ id: 'tests/a.test.js', file: 'tests/a.test.js', className: null, name: '' }]);
  });

  it('раннер объявлен, но не установлен — это ответ с объяснением, а не сбой', async () => {
    const root = await makeProject(['vitest'], ['tests/a.test.ts']);

    const suite = await collectNodeTests(root);
    expect(suite.runner).toBe('vitest');
    expect(suite.tests).toEqual([]);
    expect(suite.errors[0]).toContain('не установлен');
  });

  it('раннера нет, но тесты есть — собираем файлы для `node --test`', async () => {
    const root = await makeProject([], ['tests/a.test.mjs', 'src/index.ts']);

    const suite = await collectNodeTests(root);
    expect(suite.runner).toBe('node');
    expect(suite.tests.map((test) => test.file)).toEqual(['tests/a.test.mjs']);
  });

  it('ни раннера, ни тестов — раннера нет и запускать нечего', async () => {
    const root = await makeProject([], ['src/index.ts', 'tests/test_math.py']);

    const suite = await collectNodeTests(root);
    expect(suite).toEqual({ runner: null, tests: [], total: 0, errors: [] });
  });
});
