import { describe, expect, it } from 'vitest';
import { buildTestTree, collectFailure, describeTest, parsePytestCollect } from '../src/shared/python-tests';

describe('parsePytestCollect', () => {
  it('разбирает строки-идентификаторы и итог', () => {
    const output = [
      'tests/test_math.py::test_add',
      'tests/test_math.py::TestSum::test_sum',
      'tests/other.py::test_x[1-2]',
      '',
      '3 tests collected in 0.02s',
    ].join('\n');

    const suite = parsePytestCollect(output);
    expect(suite.total).toBe(3);
    expect(suite.tests.map((test) => test.id)).toEqual([
      'tests/test_math.py::test_add',
      'tests/test_math.py::TestSum::test_sum',
      'tests/other.py::test_x[1-2]',
    ]);
  });

  it('ошибки сбора попадают в сводку', () => {
    const output = ['ERROR tests/test_broken.py', 'E   ImportError: no module named x'].join('\n');
    const suite = parsePytestCollect(output);
    expect(suite.tests).toEqual([]);
    expect(suite.errors).toHaveLength(2);
  });

  it('без итоговой строки total берётся из числа тестов', () => {
    expect(parsePytestCollect('a.py::test_one').total).toBe(1);
  });
});

describe('describeTest', () => {
  it('тест в классе', () => {
    expect(describeTest('tests/test_math.py', 'TestSum::test_sum')).toEqual({
      id: 'tests/test_math.py::TestSum::test_sum',
      file: 'tests/test_math.py',
      className: 'TestSum',
      name: 'test_sum',
    });
  });

  it('тест без класса, с параметрами', () => {
    expect(describeTest('a.py', 'test_x[1-2]')).toEqual({
      id: 'a.py::test_x[1-2]',
      file: 'a.py',
      className: null,
      name: 'test_x[1-2]',
    });
  });
});

describe('buildTestTree', () => {
  it('группирует тесты по файлу и классу', () => {
    const suite = parsePytestCollect(
      [
        'tests/test_math.py::test_add',
        'tests/test_math.py::TestSum::test_sum',
        'tests/test_math.py::TestSum::test_mul',
        'tests/other.py::test_x',
      ].join('\n'),
    );

    const tree = buildTestTree(suite.tests);
    expect(tree.map((node) => node.label)).toEqual(['tests/test_math.py', 'tests/other.py']);

    const math = tree[0];
    // Сначала одиночный тест, затем группа класса.
    expect(math.children.map((node) => node.label)).toEqual(['test_add', 'TestSum']);
    expect(math.children[1].children.map((node) => node.label)).toEqual(['test_sum', 'test_mul']);
    // У класса нет своего id — запускается по своим тестам.
    expect(math.children[0].id).toBe('tests/test_math.py::test_add');
  });
});

describe('collectFailure', () => {
  it('достаёт строку с исключением из трейсбека', () => {
    const output = [
      'Traceback (most recent call last):',
      '  File "x.py", line 1, in <module>',
      "TypeError: __call__() got an unexpected keyword argument 'wrapper'",
    ].join('\n');
    expect(collectFailure(output).at(-1)).toContain('TypeError');
  });

  it('пустой вывод — пустой список', () => {
    expect(collectFailure('   \n')).toEqual([]);
  });
});
