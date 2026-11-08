/**
 * Команда сборки или запуска: `run` (сборка) и `run_tests` смотрят в одно место —
 * в скрипты проекта, объявленные человеком.
 *
 * Агенту нельзя угадывать сборку: `npm run build` у половины проектов есть, у
 * другой половины его нет, а где есть — он может значить не то. Источник один:
 * `scripts` из `package.json` и то, чем этот проект собирается.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { nodeRuntime } from '../node/environment';
import { scanProject } from './scan';

export interface BuildCommand {
  command: string;
  label: string;
}

/** Скрипты, которые человек объявил в `package.json`. */
async function packageScripts(root: string): Promise<Record<string, string>> {
  try {
    const text = await readFile(path.join(root, 'package.json'), 'utf8');
    const parsed = JSON.parse(text) as { scripts?: Record<string, unknown> };
    const scripts = parsed.scripts ?? {};
    const result: Record<string, string> = {};
    for (const [name, body] of Object.entries(scripts)) {
      if (typeof body === 'string' && body.trim().length > 0) result[name] = body.trim();
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Имена скриптов сборки в порядке предпочтения. `check` и `typecheck` тоже
 * сюда: у многих проектов «сборка» — это именно проверка типов.
 */
const BUILD_SCRIPTS = ['build', 'compile', 'check', 'typecheck', 'lint'] as const;

/**
 * Что запускать вместо `run`. `task` — имя скрипта; без него — первый найденный
 * из `BUILD_SCRIPTS`, чтобы агент не угадывал имя, а получил отказ с перечнем.
 */
export async function buildCommand(root: string, task?: string): Promise<BuildCommand | null> {
  const scan = await scanProject(root);
  const scripts = await packageScripts(root);
  const names = Object.keys(scripts);

  const wanted = task?.trim();
  if (wanted) {
    if (scripts[wanted]) return packageManagerRun(root, wanted, new Set(names));
    // Не выдумываем: пусть модель увидит, что есть на самом деле.
    return null;
  }

  const found = BUILD_SCRIPTS.find((name) => scripts[name] !== undefined);
  if (found) return packageManagerRun(root, found, new Set(names));

  // Без `package.json` — сборка языка: типы проверяет тот же tsc, что и
  // редактор, а не плагин сборщика.
  if (scan.kind.id === 'python') return null;
  const node = (await nodeRuntime()).command;
  if (!node) return null;
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    await readFile(tsc, 'utf8');
  } catch {
    return null;
  }
  return { command: `${JSON.stringify(node)} ${JSON.stringify(tsc)} --noEmit`, label: 'tsc --noEmit' };
}

/** Запуск скрипта менеджером проекта, а не напрямую: `run` сам добавит PATH. */
export function packageManagerRun(
  _root: string,
  script: string,
  _known: ReadonlySet<string>,
  manager = 'npm',
): BuildCommand {
  return { command: `${manager} run ${JSON.stringify(script)}`, label: `npm run ${script}` };
}

/** Перечень того, что есть: отказ должен называть варианты, а не молчать. */
export async function buildCandidates(root: string): Promise<string[]> {
  return Object.keys(await packageScripts(root)).sort();
}
