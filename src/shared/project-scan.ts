/**
 * Карта проекта: что за проект открыт, из чего он состоит и где в нём тесты.
 *
 * Здесь только чистая логика — она ничего не читает с диска. Обход каталогов
 * живёт в main (там файловая система), а этот модуль из списка путей делает
 * сводку. Так его видно в тестах без Electron: скан — это правило, а не I/O.
 *
 * Карта нужна сразу трём вещам: подсказкам (какой язык и какое окружение),
 * запуску тестов (где они лежат) и ассистенту (что за проект перед ним).
 */

import { languageInfoForPath } from './languages';

/** Сводка о проекте: то, что IDE выясняет один раз и держит как карту. */
export interface ProjectScan {
  /** Корень проекта абсолютным путём. */
  root: string;
  /** Имя проекта — последний сегмент корня. */
  name: string;
  /** Сколько файлов просмотрено (без служебных каталогов). */
  fileCount: number;
  /** Сколько каталогов просмотрено. */
  dirCount: number;
  /** Языки проекта по убыванию числа файлов. */
  languages: LanguageCount[];
  /** Что за проект — по манифестам в корне. */
  markers: ProjectMarker[];
  /** Вид проекта: главная технология одним вердиктом — «Python», «Node.js». */
  kind: ProjectKind;
  /** Тестовые файлы (относительные POSIX-пути). */
  testFiles: string[];
  /** Каталоги с тестами без повторов, в порядке появления. */
  testDirs: string[];
  /** Файлы-точки входа (относительные POSIX-пути). */
  entryPoints: string[];
  /** Каталоги верхнего уровня: по ним видно устройство проекта. */
  topDirs: string[];
}

/**
 * Каталоги, в которые скан не заходит: чужой код, кеши и сгенерированное.
 * Список закрытый и общий для всех: если дерево обходить по-разному в разных
 * местах, сводка разъедется.
 */
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  '.eggs',
  'site-packages',
  '.venv',
  'venv',
  'env',
  '.idea',
  '.vscode',
  'coverage',
  'htmlcov',
  '.next',
  '.nuxt',
  '.cache',
  '.gradle',
]);

/** Идти ли в этот каталог при обходе проекта. Имя — последний сегмент пути. */
export function isIgnoredDirectory(name: string): boolean {
  if (IGNORED_DIRS.has(name)) return true;
  // Ядро Python: интерпретатор со стандартной библиотекой, а не код проекта.
  return name.startsWith('lib/python');
}

/** Имя файла без ведущего пути. */
function fileName(target: string): string {
  const index = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
  return index < 0 ? target : target.slice(index + 1);
}

/* ── тесты ──────────────────────────────────────────────────────────────── */

/** `test_foo.py`, `foo_test.py`, `tests/*.py` — соглашения pytest и unittest. */
const PY_TEST = /^(?:test_.*|.*_test)\.py$/;
/** `foo.test.ts`, `foo.spec.tsx` — соглашения jest и vitest. */
const JS_TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** Файл, который исполняется Node: `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx` и родственные. */
const JS_FILE = /\.[cm]?[jt]sx?$/;
/** Каталог с тестами: сам факт того, что файл лежит в `tests/`, уже признак. */
const TEST_DIR = /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)/;

/**
 * Тестовый файл ли это. Смотрим и имя, и каталог: в pytest тест может называться
 * как угодно, если лежит под `tests/` и собирается правилом из конфига, — но
 * без разбора конфига безопаснее узнавать по имени и по папке тестов.
 */
export function isTestFile(relativePath: string): boolean {
  return isPythonTestFile(relativePath) || isNodeTestFile(relativePath);
}

/** Тестовый файл Python: по имени (`test_foo.py`) или по каталогу тестов. */
export function isPythonTestFile(relativePath: string): boolean {
  const name = fileName(relativePath);
  if (!name.endsWith('.py')) return false;
  return PY_TEST.test(name) || TEST_DIR.test(relativePath);
}

/**
 * Тестовый файл Node: по имени (`foo.test.ts`) или по каталогу тестов.
 *
 * Каталог считается признаком и здесь: `node --test` находит тесты и в `test/`
 * с любыми именами, а vitest с jest — по маске из своего конфига. Расширение при
 * этом проверяем тоже: иначе тест pytest из `tests/` считался бы и тестом Node,
 * и проект на Python получил бы предложение запустить его через `node --test`.
 */
export function isNodeTestFile(relativePath: string): boolean {
  const name = fileName(relativePath);
  if (!JS_FILE.test(name)) return false;
  return JS_TEST.test(name) || TEST_DIR.test(relativePath);
}

/** Каталог, в котором лежит файл (для группировки тестов). Пусто — файл в корне. */
export function parentDir(relativePath: string): string {
  const index = relativePath.lastIndexOf('/');
  return index < 0 ? '' : relativePath.slice(0, index);
}

/* ── языки ──────────────────────────────────────────────────────────────── */

export interface LanguageCount {
  id: string;
  label: string;
  files: number;
}

/**
 * Сколько файлов каждого языка в проекте.
 *
 * Порядок — по убыванию числа файлов: главный язык проекта должен быть первым,
 * иначе «проект на Python» с парой js-конфигов читался бы как проект на JS.
 * При равенстве решает алфавит — результат должен быть воспроизводимым.
 */
export function countLanguages(files: readonly string[]): LanguageCount[] {
  const counts = new Map<string, LanguageCount>();
  for (const file of files) {
    const info = languageInfoForPath(file);
    if (!info) continue;
    const existing = counts.get(info.id);
    if (existing) existing.files += 1;
    else counts.set(info.id, { id: info.id, label: info.label, files: 1 });
  }
  return [...counts.values()].sort((a, b) => b.files - a.files || a.id.localeCompare(b.id));
}

/* ── маркеры технологий ─────────────────────────────────────────────────── */

export interface ProjectMarker {
  /** Стабильный ключ: по нему UI решает, что показать. */
  id: string;
  label: string;
  /** Файл в корне, по которому опознали. */
  file: string;
}

/**
 * Вид проекта: главная технология одним вердиктом. Нужен там, где решение
 * простое — «Python или нет»: запуск тестов, подсказки, ассистент. Отдельно от
 * `markers`, потому что там список фактов, а здесь — вывод из них.
 */
export interface ProjectKind {
  /** Стабильный ключ: python, node, rust, go, … либо `unknown`. */
  id: string;
  /** Как назвать человеку: «Python (pyproject)», «Node.js». */
  label: string;
  /** Откуда узнали: по манифесту в корне, по коду или никак. */
  source: 'marker' | 'language' | 'none';
  /** Манифест, по которому опознали (когда source = 'marker'). */
  file?: string;
}

/**
 * Что за проект. Смотрим только файлы в корне: манифест в подпапке — это уже
 * подпроект, и приписывать его корню неверно.
 */
const MARKERS: ReadonlyArray<readonly [file: string, id: string, label: string]> = [
  ['pyproject.toml', 'python', 'Python (pyproject)'],
  ['requirements.txt', 'python', 'Python (requirements)'],
  ['setup.py', 'python', 'Python (setuptools)'],
  ['setup.cfg', 'python', 'Python (setuptools)'],
  ['Pipfile', 'python', 'Python (Pipenv)'],
  ['pipenv', 'python', 'Python (Pipenv)'],
  ['package.json', 'node', 'Node.js'],
  ['deno.json', 'deno', 'Deno'],
  ['Cargo.toml', 'rust', 'Rust'],
  ['go.mod', 'go', 'Go'],
  ['pom.xml', 'java', 'Java (Maven)'],
  ['build.gradle', 'java', 'Java (Gradle)'],
  ['composer.json', 'php', 'PHP'],
  ['Gemfile', 'ruby', 'Ruby'],
  ['CMakeLists.txt', 'cmake', 'CMake'],
  ['Makefile', 'make', 'Make'],
  ['Dockerfile', 'docker', 'Docker'],
  ['docker-compose.yml', 'docker', 'Docker Compose'],
  ['docker-compose.yaml', 'docker', 'Docker Compose'],
];

/** Путь лежит прямо в корне проекта (без вложенных каталогов). */
function isRootFile(relativePath: string): boolean {
  return !relativePath.includes('/') && !relativePath.includes('\\');
}

/** Маркеры технологий по файлам в корне проекта. Порядок — как в MARKERS. */
export function detectMarkers(files: readonly string[]): ProjectMarker[] {
  const rootFiles = new Set(files.filter(isRootFile));
  return MARKERS.filter(([file]) => rootFiles.has(file)).map(([file, id, label]) => ({ id, label, file }));
}

/* ── вид проекта ──────────────────────────────────────────────────────── */

/**
 * Какой манифест соответствует языку: у js и ts технология общая — Node, у C и
 * C++ сборка обычно на CMake. Остальные языки совпадают с id манифеста.
 */
const LANGUAGE_MARKER: Readonly<Record<string, string>> = {
  javascript: 'node',
  typescript: 'node',
  java: 'java',
  kotlin: 'java',
  scala: 'java',
  groovy: 'java',
  c: 'cmake',
  cpp: 'cmake',
  dockerfile: 'docker',
  makefile: 'make',
};

/**
 * Какой проект перед нами — одним вердиктом.
 *
 * Порядок доверия: манифест в корне называет технологию прямо, поэтому он
 * главный. Если манифестов несколько (бывает тулинг вроде `package.json` у
 * Python-проекта), решает преобладающий язык — он показывает, что за код здесь.
 * Манифестов нет вовсе — судим по коду: победивший язык и есть вид проекта.
 */
export function detectProjectKind(markers: readonly ProjectMarker[], languages: readonly LanguageCount[]): ProjectKind {
  const top = languages[0];
  const byLanguage = top ? (LANGUAGE_MARKER[top.id] ?? top.id) : null;
  // Из нескольких манифестов верим тому, что совпал с преобладающим языком.
  const matched = byLanguage ? markers.find((marker) => marker.id === byLanguage) : undefined;
  const marker = matched ?? markers[0];
  if (marker) return { id: marker.id, label: marker.label, source: 'marker', file: marker.file };

  if (top && byLanguage) return { id: byLanguage, label: top.label, source: 'language' };

  return { id: 'unknown', label: 'Неизвестно', source: 'none' };
}

/* ── точки входа ────────────────────────────────────────────────────────── */

/** Файлы, которые обычно запускают: `main.py`, `app.py`, `manage.py`, `index.js`. */
const ENTRY_NAMES: ReadonlySet<string> = new Set([
  'main.py',
  'app.py',
  'run.py',
  'manage.py',
  '__main__.py',
  'main.js',
  'main.mjs',
  'index.js',
  'index.ts',
  'server.js',
]);

/** Точки входа проекта: имена, знакомые почти каждому фреймворку. */
export function findEntryPoints(files: readonly string[], limit = 12): string[] {
  return files.filter((file) => ENTRY_NAMES.has(fileName(file))).slice(0, limit);
}

/* ── каталоги верхнего уровня ──────────────────────────────────────────── */

/**
 * Каталоги верхнего уровня — по ним видно устройство проекта.
 *
 * Берём только первый сегмент пути и сортируем по числу файлов: где кода больше,
 * тот каталог и главный. Глубже не идём — там уже `list_dir` по конкретной папке,
 * а карта должна оставаться короткой. Файлы в корне каталогами не считаются.
 */
export function topLevelDirs(files: readonly string[], limit = Number.POSITIVE_INFINITY): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const index = file.indexOf('/');
    if (index <= 0) continue;
    const dir = file.slice(0, index);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, limit))
    .map(([dir]) => dir);
}

/**
 * Собрать сводку из списка файлов. Чистая функция: обход диска отдельно,
 * поэтому и проверяется без него. Пути — относительные POSIX, как их видит UI.
 */
export function buildScan(input: {
  root: string;
  name: string;
  files: readonly string[];
  dirCount: number;
}): ProjectScan {
  const testFiles = input.files.filter(isTestFile);
  const testDirs: string[] = [];
  for (const file of testFiles) {
    const dir = parentDir(file);
    if (!testDirs.includes(dir)) testDirs.push(dir);
  }

  const languages = countLanguages(input.files);
  const markers = detectMarkers(input.files);

  return {
    root: input.root,
    name: input.name,
    fileCount: input.files.length,
    dirCount: input.dirCount,
    languages,
    markers,
    kind: detectProjectKind(markers, languages),
    testFiles,
    testDirs,
    entryPoints: findEntryPoints(input.files),
    topDirs: topLevelDirs(input.files),
  };
}
