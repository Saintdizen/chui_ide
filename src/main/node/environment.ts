import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  describeNodeEnvIssues,
  diffNodeDependencies,
  nodeVersionLabel,
  parseNodeManifest,
  parseNodeVersion,
  parsePackageManagerVersion,
  type NodeEnvironmentHealth,
  type NodeInfo,
  type NodeManifest,
  type NodePackage,
  type NodePackageManager,
} from '../../shared/node-env';

/**
 * Окружение Node-проекта: версия Node, менеджер пакетов, установленные пакеты и
 * проверка на поломки.
 *
 * Живёт в main, потому что всё здесь — процессы и файловая система. Renderer
 * получает готовый ответ: он не знает ни путей, ни того, чем спрашивать версию.
 *
 * Аналог `python/environments.ts` и `python/health.ts` вместе, но окружение другое:
 * у Node нет venv — есть `node_modules` рядом с проектом и версия самого Node.
 */

/** Файлы блокировки в порядке предпочтения: тот же список, что у инструментов проекта. */
const LOCKFILES: ReadonlyArray<readonly [string, NodePackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

/** Предел списка пакетов: защита от вырожденного `node_modules`, не более. */
const MAX_PACKAGES = 2_000;

/**
 * Версия Node и чем её спрашивали. Ошибки не бросаем: нет Node в PATH — это факт,
 * который интерфейс покажет как «не найден», а не как сбой запроса.
 */
export async function nodeRuntime(): Promise<{ version: string | null; command: string }> {
  const command = 'node';
  const output = await runCapture(command, ['--version']);
  return { version: parseNodeVersion(output), command };
}

/** Версия менеджера пакетов: `npm --version`, `pnpm --version` и так далее. */
export async function packageManagerVersion(manager: NodePackageManager): Promise<string | null> {
  const output = await runCapture(manager, ['--version']);
  return parsePackageManagerVersion(output);
}

/**
 * Имена зависимостей проекта — объявленные и dev. По ним видно, чем проект
 * форматируется (`prettier`, `biome`) и чем запускает тесты (`vitest`, `jest`):
 * спрашивать надо проект, а не установленный `node_modules`.
 */
export async function declaredDependencyNames(root: string): Promise<string[]> {
  const manifest = await readManifest(root);
  return manifest.dependencies.map((item) => item.name);
}

/** Сводка окружения для интерфейса: версия Node и менеджер пакетов. */
export async function nodeInfo(root: string | null): Promise<NodeInfo> {
  const manifest = root ? await readManifest(root) : null;
  const manager = root && manifest ? await detectPackageManager(root, manifest) : 'npm';
  const [runtime, managerVersion] = await Promise.all([nodeRuntime(), packageManagerVersion(manager)]);
  return {
    runtime: { version: runtime.version, command: runtime.command, label: nodeVersionLabel(runtime.version) },
    packageManager: { name: manager, version: managerVersion },
  };
}

/**
 * Установленные пакеты: то, что лежит в `node_modules` рядом с проектом.
 *
 * Версию берём из `package.json` каждого пакета. Это много мелких чтений, но
 * `node_modules` — плоский каталог, и список того стоит: без версий «пакет есть»
 * и «пакет тот» не отличить. Вложенные `node_modules` (транзитивные дубликаты)
 * не обходим: интересны пакеты проекта, а не всё дерево.
 */
export async function installedPackages(root: string, manifest?: NodeManifest | null): Promise<NodePackage[]> {
  const resolved = manifest ?? (await readManifest(root));
  const nodeModules = path.join(root, 'node_modules');
  const names = await packagesIn(nodeModules);
  const devNames = new Set(resolved.dependencies.filter((item) => item.dev).map((item) => item.name));

  const limited = names.slice(0, MAX_PACKAGES);
  return Promise.all(
    limited.map(async (name): Promise<NodePackage> => {
      const version = await packageVersion(path.join(nodeModules, name));
      return { name, version: version ?? '', dev: devNames.has(name) };
    }),
  );
}

/**
 * Проверить окружение проекта. Пустой список — всё в порядке.
 *
 * Проверяем только то, что дёшево и не запускает чужой код: наличие и наполнение
 * `node_modules`, установленность объявленных зависимостей, версию Node против
 * `engines.node` и наличие файла блокировки.
 */
export async function checkEnvironment(root: string): Promise<NodeEnvironmentHealth[]> {
  const manifest = await readManifest(root);
  const manager = await detectPackageManager(root, manifest);
  const lockfile = await findLockfile(root);

  const installed = await installedPackages(root, manifest);
  const diff = diffNodeDependencies(manifest.dependencies, installed);

  const nodeModules = path.join(root, 'node_modules');
  const [nodeModulesPresent, runtime] = await Promise.all([isDirectory(nodeModules), nodeRuntime()]);
  const label = path.basename(root) || root;

  const issues = describeNodeEnvIssues({
    label,
    nodeModulesPresent,
    nodeModulesFilled: installed.length > 0,
    dependencyCount: manifest.dependencies.length,
    installedCount: diff.present.length,
    engineRange: manifest.engines,
    nodeVersion: runtime.version,
    lockfile,
    packageManager: manager,
  });

  return issues.length > 0 ? [{ label, issues }] : [];
}

/* ── вспомогательное ────────────────────────────────────────────────────── */

/** Прочитать и разобрать `package.json`. Нет файла — пустой манифест, без ошибки. */
async function readManifest(root: string): Promise<NodeManifest> {
  const text = await fs.readFile(path.join(root, 'package.json'), 'utf8').catch(() => null);
  return text === null ? { dependencies: [], engines: null, packageManager: null } : parseNodeManifest(text);
}

/**
 * Менеджер пакетов проекта: поле `packageManager` (corepack) точнее всего, затем
 * файл блокировки, и лишь в конце — `npm` по умолчанию.
 */
async function detectPackageManager(root: string, manifest: NodeManifest): Promise<NodePackageManager> {
  const field = manifest.packageManager?.split('@')[0];
  if (field === 'npm' || field === 'pnpm' || field === 'yarn' || field === 'bun') return field;

  const byLock = await findLockfile(root);
  const hit = byLock ? LOCKFILES.find(([file]) => file === byLock) : undefined;
  return hit ? hit[1] : 'npm';
}

/** Имя найденного файла блокировки или null. */
async function findLockfile(root: string): Promise<string | null> {
  for (const [file] of LOCKFILES) {
    if (await isFile(path.join(root, file))) return file;
  }
  return null;
}

/** Имена пакетов в `node_modules`: обычные и scoped (`@scope/name`). */
async function packagesIn(nodeModules: string): Promise<string[]> {
  const dirents = await fs.readdir(nodeModules, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];

  for (const entry of dirents) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
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

/** Версия пакета из его `package.json`; null — файла нет или он не читается. */
async function packageVersion(packageDir: string): Promise<string | null> {
  const text = await fs.readFile(path.join(packageDir, 'package.json'), 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as { version?: unknown };
    return typeof value.version === 'string' ? value.version : null;
  } catch {
    return null;
  }
}

/** Запустить команду и вернуть её вывод; ошибки не бросаем — вернём пустую строку. */
function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 4000, windowsHide: true }, (_error, stdout) => resolve(stdout ?? ''));
  });
}

async function isFile(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

async function isDirectory(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
}
