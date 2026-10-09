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

/** Один собранный тест: идентификатор для запуска и части для показа. */
export interface CollectedTest {
  /** Идентификатор pytest — ровно его принимает `pytest <id>`. */
  id: string;
  /** Файл от корня проекта (POSIX). */
  file: string;
  /** Класс, если тест в классе (`TestSum`), иначе null. */
  className: string | null;
  /** Имя теста с параметрами (`test_adds[1-2]`). */
  name: string;
}

/** Сводка прогона collect: сколько собрали и не было ли ошибок сбора. */
export interface CollectedSuite {
  tests: CollectedTest[];
  /** Сколько тестов объявил pytest (включая неразобранные строки). */
  total: number;
  /** Ошибки сбора: файл не импортируется и подобное. */
  errors: string[];
}

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

/** Разбор одной строки-идентификатора: `file.py::Class::name` или `file.py::name`. */
export function describeTest(file: string, node: string): CollectedTest {
  const parts = node.split('::');
  const name = parts[parts.length - 1];
  const className = parts.length >= 2 ? parts[0] : null;
  return { id: `${file}::${node}`, file: file.split('\\').join('/'), className, name };
}

/** Узел дерева тестов: файл, класс или сам тест. */
export interface TestFolder {
  /** Что это за узел. */
  kind: 'file' | 'class' | 'test';
  /** Подпись: `test_math.py`, `TestSum`, `test_adds`. */
  label: string;
  /**
   * Селектор для запуска этого узла: у теста — его id, у класса — `файл::Класс`,
   * у файла — его путь. Пустым id бывает только у служебных узлов.
   */
  id?: string;
  children: TestFolder[];
}

/**
 * Собрать дерево тестов: файл → класс → тест.
 *
 * Один и тот же файл и класс не повторяются: строки идут вперемешку, и без
 * склейки дерево распалось бы на сотню веток по одному тесту.
 */
export function buildTestTree(tests: readonly CollectedTest[]): TestFolder[] {
  const files = new Map<string, TestFolder>();
  const classes = new Map<string, Map<string, TestFolder>>();

  for (const test of tests) {
    let file = files.get(test.file);
    if (!file) {
      // У файла свой id: ▶ у него запускает тесты этого файла, а не всего проекта.
      file = { kind: 'file', label: test.file, id: test.file, children: [] };
      files.set(test.file, file);
      classes.set(test.file, new Map());
    }

    if (!test.className) {
      file.children.push({ kind: 'test', label: test.name, id: test.id, children: [] });
      continue;
    }

    const inFile = classes.get(test.file)!;
    let group = inFile.get(test.className);
    if (!group) {
      // Селектор класса для pytest — файл и имя через `::`: ▶ запускает только его.
      group = { kind: 'class', label: test.className, id: `${test.file}::${test.className}`, children: [] };
      inFile.set(test.className, group);
      file.children.push(group);
    }
    group.children.push({ kind: 'test', label: test.name, id: test.id, children: [] });
  }

  return [...files.values()];
}
