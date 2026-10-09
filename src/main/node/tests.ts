import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import {
  detectNodeTestRunner,
  nodeTestFilesSuite,
  nodeTestRunnerFrom,
  parseJestList,
  parseVitestList,
  type NodeTestSuite,
} from '../../shared/node-tests';
import { scanProject } from '../project/scan';
import { projectEnv } from '../project-env';
import { resolvePackageBin } from './bin';
import { declaredDependencyNames, nodeRuntime } from './environment';

/**
 * Сбор тестов Node-проекта: список тестов у vitest, список файлов у jest и
 * `node --test`.
 *
 * Собираем отдельно, а запускаем в терминале (см. `run-config` в renderer): сбор
 * дешёвый и, что важно, тесты при нём не выполняются — `vitest list` и
 * `jest --listTests` именно этим и хороши.
 *
 * Ошибка сбора — это ответ, а не падение метода: раннер мог быть объявлен, но не
 * установлен, а тесты — не собираться из-за битого импорта. Тогда в сводке будут
 * ошибки и пустой список, и панель скажет об этом человеку.
 */

/** Потолок вывода раннера: список тестов большого проекта бывает длинным. */
const MAX_BUFFER = 32 * 1024 * 1024;
const TIMEOUT = 120_000;

export async function collectNodeTests(root: string): Promise<NodeTestSuite> {
  const [dependencies, scan] = await Promise.all([declaredDependencyNames(root), scanProject(root)]);
  const runner = detectNodeTestRunner(nodeTestRunnerFrom(dependencies), scan.testFiles);
  if (!runner) return { runner: null, tests: [], total: 0, errors: [] };

  // `node --test` списка не умеет: у него тесты и есть файлы из карты проекта.
  if (runner === 'node') return { runner, ...nodeTestFilesSuite(scan.testFiles) };

  const script = await resolvePackageBin(root, runner, runner);
  if (!script) {
    return {
      runner,
      tests: [],
      total: 0,
      errors: [`${runner} объявлен в package.json, но не установлен — нужен ${runner} install`],
    };
  }

  const args = runner === 'vitest' ? ['list', '--json'] : ['--listTests', '--json'];
  const output = await runScript(root, script, args);
  const names = await rootNames(root);
  const suite = runner === 'vitest' ? parseVitestList(output, names) : parseJestList(output, names);
  return { runner, ...suite };
}

/**
 * Написания корня: исходное и настоящее.
 *
 * Раннер печатает пути от `process.cwd()` своего процесса, а тот называет каталог
 * по-своему: на macOS симлинк раскрыт (`/var` → `/private/var`), а на Windows взято
 * короткое имя (`RUNNER~1`), и оно же остаётся исходным. Какое написание попадёт в
 * вывод, заранее неизвестно, поэтому примеряем оба — иначе путь вышел бы
 * абсолютным вместо относительного.
 */
async function rootNames(root: string): Promise<string[]> {
  try {
    const real = await realpath(root);
    return real && real !== root ? [root, real] : [root];
  } catch {
    return [root];
  }
}

/**
 * Запустить скрипт раннера тем же Node, что и проект, и вернуть его вывод.
 *
 * Ошибку запуска не бросаем: её разберёт тот, кто читает вывод, — пустым списком
 * и понятной строкой в `errors`.
 */
async function runScript(root: string, script: string, args: string[]): Promise<string> {
  const node = (await nodeRuntime()).command;
  const env: NodeJS.ProcessEnv = { ...process.env, ...(await projectEnv(root)), NO_COLOR: '1' };

  return new Promise((resolve) => {
    execFile(
      node,
      [script, ...args],
      { cwd: root, env, timeout: TIMEOUT, maxBuffer: MAX_BUFFER, windowsHide: true },
      (_error, stdout) => resolve(extractJson(stdout ?? '')),
    );
  });
}

/**
 * Вырезать JSON из вывода: список тестов — это массив, а перед ним раннер может
 * напечатать предупреждения и строку прогресса. Ищем по границам массива, а не
 * по строкам: сам JSON может занимать один длинный ряд.
 */
function extractJson(text: string): string {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}
