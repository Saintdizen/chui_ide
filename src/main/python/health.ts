import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parsePyvenvCfg } from '../../shared/python-env';
import { describeEnvIssues, type EnvIssue, type EnvironmentHealth } from '../../shared/python-health';
import { findEnvironments } from './environments';

/**
 * Проверка окружений проекта на поломки.
 *
 * Факты собираем здесь (файловая система — в main), решения принимает
 * `shared/python-health`. Проверяем только то, что дёшево и не запускает чужой
 * код: читаем `pyvenv.cfg`, смотрим, на месте ли базовый интерпретатор, и есть
 * ли в окружении pip. Этого хватает для самых частых молчаливых поломок.
 *
 * Языковые серверы запускаем только для того, чтобы узнать про исключение —
 * профиль окружения ради этого поднимать не стоит (см. ограничения в shared-модуле).
 */

/** Проверить каждое найденное окружение проекта. Пустой список — всё в порядке. */
export async function checkEnvironments(root: string, platform: string): Promise<EnvironmentHealth[]> {
  const environments = await findEnvironments(root, platform);
  const results: EnvironmentHealth[] = [];

  for (const environment of environments) {
    const issues = await issuesFor(environment.path, environment.relative, platform);
    if (issues.length > 0) results.push({ label: environment.relative, issues });
  }

  return results;
}

/** Факты об окружении и решение по ним. */
async function issuesFor(venvDir: string, label: string, platform: string): Promise<EnvIssue[]> {
  const cfgPath = path.join(venvDir, 'pyvenv.cfg');
  const text = await fs.readFile(cfgPath, 'utf8').catch(() => null);
  const hasPip = await findPip(venvDir, platform);

  if (text === null) {
    return describeEnvIssues({ label, cfgRead: false, basePath: null, baseExists: null, hasPip });
  }

  const { base } = parsePyvenvCfg(text);
  return describeEnvIssues({
    label,
    cfgRead: true,
    basePath: base,
    baseExists: base ? await pathExists(base) : null,
    hasPip,
  });
}

/**
 * Есть ли в окружении pip.
 *
 * Смотрим и бинарник (`bin/pip`), и каталог пакета: сборки разные — где-то
 * pip ставят только как модуль. Нет ни того ни другого — `python -m pip` тоже
 * не заработает, поэтому предупреждение честное.
 */
async function findPip(venvDir: string, platform: string): Promise<boolean> {
  const binary = platform === 'win32' ? path.join(venvDir, 'Scripts', 'pip.exe') : path.join(venvDir, 'bin', 'pip');
  if (await pathExists(binary)) return true;

  // Каталог пакета: имя версии питона заранее не знаем — смотрим, что есть в lib.
  const lib = path.join(venvDir, 'lib');
  const dirs = await fs.readdir(lib, { withFileTypes: true }).catch(() => []);
  for (const entry of dirs) {
    if (!entry.isDirectory() || !entry.name.startsWith('python')) continue;
    if (await pathExists(path.join(lib, entry.name, 'site-packages', 'pip'))) return true;
  }

  // Windows раскладывает пакеты в Lib, а не lib.
  return pathExists(path.join(venvDir, 'Lib', 'site-packages', 'pip'));
}

/** Путь существует (каталог или файл) — для `home` и `base-executable` этого довольно. */
async function pathExists(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false);
}
