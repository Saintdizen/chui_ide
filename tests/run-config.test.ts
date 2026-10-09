import { describe, expect, it } from 'vitest';
import { buildScan } from '../src/shared/project-scan';
import type { ProjectTools } from '../src/renderer/core/project-tools';
import {
  collectRunTargets,
  nodeInstallTarget,
  pytestCoverageTarget,
  pytestRunTargets,
  pytestTarget,
} from '../src/renderer/core/run-config';

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

  it('активный тест идёт первой отдельной целью (после общих)', () => {
    const scan = scanOf(['pyproject.toml', 'tests/test_a.py', 'tests/test_b.py']);
    const targets = pytestRunTargets(tools, scan, 'tests/test_b.py');
    // Сначала общие цели («все тесты», покрытие), затем файлы, активный — первым.
    const firstFile = targets.findIndex((item) => item.id.startsWith('pytest:tests/'));
    expect(targets[firstFile]?.id).toBe('pytest:tests/test_b.py');
  });

  it('среди общих целей есть прогон с покрытием', () => {
    const scan = scanOf(['pyproject.toml', 'tests/test_a.py']);
    expect(pytestRunTargets(tools, scan, null).map((item) => item.id)).toContain('pytest-cov:all');
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

  it('с report дописывает печать кода выхода — панель по ней узнаёт исход', () => {
    const target = pytestTarget(tools, null, { report: true, platform: 'linux' });
    expect(target.command).toBe('./.venv/bin/python -m pytest; echo "chui-pytest-result $?"');
  });

  it('без платформы отчёт не добавляется — неизвестно, какой у оболочки синтаксис', () => {
    expect(pytestTarget(tools, null, { report: true }).command).toBe('./.venv/bin/python -m pytest');
  });
});

describe('pytestCoverageTarget', () => {
  it('добавляет --cov и помечается отдельным id', () => {
    expect(pytestCoverageTarget(tools, null)).toMatchObject({
      id: 'pytest-cov:all',
      command: './.venv/bin/python -m pytest --cov',
      source: 'test',
    });
  });

  it('селектор идёт после `--`: иначе --cov съест его как источник покрытия', () => {
    expect(pytestCoverageTarget(tools, 'tests/test_x.py').command).toBe('./.venv/bin/python -m pytest --cov -- tests/test_x.py');
  });

  it('с report дописывает маркер — панель читает и исход, и покрытие', () => {
    expect(pytestCoverageTarget(tools, null, { report: true, platform: 'linux' }).command).toBe(
      './.venv/bin/python -m pytest --cov; echo "chui-pytest-result $?"',
    );
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
