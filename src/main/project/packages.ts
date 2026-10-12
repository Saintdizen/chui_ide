import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  matchWorkspaces,
  packageAt,
  parseManifest,
  type PackageKind,
  type ProjectPackage,
} from '../../shared/monorepo';

/**
 * Пакеты проекта: поиск манифестов и раскрытие рабочих областей.
 *
 * Монорепо узнаётся по манифестам: у Node это `package.json` (в корне — иногда с
 * `workspaces`), у Python — `pyproject.toml` или `setup.py`. Ищем неглубоко (до двух
 * уровней) и никогда не заходим в служебные каталоги: `node_modules` в монорепо
 * содержит тысячи чужих `package.json`, и обход по ним — это минуты работы впустую.
 *
 * Если в корневом `package.json` заданы `workspaces`, ограничиваемся их масками:
 * так найдутся пакеты в `packages/*`, даже если они лежат глубже нашего обхода.
 */

/** Каталоги, в которые не заходим: там лежит не наш код. */
const SKIP = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.chui_ide',
  '.idea',
  '.vscode',
]);

/** Манифест Node и Python соответственно. */
const NODE_MANIFEST = 'package.json';
const PYTHON_MANIFESTS = ['pyproject.toml', 'setup.py'];

async function readIfExists(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Вид пакета по каталогу: какой манифест там лежит. */
async function kindOf(dir: string): Promise<PackageKind | null> {
  if (await readIfExists(path.join(dir, NODE_MANIFEST))) return 'node';
  for (const name of PYTHON_MANIFESTS) {
    if (await readIfExists(path.join(dir, name))) return 'python';
  }
  return null;
}

/** Текст манифеста, из которого берём имя пакета. */
async function manifestText(dir: string, kind: PackageKind): Promise<string | undefined> {
  if (kind === 'node') return (await readIfExists(path.join(dir, NODE_MANIFEST))) ?? undefined;
  for (const name of PYTHON_MANIFESTS) {
    const text = await readIfExists(path.join(dir, name));
    if (text !== null) return text;
  }
  return undefined;
}

/**
 * Каталоги проекта до глубины `depth` (пути от корня, без ведущего слэша).
 * Служебные — пропускаем целиком, вместе со всем, что внутри.
 */
async function listDirs(root: string, depth: number): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string, left: number): Promise<void> => {
    if (left <= 0) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') && entry.name !== '.config') continue;
      if (SKIP.has(entry.name)) continue;
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      found.push(relative);
      await walk(path.join(dir, entry.name), relative, left - 1);
    }
  };
  await walk(root, '', depth);
  return found;
}

/**
 * Пакеты проекта. Корневой манифест тоже пакет, но с пустым путём: так файл в корне
 * получает хозяина, а список пакетов остаётся полным.
 */
export async function findPackages(root: string): Promise<ProjectPackage[]> {
  if (!root) return [];
  const packages: ProjectPackage[] = [];

  const rootNode = await readIfExists(path.join(root, NODE_MANIFEST));
  const rootPython = rootNode ? null : ((await manifestText(root, 'python')) ?? null);
  if (rootNode !== null) packages.push(packageAt('', 'node', rootNode));
  else if (rootPython !== null) packages.push(packageAt('', 'python', rootPython));

  const dirs = await listDirs(root, 2);
  const workspaces = rootNode ? parseManifest(rootNode).workspaces : [];
  // Маски рабочих областей точнее неглубокого обхода: берём только их, если они есть.
  const candidates = workspaces.length > 0 ? matchWorkspaces(workspaces, dirs) : dirs;

  const seen = new Set<string>(packages.map((item) => item.path));
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    const kind = await kindOf(path.join(root, dir));
    if (!kind) continue;
    seen.add(dir);
    packages.push(packageAt(dir, kind, await manifestText(path.join(root, dir), kind)));
  }
  return packages;
}
