import { describe, expect, it } from 'vitest';
import {
  detectNodeTestRunner,
  findRunnableNodeTests,
  nodeTestFilesSuite,
  nodeTestNamePattern,
  nodeTestRunnerFrom,
  nodeTestSelector,
  parseJestList,
  parseNodeTestSelector,
  parseVitestList,
} from '../src/shared/node-tests';

const ROOTS = ['/p'];

describe('nodeTestRunnerFrom', () => {
  it('раннер берём из объявленных зависимостей', () => {
    expect(nodeTestRunnerFrom(['vitest'])).toBe('vitest');
    expect(nodeTestRunnerFrom(['jest', 'typescript'])).toBe('jest');
  });

  it('оба объявлены — выигрывает vitest: jest рядом с ним означает переезд', () => {
    expect(nodeTestRunnerFrom(['jest', 'vitest'])).toBe('vitest');
  });

  it('похожие имена за раннер не считаем', () => {
    expect(nodeTestRunnerFrom(['@types/jest', 'jest-environment-jsdom', 'vitest-browser'])).toBeNull();
    expect(nodeTestRunnerFrom([])).toBeNull();
  });
});

describe('detectNodeTestRunner', () => {
  it('объявленный раннер важнее тестовых файлов', () => {
    expect(detectNodeTestRunner('jest', ['tests/a.test.ts'])).toBe('jest');
  });

  it('раннера нет, но тесты есть — годится встроенный `node --test`', () => {
    expect(detectNodeTestRunner(null, ['tests/a.test.ts'])).toBe('node');
    expect(detectNodeTestRunner(null, ['test/helper.mjs'])).toBe('node');
  });

  it('ни раннера, ни тестов — запускать нечем', () => {
    expect(detectNodeTestRunner(null, [])).toBeNull();
    expect(detectNodeTestRunner(null, ['tests/test_math.py', 'src/index.ts'])).toBeNull();
  });
});

describe('селектор теста', () => {
  it('пустой селектор и обратный разбор', () => {
    expect(nodeTestSelector('tests/a.test.ts', null)).toBe('tests/a.test.ts');
    expect(parseNodeTestSelector('tests/a.test.ts')).toEqual({ file: 'tests/a.test.ts', name: null });
  });

  it('имя теста с `>` остаётся именем: разделяем по первому `::`', () => {
    const selector = nodeTestSelector('tests/a.test.ts', 'группа > вложенная > сам тест');
    expect(parseNodeTestSelector(selector)).toEqual({
      file: 'tests/a.test.ts',
      name: 'группа > вложенная > сам тест',
    });
  });
});

describe('nodeTestNamePattern', () => {
  it('имя теста — не шаблон: метасимволы экранируются', () => {
    // Параметризованные прогоны выглядят как регулярное выражение, но им не являются.
    expect(nodeTestNamePattern('test_adds[1-2]')).toBe('test_adds\\[1-2\\]');
    expect(nodeTestNamePattern('складывает (a + b)')).toBe('складывает \\(a \\+ b\\)');
    expect(nodeTestNamePattern('обычное имя')).toBe('обычное имя');
  });
});

describe('parseVitestList', () => {
  const output = JSON.stringify([
    { name: 'сумма > складывает два числа', file: '/p/tests/math.test.ts', location: { line: 7, column: 3 } },
    { name: 'отдельный тест', file: '/p/tests/math.test.ts', location: { line: 20, column: 1 } },
  ]);

  it('полное имя даёт группу и сам тест: ` > ` разделяет их, как `::` у pytest', () => {
    const suite = parseVitestList(output, ROOTS);
    expect(suite.total).toBe(2);
    expect(suite.errors).toEqual([]);
    expect(suite.tests[0]).toEqual({
      id: 'tests/math.test.ts::сумма > складывает два числа',
      file: 'tests/math.test.ts',
      className: 'сумма',
      name: 'складывает два числа',
    });
    // Тест без группы: класс не выдумываем.
    expect(suite.tests[1]?.className).toBeNull();
  });

  it('вложенные группы остаются одной подписью: она же идёт в `-t`', () => {
    const suite = parseVitestList(
      JSON.stringify([{ name: 'внешняя > внутренняя > тест', file: '/p/tests/a.test.ts' }]),
      ROOTS,
    );
    expect(suite.tests[0]?.className).toBe('внешняя > внутренняя');
    expect(suite.tests[0]?.id).toBe('tests/a.test.ts::внешняя > внутренняя > тест');
  });

  it('битый вывод — это ошибка сбора, а не исключение', () => {
    expect(parseVitestList('не json', ROOTS).errors.length).toBe(1);
    expect(parseVitestList('{"tests":[]}', ROOTS).errors.length).toBe(1);
  });

  it('записи без имени или файла пропускаются', () => {
    const suite = parseVitestList(JSON.stringify([{ name: 'без файла' }, { file: '/p/tests/a.test.ts' }]), ROOTS);
    expect(suite.tests).toEqual([]);
  });
});

describe('parseJestList', () => {
  it('строки-пути становятся узлами файлов', () => {
    const suite = parseJestList(JSON.stringify(['/p/tests/a.test.js', '/p/src/b.spec.ts']), ROOTS);
    expect(suite.total).toBe(2);
    expect(suite.tests).toEqual([
      { id: 'tests/a.test.js', file: 'tests/a.test.js', className: null, name: '' },
      { id: 'src/b.spec.ts', file: 'src/b.spec.ts', className: null, name: '' },
    ]);
  });

  it('объекты с путём тоже понимаем: версии jest отвечают по-разному', () => {
    const suite = parseJestList(JSON.stringify([{ testFilePath: '/p/tests/a.test.js' }, { path: '/p/tests/b.test.js' }]), ROOTS);
    expect(suite.tests.map((test) => test.file)).toEqual(['tests/a.test.js', 'tests/b.test.js']);
  });

  it('битый вывод — ошибка сбора', () => {
    expect(parseJestList('не json', ROOTS).errors.length).toBe(1);
  });
});

describe('nodeTestFilesSuite', () => {
  it('в список попадают только тестовые файлы Node', () => {
    const suite = nodeTestFilesSuite(['tests/a.test.ts', 'src/index.ts', 'tests/test_math.py', 'test/helper.mjs']);
    expect(suite.tests.map((test) => test.file)).toEqual(['tests/a.test.ts', 'test/helper.mjs']);
    expect(suite.total).toBe(2);
  });
});

describe('findRunnableNodeTests', () => {
  const text = [
    "import { test, describe, it } from 'vitest';", // 1
    '', // 2
    "describe('математика', () => {", // 3
    "  test('складывает', () => {", // 4
    '    expect(1).toBe(1);', // 5
    '  });', // 6
    '', // 7
    "  describe('вычитание', () => {", // 8
    '    it("вычитает", () => {});', // 9
    '  });', // 10
    '});', // 11
    '', // 12
    "test('вне группы', () => {});", // 13
    "test.only('только этот', () => {});", // 14
  ].join('\n');

  it('находит тесты, их строки и группу, в которой они лежат', () => {
    const tests = findRunnableNodeTests('tests/math.test.ts', text);
    expect(tests.map((test) => [test.line, test.name])).toEqual([
      [4, 'математика > складывает'],
      [9, 'математика > вычитание > вычитает'],
      // Группа закрылась на 11-й строке — дальше тесты снова сами по себе.
      [13, 'вне группы'],
      [14, 'только этот'],
    ]);
  });

  it('селектор — файл и имя теста: его принимает `-t`', () => {
    const tests = findRunnableNodeTests('tests/math.test.ts', text);
    expect(tests[0]?.selector).toBe('tests/math.test.ts::складывает');
  });

  it('файл без тестов — пустой список', () => {
    expect(findRunnableNodeTests('src/index.ts', 'export const a = 1;')).toEqual([]);
  });
});
