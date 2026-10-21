import { describe, expect, it } from 'vitest';
import { buildScan } from '../src/shared/project-scan';
import type { ProjectTools } from '../src/renderer/core/project-tools';
import {
  collectRunTargets,
  fileRunTarget,
  nodeCoverageTarget,
  nodeInstallTarget,
  nodeTestsRunTargets,
  nodeTestsTarget,
  pytestCoverageTarget,
  pytestRunTargets,
  pytestTarget,
  testTargetOf,
} from '../src/renderer/core/run-config';

const tools: ProjectTools = {
  root: '/p',
  packageManager: 'npm',
  pythonCommand: './.venv/bin/python',
  pythonLabel: '.venv · ./.venv/bin/python',
  pythonFromProject: true,
  nodeVersion: null,
  scripts: [],
  hasPackageJson: false,
  tsRunner: null,
  tsRunnerFrom: null,
  testRunner: null,
};

function scanOf(files: readonly string[]) {
  return buildScan({ root: '/p', name: 'p', files, dirCount: 1 });
}

describe('fileRunTarget: TypeScript', () => {
  const file = { path: '/p/src/index.ts', relative: 'src/index.ts', languageId: 'typescript', text: 'const x = 1;' };

  it('раннер проекта запускает .ts и это видно в подсказке', () => {
    const target = fileRunTarget(file, { ...tools, tsRunner: 'npx tsx', tsRunnerFrom: 'project' });
    expect(target?.command).toBe('npx tsx src/index.ts');
    expect(target?.detail).toContain('раннером проекта');
  });

  it('без раннера проекта .ts запускает встроенный Node', () => {
    const target = fileRunTarget(file, { ...tools, tsRunner: 'node', tsRunnerFrom: 'node' });
    expect(target?.command).toBe('node src/index.ts');
    expect(target?.detail).toContain('встроенными средствами Node');
  });

  it('запускать нечем — цели нет', () => {
    expect(fileRunTarget(file, tools)).toBeNull();
  });
});

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

  it('упавший плагин отключается и в прогоне: иначе он уронил бы и его', () => {
    const scan = scanOf(['pyproject.toml', 'tests/test_main.py']);
    const targets = pytestRunTargets(tools, scan, null, ['pytest_cov']);
    expect(targets[0]?.command).toBe('./.venv/bin/python -m pytest -p no:pytest_cov -p no:cov');
    expect(targets.find((item) => item.id === 'pytest:tests/test_main.py')?.command).toBe(
      './.venv/bin/python -m pytest -p no:pytest_cov -p no:cov tests/test_main.py',
    );
  });

  it('без упавших плагинов ключей в команде нет', () => {
    const scan = scanOf(['pyproject.toml', 'tests/test_main.py']);
    expect(pytestRunTargets(tools, scan, null)[0]?.command).toBe('./.venv/bin/python -m pytest');
  });

  it('путь с пробелом экранируется в команде', () => {
    // Пробел — в каталоге: имя файла остаётся тестовым. Файл `test a.py` pytest
    // по умолчанию не собирает, и проверяли бы мы не экранирование, а его отсутствие.
    const scan = scanOf(['pyproject.toml', 'my tests/test_one.py']);
    const target = pytestRunTargets(tools, scan, null).find((item) => item.id === 'pytest:my tests/test_one.py');
    expect(target?.command).toBe("./.venv/bin/python -m pytest 'my tests/test_one.py'");
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

  it('отключённый плагин идёт в команду до селектора', () => {
    expect(pytestTarget(tools, 'tests/test_x.py', { disabledPlugins: ['pytest_cov'] }).command).toBe(
      './.venv/bin/python -m pytest -p no:pytest_cov -p no:cov tests/test_x.py',
    );
  });

  it('с report дописывает печать кода выхода — панель по ней узнаёт исход', () => {
    const target = pytestTarget(tools, null, { report: true, platform: 'linux' });
    expect(target.command).toBe('./.venv/bin/python -m pytest; echo "chui-test-result $?"');
  });

  it('без платформы отчёт не добавляется — неизвестно, какой у оболочки синтаксис', () => {
    expect(pytestTarget(tools, null, { report: true }).command).toBe('./.venv/bin/python -m pytest');
  });
});

describe('pytestCoverageTarget', () => {
  it('добавляет --cov, term-missing и --cov-branch и помечается отдельным id', () => {
    // term-missing нужен панели: без него в отчёте нет колонки Missing, а по ней
    // редактор подсвечивает непокрытые строки. --cov-branch добавляет колонки ветвей.
    expect(pytestCoverageTarget(tools, null)).toMatchObject({
      id: 'pytest-cov:all',
      command: './.venv/bin/python -m pytest --cov --cov-branch --cov-report=term-missing',
      source: 'test',
    });
  });

  it('селектор идёт после `--`: иначе --cov съест его как источник покрытия', () => {
    expect(pytestCoverageTarget(tools, 'tests/test_x.py').command).toBe(
      './.venv/bin/python -m pytest --cov --cov-branch --cov-report=term-missing -- tests/test_x.py',
    );
  });

  it('с report дописывает маркер — панель читает и исход, и покрытие', () => {
    expect(pytestCoverageTarget(tools, null, { report: true, platform: 'linux' }).command).toBe(
      './.venv/bin/python -m pytest --cov --cov-branch --cov-report=term-missing; echo "chui-test-result $?"',
    );
  });

  it('с jsonPath просит ещё JSON-отчёт — по нему видно частично пройденные ветви', () => {
    expect(pytestCoverageTarget(tools, 'tests/test_x.py', { jsonPath: '/tmp/cov.json' }).command).toBe(
      './.venv/bin/python -m pytest --cov --cov-branch --cov-report=term-missing --cov-report=json:/tmp/cov.json -- tests/test_x.py',
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

describe('nodeTestsTarget', () => {
  it('vitest зовётся с `run`: без него включается слежение и терминал не освободится', () => {
    expect(nodeTestsTarget(tools, 'vitest', null)).toMatchObject({
      id: 'node-tests:all',
      label: 'Запустить тесты (vitest)',
      detail: 'vitest · тесты проекта',
      command: 'npx vitest run',
      source: 'test',
    });
  });

  it('менеджер пакетов проекта решает, чем звать раннер', () => {
    expect(nodeTestsTarget({ ...tools, packageManager: 'pnpm' }, 'vitest', null).command).toBe('pnpm exec vitest run');
    expect(nodeTestsTarget({ ...tools, packageManager: 'bun' }, 'jest', null).command).toBe('bunx jest');
  });

  it('файл и имя теста: `-t` у vitest и jest', () => {
    expect(nodeTestsTarget(tools, 'vitest', 'tests/a.test.ts::сумма > складывает').command).toBe(
      "npx vitest run tests/a.test.ts -t 'сумма > складывает'",
    );
    expect(nodeTestsTarget(tools, 'jest', 'tests/a.test.js::складывает').command).toBe(
      "npx jest tests/a.test.js -t 'складывает'",
    );
  });

  it('имя теста уходит шаблоном, а не регулярным выражением: метасимволы экранируются', () => {
    expect(nodeTestsTarget(tools, 'vitest', 'tests/a.test.ts::test_adds[1-2]').command).toBe(
      "npx vitest run tests/a.test.ts -t 'test_adds\\[1-2\\]'",
    );
  });

  it('у `node --test` шаблон имени — свой флаг и идёт до файла', () => {
    expect(nodeTestsTarget(tools, 'node', 'tests/a.test.mjs::складывает').command).toBe(
      "node --test --test-name-pattern='складывает' tests/a.test.mjs",
    );
    expect(nodeTestsTarget(tools, 'node', null).command).toBe('node --test');
  });

  it('отчёт дописывает печать кода выхода — по ней панель узнаёт исход', () => {
    expect(nodeTestsTarget(tools, 'vitest', null, { report: true, platform: 'linux' }).command).toBe(
      'npx vitest run; echo "chui-test-result $?"',
    );
  });
});

describe('nodeTestsRunTargets', () => {
  it('цели по файлам, активный тест — первым', () => {
    const scan = scanOf(['package.json', 'tests/a.test.ts', 'tests/b.test.ts']);
    const targets = nodeTestsRunTargets(tools, scan, 'vitest', 'tests/b.test.ts');
    expect(targets[0]?.id).toBe('node-tests:all');
    expect(targets[1]?.id).toBe('node-tests:tests/b.test.ts');
    expect(targets.map((item) => item.id)).toContain('node-tests:tests/a.test.ts');
  });

  it('без раннера или без тестов целей нет', () => {
    const scan = scanOf(['package.json', 'tests/a.test.ts']);
    expect(nodeTestsRunTargets(tools, scan, null, null)).toEqual([]);
    expect(nodeTestsRunTargets(tools, scanOf(['package.json', 'src/index.ts']), 'vitest', null)).toEqual([]);
  });

  it('коллекция целей запуска включает тесты Node', () => {
    const scan = scanOf(['package.json', 'tests/a.test.ts']);
    expect(collectRunTargets(null, tools, scan, 'vitest').map((item) => item.id)).toContain('node-tests:all');
  });
});

describe('nodeCoverageTarget', () => {
  it('vitest: включает покрытие и просит JSON-отчёт', () => {
    expect(nodeCoverageTarget(tools, 'vitest', null)).toMatchObject({
      id: 'node-cov:all',
      label: 'Тесты с покрытием (vitest)',
      detail: 'vitest · с покрытием',
      command: 'npx vitest run --coverage --coverage.reporter=json',
      source: 'test',
    });
  });

  it('jest: у него флаги покрытия свои', () => {
    expect(nodeCoverageTarget(tools, 'jest', null).command).toBe('npx jest --coverage --coverageReporters=json');
  });

  it('каталог отчёта задаётся свой — файл нужен IDE, а не человеку в `coverage/`', () => {
    expect(nodeCoverageTarget(tools, 'vitest', null, { outputDir: '/tmp/cov' }).command).toBe(
      'npx vitest run --coverage --coverage.reporter=json --coverage.reportsDirectory=/tmp/cov',
    );
    expect(nodeCoverageTarget(tools, 'jest', null, { outputDir: '/tmp/cov' }).command).toBe(
      'npx jest --coverage --coverageReporters=json --coverageDirectory=/tmp/cov',
    );
  });

  it('селектор узла идёт после флагов покрытия', () => {
    expect(nodeCoverageTarget(tools, 'vitest', 'tests/a.test.ts').command).toBe(
      'npx vitest run --coverage --coverage.reporter=json tests/a.test.ts',
    );
    expect(nodeCoverageTarget(tools, 'vitest', 'tests/a.test.ts::сумма > складывает').command).toBe(
      "npx vitest run --coverage --coverage.reporter=json tests/a.test.ts -t 'сумма > складывает'",
    );
  });

  it('с report дописывает печать кода выхода — по ней панель узнаёт исход', () => {
    expect(nodeCoverageTarget(tools, 'vitest', null, { report: true, platform: 'linux' }).command).toBe(
      'npx vitest run --coverage --coverage.reporter=json; echo "chui-test-result $?"',
    );
  });
});

describe('testTargetOf: развилка «pytest или раннер Node»', () => {
  it('раннер Node есть — цель Node', () => {
    expect(testTargetOf(tools, 'vitest', null).command).toContain('vitest run');
  });

  it('раннера Node нет — цель pytest', () => {
    expect(testTargetOf(tools, null, null).command).toContain('.venv/bin/python');
  });

  it('report доходит до выбранной цели', () => {
    expect(testTargetOf(tools, 'vitest', null, { report: true, platform: 'linux' }).command).toContain(
      'chui-test-result',
    );
  });
});
