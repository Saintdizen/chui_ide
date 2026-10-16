import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Относительные импорты: есть ли на диске то, на что ссылаются.
 *
 * Живёт в main — здесь файловая система. Renderer получает готовый ответ (какие
 * спецификаторы не разрешились) и рисует пометки — тем же путём, что у проверки
 * пакетов (`python/packages.ts`, `node/packages.ts`).
 *
 * Проверка существования передаётся функцией: «какие пути попробовать» — правило
 * языка, и оно проверяется тестами без диска.
 *
 * Чего здесь нет намеренно:
 *
 *   • путь-алиасы (`@/components`, `paths` в tsconfig) — они разрешаются конфигом
 *     сборщика, которого мы не читаем, и объявлять их недостающими нельзя;
 *   • `from . import name` у Python — имя может быть определено в `__init__.py`,
 *     и файла с таким именем просто нет (разбор такие ссылки не отдаёт).
 */

/** Проверка «этот путь есть»: по умолчанию — диск, в тестах — своя функция. */
export type ExistsCheck = (target: string) => Promise<boolean>;

/**
 * Расширения, которые пробуем у относительного импорта JS/TS. Порядок — как в
 * TypeScript: сначала свои для проекта, потом обычные для Node.
 */
const SCRIPT_SUFFIXES = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'] as const;

/**
 * Импорт с расширением `.js` в TypeScript-проекте указывает на `.ts`: это правило
 * самого TS (`allowImportingTsExtensions` наоборот), а не ошибка. Без этой пары
 * `import './util.js'` в проекте с одним `util.ts` подчёркивался бы как ненайденный.
 */
const TS_FOR_JS: Readonly<Record<string, string>> = {
  '.js': '.ts',
  '.jsx': '.tsx',
  '.mjs': '.mts',
  '.cjs': '.cts',
};

/**
 * Пути, которые надо попробовать у относительного импорта JS/TS: сам путь (если с
 * расширением), он же с расширениями, затем `index` внутри каталога. Первый
 * существующий и есть ответ — так же ищет и Node, и TypeScript.
 */
export function scriptImportCandidates(filePath: string, specifier: string): string[] {
  const base = path.resolve(path.dirname(filePath), specifier);
  const candidates: string[] = [];
  const extension = path.extname(base);

  if (extension) {
    // Расширение названо — это файл, а не каталог: `index` внутри него не ищем.
    candidates.push(base);
    const forTypeScript = TS_FOR_JS[extension];
    if (forTypeScript) candidates.push(`${base.slice(0, -extension.length)}${forTypeScript}`);
  } else {
    for (const suffix of SCRIPT_SUFFIXES) candidates.push(`${base}${suffix}`);
    // Каталог со своим `index`: `import './utils'` → `utils/index.ts`.
    for (const suffix of SCRIPT_SUFFIXES) candidates.push(path.join(base, `index${suffix}`));
  }

  return candidates;
}

/**
 * Пути, которые надо попробовать у относительного импорта Python.
 *
 * Ведущие точки — уровень относительно текущего пакета: у модуля `pkg/sub/mod.py`
 * одна точка даёт каталог самого модуля, две — родительский пакет. Дальше имя
 * разворачивается в путь по точкам, как это делает сам интерпретатор.
 */
export function pythonImportCandidates(filePath: string, specifier: string): string[] {
  const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
  const rest = specifier.slice(dots);
  // Без точек это не относительный импорт, без имени — нечего искать (`from . import x`).
  if (dots === 0 || rest.length === 0) return [];

  let dir = path.dirname(filePath);
  for (let level = 1; level < dots; level += 1) dir = path.dirname(dir);
  const target = path.join(dir, ...rest.split('.'));

  return [
    `${target}.py`,
    path.join(target, '__init__.py'),
    // Namespace-пакет: каталог без `__init__.py` в Python 3 тоже импортируется.
    target,
  ];
}

/** Есть ли файл по этому пути. Ответ — только «да/нет»: причина отказа не важна. */
const onDisk: ExistsCheck = (target) =>
  fs
    .access(target)
    .then(() => true)
    .catch(() => false);

/**
 * Спецификаторы, которые не удалось разрешить: их и подчёркиваем.
 *
 * Пустой ответ — не «всё хорошо», а «судить нечем»: так устроены ссылки, для
 * которых путей не придумано (см. шапку файла). Лучше промолчать, чем подчеркнуть
 * рабочий импорт.
 */
export async function missingLocalImports(
  language: string,
  filePath: string,
  specifiers: readonly string[],
  exists: ExistsCheck = onDisk,
): Promise<string[]> {
  const unique = [...new Set(specifiers)].filter((item) => item);
  if (unique.length === 0) return [];

  const candidatesFor = language === 'python' ? pythonImportCandidates : scriptImportCandidates;
  const missing: string[] = [];

  for (const specifier of unique) {
    const candidates = candidatesFor(filePath, specifier);
    if (candidates.length === 0) continue;

    let found = false;
    for (const target of candidates) {
      if (await exists(target)) {
        found = true;
        break;
      }
    }
    if (!found) missing.push(specifier);
  }

  return missing;
}
