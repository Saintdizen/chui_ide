import { describe, expect, it } from 'vitest';
import { buildScan } from '../src/shared/project-scan';
import type { ProjectTools } from '../src/renderer/core/project-tools';
import { collectRunTargets, nodeInstallTarget, pytestRunTargets, pytestTarget } from '../src/renderer/core/run-config';

const tools: ProjectTools = {
  root: '/p',
  packageManager: 'npm',
  pythonCommand: './.venv/bin/python',
  pythonLabel: '.venv · ./.venv/bin/python',
  pythonFromProject: true,
  scripts: [],
  hasPackageJson: false,
  tsRunner: null,
};

function scanOf(files: readonly string[]) {
  return buildScan({ root: '/p', name: 'p', files, dirCount: 1 });
}

describe('pytestRunTargets', () => {
  it('Python-проект с тестами даёт цель «все тесты» и цели по файлам', () => {
    const scan = scanOf(['pyproject.toml', 'app/main.py', 'tests/test_main.py', 'tests/test_util.py']);
    const targets = pytestRunTargets(tools, scan, null);
    expect(targets[0]).toEqual({
      id: 'pytest:all',
      label: 'Запустить тесты (pytest)',
      detail: '.venv · ./.venv/bin/python · pytest',
      command: './.venv/bin/python -m pytest',
      source: 'test',
    });
    expect(targets.map((item) => item.id)).toContain('pytest:tests/test_main.py');
    expect(targets.find((item) => item.id === 'pytest:tests/test_main.py')?.command).toBe(
      './.venv/bin/python -m pytest tests/test_main.py',
    );
  });

  it('активный тест идёт первой отдельной целью', () => {
    const scan = scanOf(['pyproject.toml', 'tests/test_a.py', 'tests/test_b.py']);
    const targets = pytestRunTargets(tools, scan, 'tests/test_b.py');
    // [0] — все тесты, [1] — активный файл.
    expect(targets[1]?.id).toBe('pytest:tests/test_b.py');
  });

  it('проект без Python-маркера тестов не предлагает', () => {
    const scan = scanOf(['package.json', 'tests/foo.test.ts']);
    expect(pytestRunTargets(tools, scan, null)).toEqual([]);
  });

  it('Python без тестовых файлов — пусто', () => {
    const scan = scanOf(['pyproject.toml', 'app/main.py']);
    expect(pytestRunTargets(tools, scan, null)).toEqual([]);
  });

  it('нет карты проекта — пусто', () => {
    expect(pytestRunTargets(tools, null, null)).toEqual([]);
  });

  it('путь с пробелом экранируется в команде', () => {
    const scan = scanOf(['pyproject.toml', 'tests/test a.py']);
    const target = pytestRunTargets(tools, scan, null).find((item) => item.id === 'pytest:tests/test a.py');
    expect(target?.command).toBe("./.venv/bin/python -m pytest 'tests/test a.py'");
  });
});

describe('collectRunTargets', () => {
  it('без карты проекта ведёт себя как раньше: файл и задачи', () => {
    const file = { path: '/p/main.py', relative: 'main.py', languageId: 'python', text: 'x = 1' };
    const targets = collectRunTargets(file, tools, null);
    expect(targets.map((item) => item.source)).toEqual(['file']);
  });

  it('с картой проекта добавляет тесты между файлом и задачами', () => {
    const file = { path: '/p/main.py', relative: 'main.py', languageId: 'python', text: 'x = 1' };
    const scan = scanOf(['pyproject.toml', 'main.py', 'tests/test_main.py']);
    const targets = collectRunTargets(file, tools, scan);
    expect(targets[0]?.source).toBe('file');
    expect(targets[1]?.id).toBe('pytest:all');
  });
});

describe('pytestTarget', () => {
  it('без селектора — все тесты', () => {
    expect(pytestTarget(tools, null)).toMatchObject({
      id: 'pytest:all',
      command: './.venv/bin/python -m pytest',
      source: 'test',
    });
  });

  it('селектор с классами и параметрами экранируется', () => {
    const target = pytestTarget(tools, 'tests/test_x.py::TestY::test_z[1-2]');
    expect(target.command).toBe("./.venv/bin/python -m pytest 'tests/test_x.py::TestY::test_z[1-2]'");
    expect(target.id).toBe('pytest:tests/test_x.py::TestY::test_z[1-2]');
  });
});

describe('nodeInstallTarget', () => {
  it('менеджер пакетов берётся из инструментов проекта', () => {
    expect(nodeInstallTarget({ ...tools, packageManager: 'pnpm' }, ['zod'])).toMatchObject({
      id: 'install:zod',
      label: 'Установить zod',
      detail: 'pnpm install',
      command: 'pnpm install zod',
    });
  });

  it('несколько пакетов — одна команда', () => {
    expect(nodeInstallTarget(tools, ['zod', 'axios']).command).toBe('npm install zod axios');
  });

  it('scoped-пакет не ломает команду', () => {
    expect(nodeInstallTarget(tools, ['@scope/pkg']).command).toBe('npm install @scope/pkg');
  });
});
