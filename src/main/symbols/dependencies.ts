import { promises as fs } from 'node:fs';
import path from 'node:path';
import { languageInfoForPath } from '../../shared/languages';
import { isIndexedLanguage } from '../../shared/symbol-index';

/**
 * Зависимости проекта: где лежат чужие объявления и какие из них брать в карту.
 *
 * Свой код — половина ответа на «где это объявлено». Вторая половина в установленных
 * пакетах: `requests.Session`, `express.Router`, базовые классы фреймворков. Карта
 * поэтому смотрит и в `node_modules`, и в `site-packages` окружения Python.
 *
 * Бесконечности тут нет и быть не может: в `node_modules` после `npm install` бывают
 * десятки тысяч файлов, и разобрать их все — минуты работы и гигабайты кэша ради
 * символов, которые никто не искал. Поэтому у обхода три предела: файлов на пакет,
 * файлов всего и размер файла. Порядок тоже не случайный — сперва объявления
 * (`.d.ts`, `.pyi`): в них ровно то, что нужно карте, и нет тел.
 *
 * Модуль знает про диск, но не про карту: он отвечает списком файлов, а разбор —
 * дело сборщика.
 */

/** Каталог одного пакета: откуда брать файлы и как пакет называется. */
export interface DependencyRoot {
  /** Абсолютный путь к каталогу пакета (или к самому модулю `.py`). */
  dir: string;
  /** Имя пакета: `express`, `requests`. Оно показывается в списке символов. */
  package: string;
  /** Язык пакета: по нему сборщик выбирает, что разбирать. */
  language: string;
}

/** Файл зависимости: путь и пакет, из которого он взят. */
export interface DependencyFile {
  /** Абсолютный путь: чужие пакеты бывают и вне проекта, относительный не построить. */
  path: string;
  package: string;
  language: string;
}

/** Сколько файлов берём из одного пакета: объявлений хватает и без глубины. */
const MAX_FILES_PER_PACKAGE = 60;

/** Сколько файлов зависимостей берём всего: предел на весь проект. */
export const MAX_DEPENDENCY_FILES = 1200;

/** Служебные имена, которые пакетами не являются. */
const SKIP_NAMES: ReadonlySet<string> = new Set([
  '.bin',
  '.cache',
  'node_modules',
  '__pycache__',
  '__pypackages__',
  'bin',
  'Scripts',
  'include',
  'LICENSE',
]);

/**
 * Каталоги зависимостей проекта.
 *
 * Node: `node_modules` в корне. Python: окружения проекта (`.venv`, `venv`, `env`) и
 * окружение рабочего интерпретатора, где бы оно ни лежало — оно может быть общим в
 * `~/.venvs`, и тогда пакеты всё равно надо видеть.
 *
 * Ошибка чтения одного каталога не отменяет остальные: нет `node_modules` у проекта
 * на Python, и это нормально.
 */
export async function findDependencyRoots(options: {
  root: string;
  /** Каталог окружения рабочего интерпретатора, если он известен (может быть вне проекта). */
  venvDir?: string | null;
}): Promise<DependencyRoot[]> {
  const roots: DependencyRoot[] = [];
  roots.push(...(await nodeRoots(path.join(options.root, 'node_modules'))));

  const venvs = new Set<string>();
  for (const name of ['.venv', 'venv', 'env']) venvs.add(path.join(options.root, name));
  if (options.venvDir) venvs.add(options.venvDir);
  for (const venv of venvs) roots.push(...(await pythonRoots(venv)));

  return roots;
}

/** Пакеты верхнего уровня в `node_modules`. Область (`@scope`) — два сегмента имени. */
async function nodeRoots(nodeModules: string): Promise<DependencyRoot[]> {
  const roots: DependencyRoot[] = [];
  for (const entry of await readDir(nodeModules)) {
    if (!entry.isDirectory() || skipName(entry.name)) continue;
    if (entry.name.startsWith('@')) {
      // Область: пакеты лежат на уровень глубже, и имя у них `@scope/name`.
      const scopeDir = path.join(nodeModules, entry.name);
      for (const scoped of await readDir(scopeDir)) {
        if (!scoped.isDirectory() || skipName(scoped.name)) continue;
        roots.push({
          dir: path.join(scopeDir, scoped.name),
          package: `${entry.name}/${scoped.name}`,
          language: 'typescript',
        });
      }
      continue;
    }
    roots.push({ dir: path.join(nodeModules, entry.name), package: entry.name, language: 'typescript' });
  }
  return roots;
}

/** Пакеты в `site-packages` окружения Python. */
async function pythonRoots(venvDir: string): Promise<DependencyRoot[]> {
  const sites: string[] = [];
  const lib = path.join(venvDir, 'lib');
  for (const entry of await readDir(lib)) {
    if (!entry.isDirectory() || !entry.name.startsWith('python')) continue;
    sites.push(path.join(lib, entry.name, 'site-packages'));
  }
  // Windows раскладывает пакеты в Lib, а не lib.
  sites.push(path.join(venvDir, 'Lib', 'site-packages'));

  const roots: DependencyRoot[] = [];
  for (const site of sites) {
    for (const entry of await readDir(site)) {
      if (skipName(entry.name)) continue;
      // `requests-2.31.0.dist-info`, `foo.egg-info` — не пакеты, а их описание.
      if (entry.name.includes('.dist-info') || entry.name.includes('.egg-info')) continue;
      const full = path.join(site, entry.name);
      if (entry.isDirectory()) {
        roots.push({ dir: full, package: entry.name, language: 'python' });
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        roots.push({ dir: full, package: entry.name.slice(0, -3), language: 'python' });
      }
    }
  }
  return roots;
}

/**
 * Файлы зависимостей: сначала объявления, потом реализация.
 *
 * Объявления (`.d.ts`, `.pyi`) — то, что карте и нужно: имена, виды и сигнатуры без
 * тел. Если они в пакете есть, реализацию не читаем вовсе: `.ts` рядом с `.d.ts`
 * описал бы те же имена второй раз. Тела не нужны — по ним не искать.
 */
export async function listDependencyFiles(
  roots: readonly DependencyRoot[],
  limit = MAX_DEPENDENCY_FILES,
): Promise<DependencyFile[]> {
  const declarations: DependencyFile[] = [];
  const sources: DependencyFile[] = [];

  for (const root of roots) {
    if (declarations.length + sources.length >= limit) break;
    const taken = await filesOfPackage(root, MAX_FILES_PER_PACKAGE);
    for (const file of taken.declarations) declarations.push(file);
    // Объявления есть — реализацию не берём вовсе: `.ts` рядом с `.d.ts` описал бы те же
    // имена второй раз, а карте нужны имена, а не тела.
    if (taken.declarations.length > 0) continue;
    for (const file of taken.sources) sources.push(file);
  }

  const result: DependencyFile[] = [];
  for (const file of [...declarations, ...sources]) {
    if (result.length >= limit) break;
    result.push(file);
  }
  return result;
}

/**
 * Файлы одного пакета, разложенные на объявления и реализацию. Обход неглубокий:
 * `dist` и `lib` — основные каталоги сборки, а тесты и примеры пакета нам не нужны.
 */
async function filesOfPackage(
  root: DependencyRoot,
  limit: number,
): Promise<{ declarations: DependencyFile[]; sources: DependencyFile[] }> {
  const declarations: DependencyFile[] = [];
  const sources: DependencyFile[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3 || declarations.length + sources.length >= limit) return;
    for (const entry of await readDir(dir)) {
      if (entry.isDirectory()) {
        if (skipName(entry.name) || entry.name === 'test' || entry.name === 'tests') continue;
        await walk(path.join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const full = path.join(dir, entry.name);
      const language = languageInfoForPath(entry.name)?.id;
      if (!isIndexedLanguage(language)) continue;
      if (isNoise(entry.name)) continue;

      const target = { path: full, package: root.package, language: root.language };
      if (isDeclaration(entry.name)) {
        declarations.push(target);
        if (declarations.length + sources.length >= limit) return;
        continue;
      }
      // `.ts` в поставке пакета — это его исходники: те же объявления, что в `.d.ts`,
      // но с телами. Берём их, только когда объявлений у пакета нет вовсе.
      sources.push(target);
      if (declarations.length + sources.length >= limit) return;
    }
  };

  const stat = await fs.stat(root.dir).catch(() => null);
  if (stat?.isFile()) {
    const language = languageInfoForPath(root.dir)?.id;
    if (isIndexedLanguage(language)) {
      const target = { path: root.dir, package: root.package, language: root.language };
      if (isDeclaration(root.dir)) declarations.push(target);
      else sources.push(target);
    }
    return { declarations, sources };
  }

  await walk(root.dir, 0);
  return { declarations, sources };
}

/** Файл объявлений: там только имена и сигнатуры, без тел — именно то, что нужно карте. */
function isDeclaration(name: string): boolean {
  return name.endsWith('.d.ts') || name.endsWith('.d.mts') || name.endsWith('.d.cts') || name.endsWith('.pyi');
}

/** Файл, в котором объявлений не бывает: минифицированное и карты кода. */
function isNoise(name: string): boolean {
  return name.includes('.min.') || name.endsWith('.map');
}

function skipName(name: string): boolean {
  return name.startsWith('.') || SKIP_NAMES.has(name);
}

async function readDir(dir: string): Promise<import('node:fs').Dirent[]> {
  return fs.readdir(dir, { withFileTypes: true }).catch(() => []);
}
