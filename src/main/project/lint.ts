import { promises as fs } from 'node:fs';
import path from 'node:path';
import { languageFromPath } from '../../shared/languages';
import { lintEngine, type LintOutcome } from '../../shared/lint';
import { lintNode } from '../node/lint';
import { lintPython } from '../python/lint';

/**
 * Проверка кода линтером проекта: выбрать движок по цели и позвать нужный сервис.
 *
 * Движок выбирается по расширению цели, а если цель не названа файлом — по
 * манифесту в корне: у Python это `pyproject.toml`/`requirements.txt`/`setup.py`,
 * у Node — `package.json`. Так «проверь проект» в смешанном репозитории уходит
 * тому языку, который в нём главный.
 *
 * Отдельным модулем, а не внутри `agent-tools.ts`: инструмент агента только
 * форматирует ответ, а выбор движка и запуск — здесь, рядом с другими вещами
 * проекта (`project/scan.ts`).
 */

/** Манифесты, по которым узнаём вид проекта, когда цель — не файл. */
const PYTHON_MANIFESTS: readonly string[] = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'];
const NODE_MANIFESTS: readonly string[] = ['package.json'];

export async function lintProject(
  root: string,
  python: string,
  target?: string,
  signal?: AbortSignal,
): Promise<LintOutcome> {
  const engine = await pickEngine(root, target);
  // Линтер запускаем с cwd = корень проекта: пути к цели — от него же.
  const relative = target ? path.relative(root, target) || '.' : '.';
  if (engine === 'python') return lintPython(root, python, relative, signal);
  if (engine === 'node') return lintNode(root, relative, signal);
  return { tool: null, problems: [] };
}

/** Чем проверять: по расширению цели, иначе по манифесту в корне; null — нечем. */
async function pickEngine(root: string, target?: string): Promise<'python' | 'node' | null> {
  if (target) {
    const byLanguage = lintEngine(languageFromPath(target));
    if (byLanguage) return byLanguage;
  }
  if (await anyExists(root, PYTHON_MANIFESTS)) return 'python';
  if (await anyExists(root, NODE_MANIFESTS)) return 'node';
  return null;
}

/** Есть ли в корне хотя бы один из файлов. */
async function anyExists(root: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    const found = await fs
      .stat(path.join(root, name))
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (found) return true;
  }
  return false;
}
