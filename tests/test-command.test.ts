import { promises as fs } from 'node:fs';
import { removeTemp } from './temp';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testCommand } from '../src/main/project/tests';

/**
 * Резолвер команды тестов: чем гонять тесты проекта. Правило про процессы и
 * файловую систему, поэтому проект — настоящий, в temp-каталоге, а раннер Node —
 * заглушка из `node_modules` (как у форматтера и линтера: скрипт берётся по полю
 * `bin`). Так проверяется вся связка целиком.
 */

const roots: string[] = [];

afterEach(async () => {
  await removeTemp(roots);
});

async function makeTemp(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-test-cmd-'));
  roots.push(root);
  return root;
}

/** Node-проект: манифест, тестовый файл и (необязательно) установленный раннер. */
async function makeNodeProject(input: { declared?: readonly string[]; runner?: string; testFile?: boolean }) {
  const root = await makeTemp();
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      dependencies: Object.fromEntries((input.declared ?? []).map((n) => [n, '^1.0.0'])),
    }),
  );
  if (input.testFile !== false) await fs.writeFile(path.join(root, 'a.test.js'), 'test("x", () => {});');

  if (input.runner) {
    const dir = path.join(root, 'node_modules', input.runner);
    await fs.mkdir(path.join(dir, 'bin'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: input.runner, version: '1.0.0', bin: { [input.runner]: 'bin/cli.js' } }),
    );
    await fs.writeFile(path.join(dir, 'bin', 'cli.js'), 'process.exit(0);');
  }
  return root;
}

describe('testCommand: Node', () => {
  it('vitest зовётся его скриптом с `run` (без слежения прогон не завершится)', async () => {
    const root = await makeNodeProject({ declared: ['vitest'], runner: 'vitest' });

    const result = await testCommand(root, 'python3');

    expect(result?.label).toBe('vitest');
    expect(result?.command).toContain('cli.js');
    expect(result?.command).toContain('run');
  });

  it('jest зовётся своим скриптом без лишних аргументов', async () => {
    const root = await makeNodeProject({ declared: ['jest'], runner: 'jest' });

    const result = await testCommand(root, 'python3');

    expect(result?.label).toBe('jest');
    expect(result?.command).toContain('cli.js');
    expect(result?.command).not.toContain(' run');
  });

  it('объявленного раннера нет, но тесты есть — встроенный `node --test`', async () => {
    const root = await makeNodeProject({});

    const result = await testCommand(root, 'python3');

    expect(result?.label).toBe('node --test');
    expect(result?.command).toContain('--test');
  });

  it('нет ни раннера, ни тестовых файлов — запускать нечего', async () => {
    const root = await makeNodeProject({ testFile: false });
    expect(await testCommand(root, 'python3')).toBeNull();
  });

  it('раннер объявлен, но не установлен — команду не собрать', async () => {
    const root = await makeNodeProject({ declared: ['vitest'] });
    expect(await testCommand(root, 'python3')).toBeNull();
  });
});

describe('testCommand: Python', () => {
  it('у Python-проекта с тестами — pytest', async () => {
    const root = await makeTemp();
    await fs.writeFile(path.join(root, 'pyproject.toml'), '[tool.pytest]\n');
    await fs.mkdir(path.join(root, 'tests'));
    await fs.writeFile(path.join(root, 'tests', 'test_a.py'), 'def test_a():\n    pass\n');

    const result = await testCommand(root, 'python3');

    // Кавычки — свои у каждой оболочки: posix спасает одиночными, cmd.exe — двойными.
    const interpreter = process.platform === 'win32' ? '"python3"' : "'python3'";
    expect(result?.label).toBe('pytest');
    expect(result?.command).toBe(`${interpreter} -m pytest`);
  });

  it('Python-проект без тестовых файлов — нечего запускать', async () => {
    const root = await makeTemp();
    await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\n');

    expect(await testCommand(root, 'python3')).toBeNull();
  });
});
