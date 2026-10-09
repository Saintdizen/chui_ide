import { describe, expect, it } from 'vitest';
import { findRunnableTests } from '../src/shared/python-tests';

/**
 * Разбор тестов в файле — по нему в жёлобе редактора ставятся значки запуска
 * отдельного теста. Селектор должен совпадать с тем, что принимает pytest
 * (`файл::тест` или `файл::Класс::тест`), иначе кнопка запустит не то.
 */
describe('findRunnableTests', () => {
  it('находит тесты верхнего уровня', () => {
    const text = ['def test_one():', '    assert True', '', 'def test_two():', '    assert True'].join('\n');
    expect(findRunnableTests('tests/test_a.py', text)).toEqual([
      { line: 1, selector: 'tests/test_a.py::test_one', name: 'test_one' },
      { line: 4, selector: 'tests/test_a.py::test_two', name: 'test_two' },
    ]);
  });

  it('учитывает класс и строит селектор с ним', () => {
    const text = ['class TestSum:', '    def test_add(self):', '        assert 1', '    def test_sub(self):', '        assert 2'].join('\n');
    expect(findRunnableTests('a.py', text).map((test) => test.selector)).toEqual([
      'a.py::TestSum::test_add',
      'a.py::TestSum::test_sub',
    ]);
  });

  it('закрывает класс по отступу: следующий тест снова без класса', () => {
    const text = [
      'class TestSum:',
      '    def test_inside(self):',
      '        assert 1',
      '',
      'def test_outside():',
      '    assert 2',
    ].join('\n');
    expect(findRunnableTests('a.py', text).map((test) => test.selector)).toEqual([
      'a.py::TestSum::test_inside',
      'a.py::test_outside',
    ]);
  });

  it('видит async-тесты', () => {
    const text = 'async def test_async():\n    pass';
    expect(findRunnableTests('a.py', text)).toEqual([{ line: 1, selector: 'a.py::test_async', name: 'test_async' }]);
  });

  it('не считает тестом функцию без префикса test_', () => {
    const text = ['def helper():', '    pass', '', 'def test_real():', '    pass'].join('\n');
    expect(findRunnableTests('a.py', text).map((test) => test.name)).toEqual(['test_real']);
  });

  it('тест с параметрами и с отступом внутри функции', () => {
    const text = ['def wrapper():', '    def test_inner():', '        pass'].join('\n');
    // Вложенная функция тоже попадёт: строка объявления есть, а полный синтаксис
    // разбирать незачем — такой код в тестовом файле почти не встречается.
    expect(findRunnableTests('a.py', text).map((test) => test.name)).toEqual(['test_inner']);
  });

  it('селектор файла — в POSIX-виде, даже если путь пришёл с обратными слэшами', () => {
    const [test] = findRunnableTests('tests\\test_a.py', 'def test_x():\n    pass');
    expect(test?.selector).toBe('tests/test_a.py::test_x');
  });

  it('файл без тестов — пустой список', () => {
    expect(findRunnableTests('a.py', 'x = 1\ndef helper():\n    pass\n')).toEqual([]);
  });
});
