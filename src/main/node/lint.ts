import path from 'node:path';
import {
  nodeLintOrder,
  nodeLintPackage,
  parseBiomeJson,
  parseEslintJson,
  type LintOutcome,
  type LintProblem,
  type NodeLintTool,
} from '../../shared/lint';
import { resolvePackageBin } from './bin';
import { declaredDependencyNames, nodeRuntime } from './environment';
import { runTool } from '../project/tool-run';

/**
 * Проверка кода линтером Node-проекта: eslint или biome.
 *
 * Инструмент берём из `node_modules` проекта и запускаем тем же Node, которым
 * проект запускается (`nodeRuntime`) — тот же уговор, что и у форматтера
 * (`node/format.ts`). Порядок выбирает `nodeLintOrder`: объявленный в проекте
 * идёт первым.
 *
 * Аргументы у инструментов разные и машиночитаемые у обоих: eslint отдаёт JSON
 * по флагу `-f json`, biome — по `--reporter=json`. Файлы не меняем (`--write`,
 * `--fix` не передаём) — инструмент только читает.
 */

/** Аргументы запуска: путь к цели — файл, папка или проект целиком. */
function argsFor(tool: NodeLintTool, script: string, target: string): string[] {
  return tool === 'eslint' ? [script, target, '-f', 'json'] : [script, 'lint', '--reporter=json', target];
}

export async function lintNode(root: string, target: string, signal?: AbortSignal): Promise<LintOutcome> {
  const node = (await nodeRuntime()).command;
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
  const order = nodeLintOrder(await declaredDependencyNames(root));

  for (const tool of order) {
    const script = await resolvePackageBin(root, nodeLintPackage(tool), tool);
    if (!script) continue;

    const stdout = await runTool(node, argsFor(tool, script, target), { cwd: root, env, signal });
    // Пустой вывод — инструмент не отработал (нет конфига, ошибка запуска).
    // Пробуем следующий, а не выдаём «проблем нет».
    if (stdout.trim() === '') continue;
    const problems = tool === 'eslint' ? parseEslintJson(stdout) : parseBiomeJson(stdout);
    if (problems === null) continue;
    return { tool, problems: problems.map((problem) => withRelativePath(problem, root)) };
  }

  return { tool: null, problems: [] };
}

/**
 * eslint называет файлы абсолютными путями, ruff и biome — как передали. Приводим
 * к относительному, чтобы отчёт линтера был единообразен с остальными ответами.
 */
function withRelativePath(problem: LintProblem, root: string): LintProblem {
  if (!path.isAbsolute(problem.path)) return problem;
  return { ...problem, path: path.relative(root, problem.path) };
}
