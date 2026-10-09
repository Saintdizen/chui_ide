import { promises as fs } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

/**
 * Какие пакеты видит проект Node: что импортировать, а что нет.
 *
 * Живёт в main: здесь файловая система. Renderer получает готовый ответ — какие
 * имена недоступны, — и рисует пометки. Проверка та же по смыслу, что у Python
 * (`python/packages.ts`), только окружение другое: не интерпретатор, а каталоги
 * `node_modules`.
 *
 * Имена ищем по каталогам, а не запускаем `node --eval require.resolve`: во-первых,
 * это дешевле, во-вторых, не выполняет ни строчки чужого кода.
 */

/** Встроенные модули Node: `fs`, `path`. С префиксом `node:` их пишут, но не все. */
const BUILTINS: ReadonlySet<string> = new Set(
  builtinModules.flatMap((name) => (name.startsWith('node:') ? [name.slice(5)] : [name])),
);

/**
 * Список пакетов меняется редко, но меняется: `npm install` во время работы IDE
 * должен быть виден. Поэтому не вечный кэш, а короткий — иначе пришлось бы
 * перезапускать приложение после каждой установки.
 */
const CACHE_TTL = 4_000;

interface CacheEntry {
  at: number;
  packages: Promise<ReadonlySet<string>>;
}

const cache = new Map<string, CacheEntry>();

/**
 * Пакеты, которые видит проект: то, что лежит в `node_modules` рядом с файлом и
 * выше по дереву (так работает разрешение Node), плюс встроенные модули.
 */
export async function availablePackages(root: string): Promise<ReadonlySet<string>> {
  const now = Date.now();
  const cached = cache.get(root);
  if (cached && now - cached.at < CACHE_TTL) return cached.packages;

  const packages = collect(root).catch((error) => {
    cache.delete(root);
    throw error;
  });
  cache.set(root, { at: now, packages });
  return packages;
}

/**
 * Встроенный модуль — в любой записи: `fs` и `node:fs` это одно и то же.
 * Парсер импортов ссылки с протоколом отсекает, но имя может прийти и извне,
 * и тогда `node:fs` выглядел бы как неустановленный пакет.
 */
function isBuiltin(name: string): boolean {
  return BUILTINS.has(name) || BUILTINS.has(name.replace(/^node:/, ''));
}

/** Пакеты, которых нет ни в `node_modules`, ни среди встроенных модулей. */
export async function missingPackages(root: string | null, modules: readonly string[]): Promise<string[]> {
  const unique = [...new Set(modules)].filter((name) => name);
  if (unique.length === 0) return [];

  const available = new Set<string>(BUILTINS);
  if (root) {
    try {
      for (const name of await availablePackages(root)) available.add(name);
    } catch {
      return []; // без списка пакетов судить не о чем: лучше молчать, чем шуметь
    }
  }

  return unique.filter((name) => !available.has(name) && !isBuiltin(name));
}

/* ── обход каталогов ────────────────────────────────────────────────────── */

async function collect(root: string): Promise<ReadonlySet<string>> {
  const names = new Set<string>();

  // Разрешение Node идёт вверх по дереву: в монорепозитории пакеты часто лежат
  // в `node_modules` на уровень-два выше проекта. Идём до корня файловой системы.
  let dir = path.resolve(root);
  for (;;) {
    for (const name of await packagesIn(path.join(dir, 'node_modules'))) names.add(name);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return names;
}

/** Имена пакетов в одном `node_modules`: обычные и scoped (`@scope/name`). */
async function packagesIn(nodeModules: string): Promise<string[]> {
  const dirents = await fs.readdir(nodeModules, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];

  for (const entry of dirents) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    // Служебное: `.bin`, `.package-lock.json`, кэши.
    if (entry.name.startsWith('.')) continue;

    if (entry.name.startsWith('@')) {
      const scoped = await fs.readdir(path.join(nodeModules, entry.name), { withFileTypes: true }).catch(() => []);
      for (const inner of scoped) {
        if (inner.isDirectory() || inner.isSymbolicLink()) names.push(`${entry.name}/${inner.name}`);
      }
      continue;
    }
    names.push(entry.name);
  }

  return names;
}
