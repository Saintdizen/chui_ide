/**
 * Тесты Node-проекта: чем запускаются, как собрать список и как выделить один тест.
 *
 * Раннеров три, и они разные по возможностям:
 * - `vitest` умеет отдать список тестов (`vitest list --json`) — дерево выходит
 *   с именами, как у pytest;
 * - `jest` умеет перечислить только файлы (`--listTests`) — дерево из файлов;
 * - `node --test` не умеет и этого, поэтому файлы берём из карты проекта.
 *
 * Общий для всех вид — дерево и запуск по узлу (см. `test-model.ts`), поэтому
 * здесь остаётся только разбор конкретного раннера. Разбор чужих выводов —
 * самое хрупкое место, и он живёт под тестами, а не в панели интерфейса.
 */

import { isNodeTestFile } from './project-scan';
import type { CollectedSuite, CollectedTest, RunnableTest, TestSuite } from './test-model';

/** Раннер, объявленный в проекте пакетом. */
export type DeclaredNodeRunner = 'vitest' | 'jest';

/** Чем запускаются тесты Node-проекта. `node` — встроенный `node --test`. */
export type NodeTestRunner = DeclaredNodeRunner | 'node';

/** Собранные тесты Node-проекта вместе с раннером, которым их собрали. */
export interface NodeTestSuite extends TestSuite {
  /** Раннер проекта; null — тестов в проекте нет и запускать нечем. */
  runner: NodeTestRunner | null;
}

/**
 * Раннер по зависимостям проекта: `vitest`, иначе `jest`, иначе ничего.
 *
 * Смотрим только объявленные зависимости, а не установленный `node_modules`:
 * так же, как это делает `python-view`, проект мог ещё не поставить пакеты, а
 * инструмент уже выбран — и подсказка «поставить тесты» тогда осмысленна.
 * Если объявлены оба, выигрывает vitest: он современнее и чаще соседствует с jest
 * лишь при переезде.
 */
export function nodeTestRunnerFrom(dependencies: readonly string[]): DeclaredNodeRunner | null {
  const declared = new Set(dependencies);
  if (declared.has('vitest')) return 'vitest';
  if (declared.has('jest')) return 'jest';
  return null;
}

/**
 * Чем запускать тесты этого проекта. Объявленный раннер важнее: он у проекта выбран
 * осознанно. Если раннера нет, но тестовые файлы есть, годится встроенный
 * `node --test` — современный Node запускает такой файл без всяких зависимостей.
 */
export function detectNodeTestRunner(
  declared: DeclaredNodeRunner | null,
  testFiles: readonly string[],
): NodeTestRunner | null {
  if (declared) return declared;
  return testFiles.some(isNodeTestFile) ? 'node' : null;
}

/** Как позвать раннер человеку: в подсказках и кнопках. */
export function nodeTestRunnerLabel(runner: NodeTestRunner): string {
  return runner === 'node' ? 'node --test' : runner;
}

/* ── селекторы ──────────────────────────────────────────────────────────── */

/**
 * Селектор одного теста или группы: `файл::имя`. Имя может быть полным
 * (`describe > тест`) — так его отдаёт vitest, и так его понимает `-t`.
 * Разделяем по ПЕРВОМУ `::`: имя теста тоже может содержать `::`, а путь — нет.
 */
export function nodeTestSelector(file: string, name: string | null): string {
  return name ? `${file}::${name}` : file;
}

/** Разобрать селектор обратно: файл и имя теста. */
export function parseNodeTestSelector(selector: string): { file: string; name: string | null } {
  const at = selector.indexOf('::');
  if (at < 0) return { file: selector, name: null };
  return { file: selector.slice(0, at), name: selector.slice(at + 2) || null };
}

/**
 * Имя теста как шаблон для раннера.
 *
 * И vitest с jest (`-t`), и `node --test` (`--test-name-pattern`) считают шаблон
 * регулярным выражением — а имя теста им не является: в нём встречаются скобки,
 * плюсы и квадратные скобки параметризованных прогонов (`test_adds[1-2]`), и без
 * экранирования такой шаблон либо не найдёт тест, либо сломается сам.
 */
export function nodeTestNamePattern(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ── сбор ───────────────────────────────────────────────────────────────── */

/** Файл к корню проекта, с прямыми слэшами: путь пришёл от раннера, а не от нас. */
export function relativeTo(root: string, file: string): string {
  const slash = (value: string): string => value.split('\\').join('/');
  const base = slash(root).replace(/\/+$/, '');
  const target = slash(file);
  return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : target;
}

/**
 * Разбор `vitest list --json`: массив `{ name, file, location }`.
 *
 * `name` — полное имя теста (`describe > тест`), а не короткое: именно его
 * принимает `-t`, поэтому id теста собираем из него. Часть до последнего ` > `
 * становится группой в дереве — как класс у pytest.
 */
export function parseVitestList(json: string, root: string): CollectedSuite {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return { tests: [], total: 0, errors: [`Список тестов vitest не разобрался: ${message(error)}`] };
  }
  if (!Array.isArray(parsed)) {
    return { tests: [], total: 0, errors: ['Список тестов vitest пришёл не массивом'] };
  }

  const tests: CollectedTest[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, file } = entry as { name?: unknown; file?: unknown };
    if (typeof name !== 'string' || typeof file !== 'string') continue;

    const path = relativeTo(root, file);
    const parts = name.split(' > ');
    const testName = parts.pop() ?? name;
    const group = parts.join(' > ');
    tests.push({
      id: nodeTestSelector(path, name),
      file: path,
      className: group || null,
      name: testName,
    });
  }

  return { tests, total: tests.length, errors: [] };
}

/**
 * Разбор `jest --listTests --json`: список тестовых файлов.
 *
 * Имён тестов jest тут не даёт (за ними пришлось бы запустить сами тесты), поэтому
 * узлы выходят файловыми. Форму ответа проверяем на оба вида: в разных версиях
 * это либо строки-пути, либо объекты с путём внутри.
 */
export function parseJestList(json: string, root: string): CollectedSuite {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return { tests: [], total: 0, errors: [`Список файлов jest не разобрался: ${message(error)}`] };
  }
  if (!Array.isArray(parsed)) {
    return { tests: [], total: 0, errors: ['Список файлов jest пришёл не массивом'] };
  }

  const files = parsed.map((entry) => filePathOf(entry)).filter(isString).map((file) => relativeTo(root, file));
  const tests = fileTests(files);
  return { tests, total: tests.length, errors: [] };
}

/** Тестовые файлы как тесты: у раннера нет списка имён, но файлы — уже дерево. */
export function nodeTestFilesSuite(files: readonly string[]): CollectedSuite {
  const tested = files.filter(isNodeTestFile);
  return { tests: fileTests(tested), total: tested.length, errors: [] };
}

/** Узлы-файлы: имя пустое — по нему дерево оставляет один узел файла. */
function fileTests(files: readonly string[]): CollectedTest[] {
  return files.map((file) => ({ id: file, file, className: null, name: '' }));
}

/** Путь из элемента ответа jest: строка или объект с полем пути. */
function filePathOf(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return null;
  const value = entry as { testFilePath?: unknown; path?: unknown };
  if (typeof value.testFilePath === 'string') return value.testFilePath;
  return typeof value.path === 'string' ? value.path : null;
}

/* ── тесты в файле: значки запуска ──────────────────────────────────────── */

/** Объявление теста: `test('имя'`, `it("имя"`, `test.only(` и подобные. */
const TEST_CALL = /^\s*(?:test|it)(?:\.\w+)?\s*\(\s*(['"`])(.+?)\1/;
/** Объявление группы: `describe('имя'`, `suite(`, `context(`. */
const GROUP_CALL = /^\s*(?:describe|suite|context)(?:\.\w+)?\s*\(\s*(['"`])(.+?)\1/;

/**
 * Тесты, объявленные в файле, — чтобы поставить у них значок запуска.
 *
 * Разбор нарочно простой, по строкам: нужен не синтаксис JavaScript, а строки
 * объявлений и то, в какой `describe` они лежат. Группу определяем по балансу
 * фигурных скобок: сколько их открыто на момент объявления — такова вложенность.
 * Строки и комментарии не разбираем — файл уже отобран как тестовый, и `test(`
 * внутри строки там встретится разве что случайно.
 */
export function findRunnableNodeTests(relativePath: string, text: string): RunnableTest[] {
  const file = relativePath.split('\\').join('/');
  const tests: RunnableTest[] = [];
  /** Открытые группы: имя и баланс скобок на момент открытия. */
  const groups: { name: string; depth: number }[] = [];
  let depth = 0;

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    const group = GROUP_CALL.exec(line);
    if (group) groups.push({ name: group[2]!, depth });

    const test = TEST_CALL.exec(line);
    if (test) {
      const name = test[2]!;
      // Подпись собираем по всей вложенности, как это делает vitest: иначе у теста
      // внутри двух `describe` в дереве пропала бы внешняя группа.
      const parents = groups.map((group) => group.name).join(' > ');
      tests.push({
        line: index + 1,
        // Для `-t` раннера хватает имени теста: он ищет его по вхождению в полное имя.
        selector: nodeTestSelector(file, name),
        name: parents ? `${parents} > ${name}` : name,
      });
    }

    depth += count(line, '{') - count(line, '}');
    while (groups.length > 0 && depth <= groups.at(-1)!.depth) groups.pop();
  }

  return tests;
}

/** Сколько раз символ встречается в строке. */
function count(line: string, char: string): number {
  let total = 0;
  for (const symbol of line) if (symbol === char) total += 1;
  return total;
}

/* ── мелочи ─────────────────────────────────────────────────────────────── */

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isString(value: string | null): value is string {
  return value !== null;
}
