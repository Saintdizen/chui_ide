/**
 * Разбор списка тестов pytest.
 *
 * `pytest --collect-only -q` печатает по одному идентификатору на строку:
 * `tests/test_math.py::TestSum::test_adds`. Из этого строится дерево тестов и
 * узлы для запуска отдельного теста. Здесь только разбор вывода — запускает
 * pytest и читает вывод main.
 *
 * Дерево собираем сами, а не отдаём плоский список в интерфейс: человек ищет
 * тест по файлу и классу, и плоская простыня из сотен строк этому не помогает.
 */

import { stripAnsi, type CollectedSuite, type CollectedTest, type RunnableTest } from './test-model';

export type { CollectedSuite, CollectedTest, RunnableTest, TestFolder } from './test-model';
export { buildTestTree, parseResultMarker, resultMarkerCommand, stripAnsi, TEST_RESULT_MARKER } from './test-model';

/** Строка похожа на идентификатор теста, а не на сообщение pytest. */
const NODEID = /^([^\s:]+\.py)::(\S+)$/;

/**
 * Разбор вывода `pytest --collect-only -q`.
 *
 * Строки `path.py::node` — тесты. Итого-строку (`5 tests collected`) читаем
 * отдельно: она подтверждает число и ловит случай, когда тесты есть, а строк
 * мы не разобрали. Всё прочее (ошибки сбора, предупреждения) кладём в `errors`.
 */
export function parsePytestCollect(output: string): CollectedSuite {
  const tests: CollectedTest[] = [];
  const errors: string[] = [];
  let total = 0;

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const node = NODEID.exec(line);
    if (node) {
      tests.push(describeTest(node[1], node[2]));
      continue;
    }

    const summary = /^(\d+)\s+tests?\s+collected/i.exec(line);
    if (summary) {
      total = Number(summary[1]);
      continue;
    }

    // Ошибка сбора начинается с `ERROR` или `E   `; остальное — шум (плагины, кэш).
    if (/^ERROR\b|^E\s{2,}/.test(line)) errors.push(line);
  }

  if (total === 0) total = tests.length;
  return { tests, total, errors };
}

/**
 * Строки-причины сбоя сбора, когда pytest падает сам (несовместимый плагин,
 * битый импорт). Это НЕ строка `ERROR`, а питоновский трейсбек: берём последнюю
 * строку с исключением и пару строк контекста над ней — по ним видно, что случилось.
 */
export function collectFailure(output: string, limit = 3): string[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  let index = -1;
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    if (/\w*(?:Error|Exception)\b/.test(lines[at]) && lines[at].includes(':')) {
      index = at;
      break;
    }
  }
  if (index < 0) index = lines.length - 1;

  const start = Math.max(0, index - (limit - 1));
  return lines.slice(start, index + 1);
}

/** Покрытие одного файла из отчёта `pytest --cov`. */
export interface CoverageRow {
  /** Путь файла, как его назвал отчёт (обычно относительный). */
  path: string;
  /** Процент покрытых строк. */
  percent: number;
  /** Всего исполняемых строк. */
  statements: number;
  /** Непокрытых строк. */
  missing: number;
  /**
   * Номера непокрытых строк — из колонки `Missing` отчёта `--cov-report=term-missing`.
   * Пусто, если отчёт без неё (обычный `--cov`): тогда построчной подсветки нет.
   */
  missingLines: number[];
  /** Всего ветвей (колонка `Branch`); 0 — отчёт без `--cov-branch`. */
  branches: number;
  /** Частично покрытых ветвей (колонка `BrPart`). */
  branchPartial: number;
}

/** Итог покрытия: процент по проекту и разбивка по файлам. */
export interface CoverageReport {
  /** Процент по всему прогону; null — строки `TOTAL` в выводе не было. */
  total: number | null;
  /** Файлы по убыванию числа непокрытых строк: сначала то, что стоит смотреть. */
  files: CoverageRow[];
}

/**
 * Строка отчёта покрытия. Два вида:
 * - `путь  stmts  miss  cover%` (+ необязательная колонка `Missing`);
 * - с `--cov-branch`: `путь  stmts  miss  branch  brpart  cover%` (+ `Missing`).
 *
 * Имя — всё, что до чисел (нежадно, потому что в пути бывают пробелы); хвост
 * после процента — список непокрытых строк `5-6, 12`.
 */
const COVERAGE_ROW = /^(.+?)\s+(\d+)\s+(\d+)\s+(?:(\d+)\s+(\d+)\s+)?(\d+)%(?:\s+(.+))?$/;

/** Предел строк в одном диапазоне Missing: защита от битого `1-999999` в отчёте. */
const MAX_MISSING_LINES = 5000;

/**
 * Разобрать колонку `Missing`: `5-6, 12, 20-22`. Диапазоны раскрываем в список —
 * дальше и редактор, и подсчёт работают с ним одинаково.
 */
export function parseMissingLines(value: string): number[] {
  const lines: number[] = [];
  for (const part of value.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let line = from; line <= to && lines.length < MAX_MISSING_LINES; line += 1) lines.push(line);
      continue;
    }
    if (/^\d+$/.test(token)) lines.push(Number(token));
    if (lines.length >= MAX_MISSING_LINES) break;
  }
  return lines;
}

/**
 * Разбор полного отчёта покрытия `pytest --cov`.
 *
 * Берём и итог, и построчные данные: по ним видно, какие файлы провалились, а не
 * только общий процент. Строки-разделители, шапка и служебные пометки пропускаются —
 * их разбирать нечего.
 */
export function parseCoverageReport(text: string): CoverageReport {
  const files: CoverageRow[] = [];
  let total: number | null = null;

  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = COVERAGE_ROW.exec(line);
    if (!match) continue;

    const name = match[1]!.trim();
    // Процент — всегда шестая группа: колонки Branch/BrPart необязательны.
    const percent = Number(match[6]);
    if (name === 'TOTAL') {
      total = percent;
      continue;
    }
    // Шапка и разделители под шаблон не подходят, а имя с пробелами шаблон берёт
    // целиком (группа нежадная): отдельной проверки на служебные строки не нужно.
    files.push({
      path: name,
      percent,
      statements: Number(match[2]),
      missing: Number(match[3]),
      missingLines: match[7] ? parseMissingLines(match[7]) : [],
      branches: match[4] ? Number(match[4]) : 0,
      branchPartial: match[5] ? Number(match[5]) : 0,
    });
  }

  // Сначала самое проблемное: по числу непокрытых строк, затем по проценту.
  files.sort((a, b) => b.missing - a.missing || a.percent - b.percent || a.path.localeCompare(b.path));
  return { total, files };
}

/**
 * Итог покрытия из вывода `pytest --cov`: строка `TOTAL   N   M   P%`.
 * null — строки нет: прогон был без покрытия или отчёт ещё не напечатан.
 */
export function parseCoverage(text: string): number | null {
  return parseCoverageReport(text).total;
}

/** Разбор одной строки-идентификатора: `file.py::Class::name` или `file.py::name`. */
export function describeTest(file: string, node: string): CollectedTest {
  const parts = node.split('::');
  const name = parts[parts.length - 1];
  const className = parts.length >= 2 ? parts[0] : null;
  return { id: `${file}::${node}`, file: file.split('\\').join('/'), className, name };
}

/* ── запуск отдельного теста из редактора ───────────────────────────────── */



/** Объявление теста: `def test_…` или `async def test_…`, с любым отступом. */
const TEST_DEF = /^\s*(?:async\s+)?def\s+(test_[A-Za-z0-9_]*)\s*\(/;
/** Объявление класса: `class TestX:` или `class TestX(Base):`. */
const TEST_CLASS = /^(\s*)class\s+([A-Za-z0-9_]+)\s*[:(]/;

/**
 * Тесты, объявленные в файле, — чтобы поставить у них значок запуска.
 *
 * Разбор нарочно простой, по строкам: нужен не полный синтаксис Python, а строки
 * объявлений. Класс учитываем, чтобы селектор совпал с тем, что ждёт pytest
 * (`файл::Класс::test`), и закрываем его по отступу — так же, как это делает сам
 * интерпретатор. Строки и комментарии не разбираем: файл уже отобран по имени
 * как тестовый, и `def test_` внутри строки там встретится разве что случайно.
 */
export function findRunnableTests(relativePath: string, text: string): RunnableTest[] {
  const file = relativePath.split('\\').join('/');
  const tests: RunnableTest[] = [];
  let className: string | null = null;
  let classIndent = -1;

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    const declaration = TEST_CLASS.exec(line);
    if (declaration) {
      className = declaration[2]!;
      classIndent = declaration[1]!.length;
      continue;
    }

    // Класс кончился: строка без отступа на уровне класса или выше.
    if (className !== null) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && line.length - line.trimStart().length <= classIndent) {
        className = null;
        classIndent = -1;
      }
    }

    const test = TEST_DEF.exec(line);
    if (!test) continue;
    const name = test[1]!;
    tests.push({
      line: index + 1,
      selector: className ? `${file}::${className}::${name}` : `${file}::${name}`,
      name,
    });
  }

  return tests;
}

