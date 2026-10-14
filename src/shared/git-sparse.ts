/**
 * Разреженный рабочий каталог (sparse checkout) — модель и чистый разбор ответов git.
 *
 * Sparse checkout говорит git, что из репозитория выкладывать на диск: файлы вне
 * выбранных каталогов в рабочем дереве не появляются. Это не про историю (она целиком
 * у git), а про то, что видно в проводнике и что обходят поиск с заменой. Так большие
 * монорепозитории перестают тянуть на диск сотни чужих пакетов.
 *
 * Режим `cone` (по умолчанию в новых git) задаётся не шаблонами, а КАТАЛОГАМИ:
 * `git sparse-checkout set --cone src tests` выкладывает `src` и `tests` целиком, а
 * прочее — только файлы в корне. Именно поэтому в интерфейсе видны каталоги, а не
 * строки шаблонов: `git sparse-checkout list` в cone-режиме выдаёт служебные строки
 * вместе с каталогами — их отделяет `sparseDirectories`.
 *
 * Здесь — только разбор и приведение значений: ни ФС, ни запуска процессов (их дело —
 * в main, `git/git.ts`), ни показа (он в интерфейсе).
 */

/** Что знает главный процесс про разреженный режим репозитория. */
export interface GitSparseInfo {
  /** Включён ли режим (`core.sparseCheckout`). Выключен — на диске весь репозиторий. */
  enabled: boolean;
  /** Режим `cone`: набор каталогов. `false` — набор шаблонов (путей с `*` и `!`). */
  cone: boolean;
  /** Строки `git sparse-checkout list` как они есть; при выключенном режиме — пусто. */
  patterns: string[];
}

/** Пустая запись: разреженный режим в репозитории не включён. */
export function emptySparseInfo(): GitSparseInfo {
  return { enabled: false, cone: false, patterns: [] };
}

/** Значение `core.sparseCheckout` (или подобного флага) — включено ли. */
export function parseSparseFlag(value: string): boolean {
  return value.trim().toLowerCase() === 'true';
}

/** Разбор `git sparse-checkout list`: по строке на шаблон, пустые строки отбрасываем. */
export function parseSparseList(stdout: string): string[] {
  const patterns: string[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line !== '') patterns.push(line);
  }
  return patterns;
}

/**
 * Каталоги из списка шаблонов. В cone-режиме `git sparse-checkout list` добавляет
 * служебные строки: шаблон всего в корне и исключения промежуточных
 * каталогов. Они не то, что выбирал человек: показываем только каталоги — строки,
 * начинающиеся с `/`, без `*` и без `!`.
 */
export function sparseDirectories(patterns: readonly string[]): string[] {
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (!pattern.startsWith('/') || pattern.startsWith('!/') || pattern.includes('*')) continue;
    const clean = trimSlashes(pattern);
    if (clean !== '') dirs.push(clean);
  }
  return dirs;
}

/** Похоже ли, что список — из cone-режима: там есть служебная строка корня. */
export function isConePatterns(patterns: readonly string[]): boolean {
  return patterns.some((pattern) => pattern === '/*' || pattern === '!/*/');
}

/**
 * Шаблоны без служебных строк cone-режима — то, что задал человек. Сохраняем порядок:
 * так список читается стабильно, а не переставляется от вызова к вызову.
 */
export function explicitPatterns(patterns: readonly string[]): string[] {
  return patterns.filter((pattern) => pattern !== '/*' && pattern !== '!/*/');
}

/** Снять ведущие и хвостовые слэши: `/src/` → `src`. */
function trimSlashes(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Привести каталог к виду, который примет `git sparse-checkout set`. Слэши по краям
 * убираем, а небезопасные значения (пустое, `.`/`..`, пробелы и обратные слэши)
 * отвергаем: `null` — каталог не годится.
 */
export function normalizeSparseDirectory(value: string): string | null {
  const clean = trimSlashes(value.trim().replace(/\\/g, '/'));
  if (clean === '' || clean === '.') return null;
  if (clean.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  if (clean.includes('*')) return null;
  return clean;
}

/**
 * Добавить каталог к списку, не повторяя уже выбранные. Вложенный каталог
 * добавляется тоже: git сам разберётся, что родитель уже выложен, а человек видит,
 * что именно он выбрал.
 */
export function addSparseDirectory(directories: readonly string[], directory: string): string[] {
  const clean = normalizeSparseDirectory(directory);
  if (clean === null) return [...directories];
  if (directories.includes(clean)) return [...directories];
  return [...directories, clean];
}

/** Убрать каталог из списка. */
export function removeSparseDirectory(directories: readonly string[], directory: string): string[] {
  const clean = normalizeSparseDirectory(directory);
  if (clean === null) return [...directories];
  return directories.filter((item) => item !== clean);
}

/** Короткая строка состояния для окна: включён ли режим, сколько каталогов выбрано. */
export function sparseSummary(info: GitSparseInfo): string {
  if (!info.enabled) return 'Разреженный режим выключен — на диске весь репозиторий.';
  if (!info.cone) {
    const count = explicitPatterns(info.patterns).length;
    return `Разреженный режим включён (шаблоны): ${count === 1 ? '1 правило' : `правил: ${count}`}.`;
  }
  const dirs = sparseDirectories(info.patterns);
  if (dirs.length === 0) return 'Разреженный режим включён, но каталоги не выбраны — на диске только корень.';
  return `Разреженный режим включён: ${dirs.length === 1 ? '1 каталог' : `каталогов: ${dirs.length}`}.`;
}
