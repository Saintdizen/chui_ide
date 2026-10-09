import { describe, expect, it } from 'vitest';
import {
  buildTestTree,
  collectFailure,
  describeTest,
  parseCoverage,
  parseCoverageReport,
  parseMissingLines,
  parsePytestCollect,
  parseResultMarker,
  resultMarkerCommand,
  stripAnsi,
} from '../src/shared/python-tests';

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

    // У каждого узла есть селектор для запуска: ▶ у файла и класса должен запускать
    // именно их, а не все тесты проекта (панель шлёт `id ?? null`).
    expect(math.id).toBe('tests/test_math.py');
    expect(math.children[0].id).toBe('tests/test_math.py::test_add');
    expect(math.children[1].id).toBe('tests/test_math.py::TestSum');
  });
});

describe('маркер результата прогона', () => {
  it('хвост команды печатает код выхода нужной переменной', () => {
    // Оболочка на Windows — PowerShell, на остальных — POSIX.
    expect(resultMarkerCommand('linux')).toContain('$?');
    expect(resultMarkerCommand('win32')).toContain('$LASTEXITCODE');
  });

  it('код выхода читается из вывода', () => {
    expect(parseResultMarker('шум\nchui-test-result 0\n')).toBe(0);
    expect(parseResultMarker('chui-test-result 1')).toBe(1);
  });

  it('без маркера — null', () => {
    expect(parseResultMarker('5 passed in 0.1s')).toBeNull();
  });

  it('ANSI-последовательности не мешают', () => {
    expect(parseResultMarker('\u001b[32mchui-test-result 2\u001b[0m')).toBe(2);
  });

  it('эхо самой команды не принимается за результат', () => {
    // Терминал печатает и набранную команду, где после маркера стоит `$?`, а не число.
    expect(parseResultMarker('$ python -m pytest; echo "chui-test-result $?"')).toBeNull();
  });

  it('stripAnsi убирает цвет, но не текст', () => {
    expect(stripAnsi('\u001b[31mпровал\u001b[0m')).toBe('провал');
  });
});

describe('parseCoverageReport', () => {
  // Настоящий вывод pytest-cov: шапка, разделители, файлы и итог.
  const output = [
    '============================= test session starts ==============================',
    'plugins: cov-7.1.0',
    'collected 2 items',
    'tests/test_bad.py F                                                      [ 50%]',
    'tests/test_ok.py .                                                       [100%]',
    '================================ tests coverage ================================',
    '_______________ coverage: platform linux, python 3.14.4-final-0 ________________',
    '',
    'Name                      Stmts   Miss  Cover',
    '---------------------------------------------',
    'src/app.py                   20     10    50%',
    'src/util.py                   5      0   100%',
    'src/empty.py                  0      0   100%',
    '---------------------------------------------',
    'TOTAL                        25     10    60%',
    '============================== 1 failed, 1 passed in 0.03s ======================',
    '',
    'chui-test-result 1',
  ].join('\n');

  it('берёт итог и разбивку по файлам', () => {
    const report = parseCoverageReport(output);
    expect(report.total).toBe(60);
    // Первым — app.py (10 непокрытых), затем два полностью покрытых по алфавиту.
    expect(report.files.map((file) => file.path)).toEqual(['src/app.py', 'src/empty.py', 'src/util.py']);
    // Отчёт без `term-missing` и без `--cov-branch`: строк и ветвей нет, поля пустые.
    expect(report.files[0]).toEqual({
      path: 'src/app.py',
      percent: 50,
      statements: 20,
      missing: 10,
      missingLines: [],
      branches: 0,
      branchPartial: 0,
    });
  });

  it('отчёт с --cov-branch даёт ветви', () => {
    const report = parseCoverageReport(
      [
        'Name                  Stmts   Miss Branch BrPart  Cover   Missing',
        '-----------------------------------------------------------------',
        'src/app.py               20     10      8      2    50%   3-6, 12',
        'TOTAL                    20     10      8      2    50%',
      ].join('\n'),
    );
    const app = report.files.find((file) => file.path === 'src/app.py');
    expect(app?.branches).toBe(8);
    expect(app?.branchPartial).toBe(2);
    expect(app?.missingLines).toEqual([3, 4, 5, 6, 12]);
    expect(report.total).toBe(50);
  });

  it('сначала самое проблемное: по непокрытым строкам', () => {
    const report = parseCoverageReport(output);
    // У app.py 10 непокрытых, у остальных 0 — он и должен быть первым.
    expect(report.files[0]?.path).toBe('src/app.py');
  });

  it('шапку, разделители и строки прогона в файлы не тащит', () => {
    const report = parseCoverageReport(output);
    expect(report.files.some((file) => file.path.includes('Name'))).toBe(false);
    expect(report.files.some((file) => file.path.includes('test session'))).toBe(false);
  });

  it('путь с пробелом берётся целиком', () => {
    const report = parseCoverageReport('my folder/app.py   4   1   75%\nTOTAL   4   1   75%');
    expect(report.files[0]?.path).toBe('my folder/app.py');
    expect(report.files[0]?.percent).toBe(75);
  });

  it('без coverage-отчёта — пусто и без итога', () => {
    const report = parseCoverageReport('2 passed in 0.01s\nchui-test-result 0');
    expect(report.total).toBeNull();
    expect(report.files).toEqual([]);
  });

  it('ANSI-цвета не мешают', () => {
    const report = parseCoverageReport('\u001b[31mTOTAL   10   4   60%\u001b[0m');
    expect(report.total).toBe(60);
  });

  it('отчёт с term-missing даёт номера непокрытых строк', () => {
    const report = parseCoverageReport(
      [
        'Name                  Stmts   Miss  Cover   Missing',
        '---------------------------------------------------',
        'src/app.py               20     10    50%   3-6, 12, 18-19',
        'src/util.py               5      0   100%',
        '---------------------------------------------------',
        'TOTAL                    25     10    60%',
      ].join('\n'),
    );
    // Диапазоны раскрыты в список: 3-6 → 3,4,5,6; плюс 12 и 18-19.
    expect(report.files.find((file) => file.path === 'src/app.py')?.missingLines).toEqual([3, 4, 5, 6, 12, 18, 19]);
    // У полностью покрытого файла строк нет — колонка Missing пустая.
    expect(report.files.find((file) => file.path === 'src/util.py')?.missingLines).toEqual([]);
  });
});

describe('parseMissingLines', () => {
  it('раскрывает диапазоны и одиночные строки', () => {
    expect(parseMissingLines('5-7, 10')).toEqual([5, 6, 7, 10]);
  });

  it('пробелы и пустые куски пропускаются', () => {
    expect(parseMissingLines(' 3 , , 5-6 ')).toEqual([3, 5, 6]);
  });

  it('мусорные куски не ломают разбор', () => {
    expect(parseMissingLines('1, abc, 2')).toEqual([1, 2]);
  });

  it('огромный диапазон ограничивается сверху', () => {
    // Битый `1-999999` в отчёте не должен порождать миллион строк.
    expect(parseMissingLines('1-999999').length).toBeLessThanOrEqual(5000);
  });

  it('пустая строка — пустой список', () => {
    expect(parseMissingLines('')).toEqual([]);
  });
});

describe('parseCoverage', () => {
  const tail = [
    'Name                Stmts   Miss  Cover',
    '---------------------------------------',
    'app/main.py            10      4    60%',
    '---------------------------------------',
    'TOTAL                  10      4    60%',
    '',
    'chui-test-result 0',
  ].join('\n');

  it('берёт процент из строки TOTAL', () => {
    expect(parseCoverage(tail)).toBe(60);
  });

  it('без строки TOTAL — null (прогон без покрытия)', () => {
    expect(parseCoverage('5 passed in 0.1s\nchui-test-result 0')).toBeNull();
  });

  it('ANSI не мешает', () => {
    expect(parseCoverage('\u001b[32mTOTAL   10   0   100%\u001b[0m')).toBe(100);
  });

  it('слово TOTAL не в строке отчёта не считается', () => {
    expect(parseCoverage('TOTAL: покрытие не собрано')).toBeNull();
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
