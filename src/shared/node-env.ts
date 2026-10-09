/**
 * Окружение Node-проекта: версия Node, менеджер пакетов, зависимости и их здоровье.
 *
 * Здесь только правила и разбор строк — ни процессов, ни диска (они в main). Так
 * модуль видно в тестах: «подходит ли версия Node под `engines.node`» и «чего не
 * хватает из package.json» — это решения, а не I/O, и ошибиться в них дороже всего.
 *
 * Аналог `shared/python-env.ts` и `shared/python-packages.ts`, но окружение другое:
 * у Node нет виртуального окружения — есть `node_modules` рядом с проектом и
 * версия самого Node в PATH. Поэтому тут нет ни «главного окружения», ни активации.
 */

/** Менеджер пакетов Node. Тот же набор, что в инструментах проекта. */
export type NodePackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Версия Node, которой запускается проект, и чем её получили. */
export interface NodeRuntime {
  /** Версия без `v`: `22.12.0`. null — Node не найден в PATH. */
  version: string | null;
  /** Команда, которой спрашивали версию: `node`. */
  command: string;
  /** Как показать человеку: `Node 22.12`. */
  label: string;
}

/** Версия менеджера пакетов: без неё видно только имя. */
export interface NodePackageManagerInfo {
  name: NodePackageManager;
  version: string | null;
}

/** Сводка окружения Node для интерфейса: версия Node и менеджер пакетов. */
export interface NodeInfo {
  runtime: NodeRuntime;
  packageManager: NodePackageManagerInfo;
}

/** Версия менеджера из его вывода: `10.9.0`. */
export function parsePackageManagerVersion(text: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:-[^\s]+)?)/.exec(text);
  return match ? match[1]! : null;
}

/** Версия из вывода `node --version`: `v22.12.0` → `22.12.0`. */
export function parseNodeVersion(text: string): string | null {
  const match = /v?(\d+\.\d+\.\d+(?:-[^\s]+)?)/.exec(text);
  return match ? match[1]! : null;
}

/** Подпись версии Node: для интерфейса хватает major.minor. */
export function nodeVersionLabel(version: string | null): string {
  if (!version) return 'Node не найден';
  const [major, minor] = version.split('.');
  return minor ? `Node ${major}.${minor}` : `Node ${version}`;
}

/**
 * Чем Node запускает TypeScript встроенными средствами — без сборки, `tsx` и
 * каких-либо зависимостей проекта.
 *
 * Умение появилось не сразу: стирание типов (`--experimental-strip-types`) Node
 * получил в 22.6, а с 23.6 оно включено по умолчанию и флаг не нужен. Более
 * старый Node TypeScript не выполняет вовсе — тогда возвращаем null, и запуск
 * честно не предлагается. Версию спрашивают один раз на проект, поэтому решение
 * здесь чистое и проверяется в тестах.
 */
export function nodeTypeStripCommand(version: string | null): string | null {
  const parsed = version ? parsePartial(version) : null;
  if (!parsed || parsed.major === null) return null;
  const major = parsed.major;
  const minor = parsed.minor ?? 0;

  // 23.6+ — стирание типов по умолчанию: обычный `node file.ts` уже работает.
  if (major > 23 || (major === 23 && minor >= 6)) return 'node';
  // 22.6+ — умение есть, но пока за флагом.
  if (major === 22 && minor >= 6) return 'node --experimental-strip-types';
  return null;
}

/* ── версии и диапазоны ─────────────────────────────────────────────────────
 * `engines.node` задаётся диапазоном semver (`>=18`, `^20.10`, `20 || 22`), и
 * проверить его нужно без сторонних библиотек — это единственное место, где
 * диапазоны встречаются. Реализация нарочно неполная: поддержаны записи, которые
 * реально пишут в `engines.node`, а неразборчивая запись просто не сужает ответ —
 * сомнительный диапазон считается подходящим.
 */

interface PartialVersion {
  major: number | null;
  minor: number | null;
  patch: number | null;
}

/** Разбор версии с пропусками: `20`, `20.10`, `20.10.1`, `x`, `*`. */
function parsePartial(text: string): PartialVersion | null {
  const clean = text.trim().replace(/^v/i, '');
  if (!clean) return null;
  const [main] = clean.split(/[-+]/);
  const parts = main!.split('.');
  const value = (part: string | undefined): number | null => {
    if (part === undefined || part === '' || /^[x*]$/i.test(part)) return null;
    const number = Number(part);
    return Number.isFinite(number) ? number : null;
  };
  return { major: value(parts[0]), minor: value(parts[1]), patch: value(parts[2]) };
}

/** Версия как три числа: пропуски считаем нулями — `20` = `20.0.0`. */
function toNumbers(partial: PartialVersion): [number, number, number] {
  return [partial.major ?? 0, partial.minor ?? 0, partial.patch ?? 0];
}

/** Сравнение версий: <0, 0, >0. */
function compare(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const diff = left[index]! - right[index]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Границы «каретки»: `^1.2.3` → [1.2.3, 2.0.0). */
function caretUpper(partial: PartialVersion): [number, number, number] {
  const major = partial.major ?? 0;
  if (partial.major === null) return [1, 0, 0];
  if (major > 0) return [major + 1, 0, 0];
  const minor = partial.minor ?? 0;
  if (minor > 0) return [0, minor + 1, 0];
  return [0, 0, (partial.patch ?? 0) + 1];
}

/** Границы «тильды»: `~1.2.3` → [1.2.3, 1.3.0), `~1` → [1.0.0, 2.0.0). */
function tildeUpper(partial: PartialVersion): [number, number, number] {
  const major = partial.major ?? 0;
  if (partial.major === null) return [1, 0, 0];
  if (partial.minor === null) return [major + 1, 0, 0];
  return [major, (partial.minor ?? 0) + 1, 0];
}

/** Одно условие диапазона (`>=18`, `^20`, `1.x`) против версии. */
function satisfiesComparator(version: [number, number, number], token: string): boolean {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
  if (!match) return true;
  const operator = match[1] ?? '';
  const partial = parsePartial(match[2]!);
  // Пустое или неразборчивое условие не сужает выбор.
  if (!partial || partial.major === null) return true;

  const lower = toNumbers(partial);
  switch (operator) {
    case '>=':
      return compare(version, lower) >= 0;
    case '>':
      return compare(version, lower) > 0;
    case '<=':
      return compare(version, lower) <= 0;
    case '<':
      return compare(version, lower) < 0;
    case '=':
      return compare(version, lower) === 0;
    case '^':
      return compare(version, lower) >= 0 && compare(version, caretUpper(partial)) < 0;
    case '~':
      return compare(version, lower) >= 0 && compare(version, tildeUpper(partial)) < 0;
    default:
      // Без оператора: `X` и `X.Y` — диапазон, точная версия — равенство.
      if (partial.minor === null) return compare(version, lower) >= 0 && compare(version, [lower[0] + 1, 0, 0]) < 0;
      if (partial.patch === null) return compare(version, lower) >= 0 && compare(version, tildeUpper(partial)) < 0;
      return compare(version, lower) === 0;
  }
}

/**
 * Подходит ли версия Node под диапазон из `engines.node`.
 *
 * Пустой или неразборчивый диапазон считаем подходящим: цель проверки — поймать
 * явную несостыковку («нужен Node ≥20, а стоит 18»), а не отругать за странную
 * запись. Неизвестен и сам Node — судить не о чем, тоже подходит.
 */
export function satisfiesNodeRange(version: string | null, range: string | null): boolean {
  if (!version || !range) return true;
  const clean = range.trim();
  if (!clean || /^[*x]$/i.test(clean)) return true;

  const current = parsePartial(version);
  if (!current || current.major === null) return true;
  const numbers = toNumbers(current);

  // Альтернативы через `||`: достаточно подойти под любую.
  return clean.split('||').some((alternative) => {
    const group = alternative.trim();
    if (!group) return true;

    // Дефисный диапазон: `18.0.0 - 20.5.0` — единственное условие в группе.
    const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(group);
    if (hyphen) {
      const low = parsePartial(hyphen[1]!);
      const high = parsePartial(hyphen[2]!);
      if (!low || !high) return true;
      return compare(numbers, toNumbers(low)) >= 0 && compare(numbers, toNumbers(high)) <= 0;
    }

    // Обычная группа: условия через пробел, все должны выполняться.
    return group.split(/\s+/).every((token) => satisfiesComparator(numbers, token));
  });
}

/* ── манифест проекта ─────────────────────────────────────────────────────── */

/** Зависимость из `package.json`: имя и запрошенный диапазон версии. */
export interface NodeDependency {
  name: string;
  /** Диапазон как написано: `^1.2.0`, `latest`, `workspace:*`. */
  range: string;
  /** Зависимость только для разработки (`devDependencies`). */
  dev: boolean;
}

/** Установленный в `node_modules` пакет: имя и версия. */
export interface NodePackage {
  name: string;
  version: string;
  /** Пакет объявлен в `devDependencies` проекта; у прочих — false. */
  dev: boolean;
}

/** Разобранный `package.json`: только то, что нужно окружению. */
export interface NodeManifest {
  /** Зависимости и dev-зависимости вместе. */
  dependencies: NodeDependency[];
  /** Диапазон `engines.node`; null — не задан. */
  engines: string | null;
  /** Поле `packageManager` (corepack): `pnpm@9.1.0`; null — не задано. */
  packageManager: string | null;
}

/**
 * Разбор `package.json`. Битый JSON — пустой манифест: судить по нему нечего,
 * а падать из-за чужого файла IDE не должна.
 */
export function parseNodeManifest(text: string): NodeManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { dependencies: [], engines: null, packageManager: null };
  }
  if (!raw || typeof raw !== 'object') return { dependencies: [], engines: null, packageManager: null };
  const value = raw as Record<string, unknown>;

  const dependencies: NodeDependency[] = [];
  const collect = (source: unknown, dev: boolean): void => {
    if (!source || typeof source !== 'object') return;
    for (const [name, range] of Object.entries(source as Record<string, unknown>)) {
      if (!name || typeof range !== 'string') continue;
      dependencies.push({ name, range, dev });
    }
  };
  collect(value.dependencies, false);
  collect(value.devDependencies, true);

  const enginesNode =
    value.engines && typeof value.engines === 'object' ? (value.engines as Record<string, unknown>).node : undefined;
  const packageManager = value.packageManager;

  return {
    dependencies,
    engines: typeof enginesNode === 'string' && enginesNode.trim() ? enginesNode.trim() : null,
    packageManager: typeof packageManager === 'string' && packageManager.trim() ? packageManager.trim() : null,
  };
}

/** Что дало сравнение зависимостей с установленным. */
export interface NodeDependenciesDiff {
  /** Просят, но в `node_modules` не нашли. */
  missing: NodeDependency[];
  /** Нашли в `node_modules` (по имени). */
  present: NodeDependency[];
}

/**
 * Чего не хватает в `node_modules`. Сравниваем по имени: диапазоны версий не
 * проверяем — для этого нужен полноценный semver и дерево транзитивных зависимостей,
 * а «пакета нет вовсе» — это то, что реально ломает запуск и что видно сразу.
 */
export function diffNodeDependencies(
  dependencies: readonly NodeDependency[],
  installed: readonly NodePackage[],
): NodeDependenciesDiff {
  const have = new Set(installed.map((item) => item.name));
  const missing: NodeDependency[] = [];
  const present: NodeDependency[] = [];
  for (const dependency of dependencies) {
    if (have.has(dependency.name)) present.push(dependency);
    else missing.push(dependency);
  }
  return { missing, present };
}

/* ── здоровье окружения ───────────────────────────────────────────────────── */

/** Что именно не так с окружением Node. */
export type NodeIssueKind =
  /** `node_modules` нет, хотя зависимости объявлены: проект не запустится. */
  | 'no-modules'
  /** `node_modules` есть, но пуст: установка оборвалась. */
  | 'empty-modules'
  /** Часть зависимостей не установлена. */
  | 'missing-deps'
  /** Версия Node не подходит под `engines.node`. */
  | 'engine-mismatch'
  /** Нет файла блокировки: сборка не воспроизводима. */
  | 'no-lockfile';

export interface NodeIssue {
  kind: NodeIssueKind;
  /** `error` — работать нельзя, `warning` — можно, но с оговоркой. */
  severity: 'error' | 'warning';
  /** Готовое объяснение человеку: что случилось и что делать. */
  message: string;
}

/** Проблемы окружения Node-проекта: имя в интерфейсе и список найденного. */
export interface NodeEnvironmentHealth {
  label: string;
  issues: NodeIssue[];
}

/**
 * Факты об окружении, собранные main. `null` там, где признак не проверяли:
 * неизвестное не должно превращаться в ошибку.
 */
export interface NodeEnvFacts {
  /** Как проект называется в интерфейсе: имя корня. */
  label: string;
  /** Каталог `node_modules` существует. */
  nodeModulesPresent: boolean;
  /** В `node_modules` есть хоть один пакет. */
  nodeModulesFilled: boolean;
  /** Сколько зависимостей объявлено (dependencies + devDependencies). */
  dependencyCount: number;
  /** Сколько объявленных зависимостей реально установлено. */
  installedCount: number;
  /** Диапазон `engines.node`; null — не задан. */
  engineRange: string | null;
  /** Версия Node в PATH; null — Node не найден. */
  nodeVersion: string | null;
  /** Имя найденного файла блокировки (`package-lock.json` и т.п.); null — нет. */
  lockfile: string | null;
  /** Менеджер пакетов проекта: по нему подсказываем команду установки. */
  packageManager: NodePackageManager;
}

/** Команда установки зависимостей менеджером проекта. */
export function installCommand(manager: NodePackageManager): string {
  return `${manager} install`;
}

/** Проблемы окружения по фактам. Пустой список — окружение в порядке. */
export function describeNodeEnvIssues(facts: NodeEnvFacts): NodeIssue[] {
  const issues: NodeIssue[] = [];

  // Зависимостей нет — проверять почти нечего: пустой `node_modules` возможен
  // (например, ставили и удалили пакеты), но это не «сломанное» окружение.
  if (facts.dependencyCount === 0) {
    if (facts.nodeModulesPresent && !facts.nodeModulesFilled) {
      issues.push({
        kind: 'empty-modules',
        severity: 'warning',
        message: `${facts.label}: node_modules пуст — вероятно, установка не завершилась`,
      });
    }
    return issues;
  }

  if (!facts.nodeModulesPresent) {
    issues.push({
      kind: 'no-modules',
      severity: 'error',
      message: `${facts.label}: node_modules не найден — зависимости не установлены, выполните ${installCommand(facts.packageManager)}`,
    });
  } else if (!facts.nodeModulesFilled) {
    issues.push({
      kind: 'empty-modules',
      severity: 'error',
      message: `${facts.label}: node_modules пуст — установка не завершилась, повторите ${installCommand(facts.packageManager)}`,
    });
  } else if (facts.installedCount < facts.dependencyCount) {
    const missing = facts.dependencyCount - facts.installedCount;
    issues.push({
      kind: 'missing-deps',
      severity: 'warning',
      message: `${facts.label}: не установлено ${missing} из ${facts.dependencyCount} зависимостей — выполните ${installCommand(facts.packageManager)}`,
    });
  }

  // Версию Node проверяем только когда известно и то и другое: неизвестное не ошибка.
  if (facts.engineRange && facts.nodeVersion && !satisfiesNodeRange(facts.nodeVersion, facts.engineRange)) {
    issues.push({
      kind: 'engine-mismatch',
      severity: 'warning',
      message: `${facts.label}: Node ${facts.nodeVersion} не подходит под engines.node (${facts.engineRange})`,
    });
  }

  if (!facts.lockfile) {
    issues.push({
      kind: 'no-lockfile',
      severity: 'warning',
      message: `${facts.label}: нет файла блокировки — версии пакетов у разных разработчиков разойдутся`,
    });
  }

  return issues;
}
