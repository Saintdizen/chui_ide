/**
 * Общая модель тестов проекта: собранные тесты, дерево и чтение исхода прогона.
 *
 * Языки и раннеры разные (pytest, vitest, jest, `node --test`), а интерфейс один:
 * дерево «файл → группа → тест», запуск по любому узлу и исход прогона. Поэтому
 * всё, что не зависит от конкретного раннера, живёт здесь — иначе панель тестов
 * пришлось бы писать второй раз, а разборы расходились бы по мелочам.
 *
 * Конкретика раннера — в `python-tests.ts` и `node-tests.ts`: как собрать список
 * и во что превратить вывод.
 */

/** Один собранный тест: идентификатор для запуска и части для показа. */
export interface CollectedTest {
  /** Идентификатор для запуска — ровно его принимает раннер. */
  id: string;
  /** Файл от корня проекта (POSIX). */
  file: string;
  /** Группа, если тест в ней (`TestSum`, `describe`), иначе null. */
  className: string | null;
  /** Имя теста с параметрами (`test_adds[1-2]`). Пусто — в файле отдельных имён нет. */
  name: string;
}

/** Сводка сбора: сколько собрали и не было ли ошибок сбора. */
export interface CollectedSuite {
  tests: CollectedTest[];
  /** Сколько тестов объявил раннер (включая неразобранные строки). */
  total: number;
  /** Ошибки сбора: файл не импортируется и подобное. */
  errors: string[];
}

/**
 * Собранные тесты вместе с раннером, которым их собрали.
 *
 * Раннер нужен интерфейсу только для подписи: `pytest`, `vitest`, `jest` или
 * `node --test`. У сборщика конкретного языка он свой, а панель тестов — одна.
 */
export interface TestSuite extends CollectedSuite {
  /** Как назвать раннер человеку; null — тестов и раннера в проекте нет. */
  runner: string | null;
}

/** Узел дерева тестов: файл, группа или сам тест. */
export interface TestFolder {
  /** Что это за узел. */
  kind: 'file' | 'class' | 'test';
  /** Подпись: `test_math.py`, `TestSum`, `test_adds`. */
  label: string;
  /**
   * Селектор для запуска этого узла: у теста — его id, у группы — свой селектор,
   * у файла — его путь. Пустым id бывает только у служебных узлов.
   */
  id?: string;
  children: TestFolder[];
}

/**
 * Собрать дерево тестов: файл → группа → тест.
 *
 * Один и тот же файл и группа не повторяются: строки идут вперемешку, и без
 * склейки дерево распалось бы на сотню веток по одному тесту. Тест без имени
 * (сбор знает только файлы — так умеет `jest --listTests` и `node --test`)
 * оставляет после себя один узел файла: запускать в нём больше нечего.
 */
export function buildTestTree(tests: readonly CollectedTest[]): TestFolder[] {
  const files = new Map<string, TestFolder>();
  const groups = new Map<string, Map<string, TestFolder>>();

  for (const test of tests) {
    let file = files.get(test.file);
    if (!file) {
      // У файла свой id: ▶ у него запускает тесты этого файла, а не всего проекта.
      file = { kind: 'file', label: test.file, id: test.file, children: [] };
      files.set(test.file, file);
      groups.set(test.file, new Map());
    }
    if (!test.name) continue;

    if (!test.className) {
      file.children.push({ kind: 'test', label: test.name, id: test.id, children: [] });
      continue;
    }

    const inFile = groups.get(test.file)!;
    let group = inFile.get(test.className);
    if (!group) {
      // Селектор группы — файл и имя: ▶ запускает только её.
      group = { kind: 'class', label: test.className, id: `${test.file}::${test.className}`, children: [] };
      inFile.set(test.className, group);
      file.children.push(group);
    }
    group.children.push({ kind: 'test', label: test.name, id: test.id, children: [] });
  }

  return [...files.values()];
}

/* ── запуск отдельного теста из редактора ───────────────────────────────── */

/** Тест, который можно запустить прямо из файла: строка и селектор для раннера. */
export interface RunnableTest {
  /** Строка объявления теста (1-based) — по ней ставится значок ▶. */
  line: number;
  /** Селектор: `файл::имя` или `файл::Группа::имя`. */
  selector: string;
  /** Имя теста без группы — для подписи. */
  name: string;
}

/* ── исход прогона ──────────────────────────────────────────────────────── */

/**
 * Маркер результата прогона в выводе терминала.
 *
 * Тесты запускаются в терминале (их видно и можно прервать), но терминал — это
 * оболочка, которая после раннера не завершается: кода выхода из события процесса
 * не получить. Поэтому к команде добавляется печать кода выхода предсказуемой
 * строкой, и панель тестов узнаёт исход, читая вывод.
 */
export const TEST_RESULT_MARKER = 'chui-test-result';

/**
 * Хвост команды тестов, печатающий код выхода. Оболочка на Windows — PowerShell,
 * на остальных — POSIX: переменная с кодом у них разная.
 */
export function resultMarkerCommand(platform: string): string {
  const code = platform === 'win32' ? '$LASTEXITCODE' : '$?';
  return `; echo "${TEST_RESULT_MARKER} ${code}"`;
}

/** Убрать управляющие последовательности ANSI: цвет и перерисовка строк вывод не портят. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * Код выхода из вывода терминала, если маркер в нём нашёлся. null — не нашли:
 * команда ещё идёт, это не тестовый прогон, или оболочка не поняла хвост.
 */
export function parseResultMarker(text: string): number | null {
  const match = new RegExp(`${TEST_RESULT_MARKER} (\\d+)`).exec(stripAnsi(text));
  return match ? Number(match[1]) : null;
}
