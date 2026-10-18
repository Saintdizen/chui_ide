/**
 * Виртуальные окружения Python: где они лежат, какие есть и чем их создают.
 *
 * Здесь только правила и разбор строк — файловая система живёт в main. Так
 * модуль видно в тестах: «какой venv главнее» и «какая команда активации» —
 * это решения, а не I/O, и ошибиться в них дороже всего.
 *
 * Окружения нужны сразу нескольким вещам: запуску файлов, тестам, подсказкам
 * (сервер языка ставится в venv) и терминалу — там окружение активируется само.
 */

import { isInsidePath, joinPath, pathAfter } from './paths';

/** Одно виртуальное окружение проекта. */
export interface PythonEnvironment {
  /** Абсолютный путь к каталогу окружения. */
  path: string;
  /** Путь от корня проекта (POSIX): так его видно человеку. */
  relative: string;
  /** Интерпретатор окружения абсолютным путём. */
  python: string;
  /** Как писать имя в интерфейсе: `.venv`, `venv/python3.12`. */
  label: string;
  /** Номер версии из `pyvenv.cfg`, если он там есть. */
  version: string | null;
  /** Окружение главное: его и берут запуск, тесты и подсказки по умолчанию. */
  primary: boolean;
}

/**
 * Где искать окружения, в порядке предпочтения. Порядок = приоритет: `.venv` —
 * соглашение современных инструментов, поэтому оно первое. Windows-пути идут
 * следом: проект может быть переносимым с машины на машину.
 */
export const VENV_CANDIDATES: ReadonlyArray<readonly [dir: string, relativePython: string]> = [
  ['.venv', '.venv/bin/python'],
  ['venv', 'venv/bin/python'],
  ['env', 'env/bin/python'],
  ['.venv', '.venv/Scripts/python.exe'],
  ['venv', 'venv/Scripts/python.exe'],
  ['env', 'env/Scripts/python.exe'],
  ['.python-venv', '.python-venv/bin/python'],
];

/** Каталоги окружений: нужны, чтобы не искать venv внутри самого venv. */
export const VENV_DIR_NAMES: ReadonlyArray<string> = ['.venv', 'venv', 'env', '.python-venv'];

/** Путь к интерпретатору окружения по его каталогу: платформа решает подпапку. */
export function venvPythonPath(venvDir: string, platform: string): string {
  return platform === 'win32' ? `${venvDir}/Scripts/python.exe` : `${venvDir}/bin/python`;
}

/** Путь к скрипту активации: `source` для POSIX, `.ps1` для Windows. */
export function venvActivatePath(venvDir: string, platform: string): string {
  return platform === 'win32' ? `${venvDir}/Scripts/Activate.ps1` : `${venvDir}/bin/activate`;
}

/**
 * Команда активации окружения для оболочки. Отдельная функция, потому что
 * активация — это НЕ просто `source`: нужно ещё поправить подсказку и не
 * сломаться на пробелах в пути.
 */
export function venvActivateCommand(venvRelative: string, platform: string): string {
  const quoted = /[\s'"]/.test(venvRelative) ? `"${venvRelative}"` : venvRelative;
  // Путь к скрипту строит venvActivatePath — чтобы правило «bin/activate или
  // Scripts/Activate.ps1» жило в одном месте.
  const script = venvActivatePath(quoted, platform);
  // PowerShell: политика выполнения у поставляемого скрипта — ByPass.
  return platform === 'win32' ? `. ${script}` : `source ${script}`;
}

/**
 * Разбор `pyvenv.cfg`: оттуда мы узнаём, какой версией питона создано окружение
 * и какой интерпретатор его породил. Формат — `ключ = значение`, по строке.
 */
export function parsePyvenvCfg(text: string): { version: string | null; base: string | null } {
  let version: string | null = null;
  // Приоритет ключей: `base-executable` > `executable` > `home`. Старые
  // окружения пишут только `home` (каталог), новые — точный путь к бинарнику.
  const bases: Array<{ key: string; value: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(version|base-executable|executable|home)\s*=\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const value = match[2]!;
    if (key === 'version') version = value;
    else bases.push({ key, value });
  }
  for (const key of ['base-executable', 'executable', 'home']) {
    const hit = bases.find((item) => item.key === key);
    if (hit) return { version, base: hit.value };
  }
  return { version, base: null };
}

/** Один интерпретатор Python, найденный в системе. */
export interface PythonInterpreter {
  /** Чем запускать: `python3.14`, `py` или полный путь к бинарнику. */
  command: string;
  /** Версия без слова Python: `3.14.0`. */
  version: string;
  /** Как показать человеку: `Python 3.14`. */
  label: string;
}

/** Версия из вывода `python --version`: `Python 3.14.0` → `3.14.0`. */
export function parsePythonVersion(text: string): string | null {
  const match = /python\s+(\d+\.\d+(?:\.\d+)?)/i.exec(text);
  return match ? match[1]! : null;
}

/** Подпись интерпретатора: для выбора довольно major.minor. */
export function pythonInterpreterLabel(version: string): string {
  const [major, minor] = version.split('.');
  return minor ? `Python ${major}.${minor}` : `Python ${version}`;
}

/** Сравнение версий вида `3.14.0`: нужно для сортировки списка по убыванию. */
export function comparePythonVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number(part) || 0);
  const right = b.split('.').map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Уровни установки пакетов, которые предлагает окно создания окружения.
 * Это не «режимы IDE», а осознанный выбор человека: ставить ли линтер, тесты
 * и сервер подсказок сразу — каждая строка добавляет пакетов в окружение.
 */
export type VenvInstallPreset = 'empty' | 'pytest' | 'full';

export interface VenvInstallOption {
  id: VenvInstallPreset;
  label: string;
  hint: string;
  /** Пакеты для `pip install` на выбранном уровне. */
  packages: readonly string[];
}

export const VENV_INSTALL_OPTIONS: readonly VenvInstallOption[] = [
  { id: 'empty', label: 'Пустое окружение', hint: 'Только питон и pip — ставьте зависимости сами', packages: [] },
  {
    id: 'pytest',
    label: 'Окружение для тестов',
    hint: 'pytest и его покрытие: тесты запускаются сразу',
    packages: ['pytest', 'pytest-cov'],
  },
  {
    id: 'full',
    label: 'Полное окружение',
    hint: 'Тесты, линтер и подсказки: pytest, pylsp с линтерами, ruff',
    // Базовый `python-lsp-server` сам код не проверяет: диагностику дают его
    // плагины, а их установка пакета не тянет — без pyflakes и pycodestyle сервер
    // молчит, и «подсказки» из описания остаются пустым обещанием. Проверено на
    // живом pylsp: с ними появляются «undefined name» и «imported but unused».
    packages: ['pytest', 'pytest-cov', 'python-lsp-server', 'pyflakes', 'pycodestyle', 'ruff'],
  },
];

/** Пакеты выбранного уровня. Неизвестный уровень — пустой список, без догадок. */
export function installPackages(preset: string): readonly string[] {
  return VENV_INSTALL_OPTIONS.find((option) => option.id === preset)?.packages ?? [];
}

/** Имя окружения по умолчанию: `.venv` — соглашение большинства проектов. */
export const DEFAULT_VENV_DIR = '.venv';

/** Проверка имени каталога окружения: путь и спецсимволы недопустимы. */
export function isValidVenvName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed.includes('/') || trimmed.includes('\\')) return false;
  return !/[*?"<>|]/.test(trimmed);
}

/* ── где создать окружение ──────────────────────────────────────────────── */

/**
 * Где создаётся окружение.
 *
 * `project` — обычный случай: каталог рядом с кодом, его находит поиск окружений
 * (`VENV_CANDIDATES`), и оно само становится основным. `home` и `custom` — окружение
 * ВНЕ проекта. Это нужно, когда окружение общее для нескольких проектов или когда в
 * репозиторий его класть не хотят (бинарники в git, конфликт с `.gitignore`). Такое
 * окружение поиск в проекте не найдёт никогда, поэтому после создания его назначают
 * интерпретатором проекта (см. `onCreated` в окне создания).
 */
export type VenvLocation = 'project' | 'home' | 'custom';

export interface VenvLocationOption {
  id: VenvLocation;
  label: string;
  hint: string;
}

export const VENV_LOCATIONS: readonly VenvLocationOption[] = [
  {
    id: 'project',
    label: 'В проекте',
    hint: 'Каталог внутри проекта: `.venv` рядом с кодом находят запуск, тесты и подсказки',
  },
  {
    id: 'home',
    label: 'В домашнем каталоге',
    hint: 'Общее окружение в `~/.venvs`: не попадает в репозиторий и годится нескольким проектам',
  },
  {
    id: 'custom',
    label: 'Своя папка',
    hint: 'Любая папка на диске — например, общая для нескольких проектов',
  },
];

/** Каталог общих окружений в домашней папке: `~/.venvs/<имя>`. */
export const HOME_VENVS_DIR = '.venvs';

/** Что известно о будущем окружении, чтобы решить, где его создавать. */
export interface VenvTargetInput {
  /** Корень проекта: для места «в проекте» и для относительного своего пути. */
  root: string;
  /** Домашний каталог: для `~/.venvs` и раскрытия `~`. */
  home: string;
  /** Где создавать. Не задано — в проекте (как было до появления выбора). */
  location?: VenvLocation;
  /** Имя каталога окружения. */
  name?: string;
  /** Своя папка: абсолютный путь, `~` или путь от корня проекта. */
  path?: string;
}

/**
 * Куда создавать окружение: каталог и его подпись для человека. Ошибка — строкой:
 * ее показывает тот, кто создаёт, и она говорит, что именно не так.
 */
export type VenvTarget = { dir: string; label: string } | { error: string };

/** Абсолютный ли путь. Windows — диск или сетевая папка; остальные — от корня. */
export function isAbsolutePath(target: string): boolean {
  if (/^[A-Za-z]:[/\\]/.test(target)) return true;
  if (target.startsWith('\\\\')) return true;
  return target.startsWith('/');
}

/**
 * Домашний каталог в записи `~`: так пути показывают человеку и так их пишут
 * в терминале. Внутри домашнего каталога — `~/...`, сам он — `~`.
 */
export function shortenHomePath(target: string, home: string): string {
  if (!home || !isInsidePath(home, target)) return target;
  const rest = pathAfter(home, target);
  if (!rest) return '~';
  return `~/${rest.split(/[/\\]/).filter(Boolean).join('/')}`;
}

/**
 * Каталог будущего окружения — по выбранному месту. Правило живéт здесь, а не в main:
 * его проверяют тесты без диска и процессов, а ошибиться в нём дорого — окружение
 * создаётся минутами и может лечь не туда (например, внутрь чужого репозитория).
 */
export function resolveVenvTarget(input: VenvTargetInput): VenvTarget {
  const location = input.location ?? 'project';
  const name = (input.name ?? DEFAULT_VENV_DIR).trim();

  if (location === 'project') {
    if (!isValidVenvName(name)) return { error: `Неверное имя окружения: ${name}` };
    if (!input.root) return { error: 'Проект не открыт — создавать окружение некуда' };
    return { dir: joinPath(input.root, name), label: name };
  }

  if (location === 'home') {
    if (!isValidVenvName(name)) return { error: `Неверное имя окружения: ${name}` };
    if (!input.home) return { error: 'Домашний каталог неизвестен — выберите свою папку' };
    const dir = joinPath(joinPath(input.home, HOME_VENVS_DIR), name);
    return { dir, label: shortenHomePath(dir, input.home) };
  }

  // Своя папка: путь как есть, `~` раскрываем, относительный считаем от проекта.
  const raw = (input.path ?? '').trim();
  if (!raw) return { error: 'Укажите папку для окружения' };
  const expanded = raw === '~' || /^~[/\\]/.test(raw) ? joinPath(input.home, raw.replace(/^~[/\\]?/, '')) : raw;
  const dir = isAbsolutePath(expanded) ? expanded : joinPath(input.root, expanded);
  if (!isAbsolutePath(dir)) return { error: `Не удалось понять путь: ${raw}` };
  return { dir, label: shortenHomePath(dir, input.home) };
}
