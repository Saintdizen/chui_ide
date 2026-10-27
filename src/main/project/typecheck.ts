/**
 * Проверка типов проекта целиком: `tsc --noEmit`.
 *
 * Отдельным проходом, а не вместе с анализом на старте: на этом же репозитории
 * tsc идёт десятками секунд и держит пол-ядра, а линтер — доли секунды. Поэтому
 * типы запускаются командой «Проверить типы», а не при открытии проекта.
 *
 * Ограничения честные: нет `tsconfig.json` — проверять нечего; нет `typescript`
 * в `node_modules` — говорим об этом, а не молчим пустым списком. Бюджет времени
 * нужен потому, что повисший tsc оставил бы «проверяю…» навсегда.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { type ProjectAnalysis, tscProblems } from '../../shared/project-analysis';
import { resolvePackageBin } from '../node/bin';
import { nodeRuntime } from '../node/environment';

/** Потолок: tsc на большом проекте идёт долго, но не бесконечно. */
const DEFAULT_BUDGET_MS = 120_000;

export interface TypecheckOptions {
  /** Потолок времени; ноль — без ограничения (нужно тестам). */
  budgetMs?: number;
}

export async function typecheckProject(root: string, options: TypecheckOptions = {}): Promise<ProjectAnalysis> {
  const hasConfig = await fs
    .stat(path.join(root, 'tsconfig.json'))
    .then((stat) => stat.isFile())
    .catch(() => false);
  if (!hasConfig) {
    return { tool: null, problems: [], timedOut: false, note: 'Проверять типы нечем: в проекте нет tsconfig.json' };
  }

  const node = (await nodeRuntime()).command;
  const script = await resolvePackageBin(root, 'typescript', 'tsc');
  if (!script) {
    return { tool: null, problems: [], timedOut: false, note: 'Проверять типы нечем: typescript не установлен' };
  }

  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const result = await runTsc(node, [script, '--noEmit', '--pretty', 'false'], root, budgetMs);
  const problems = tscProblems(root, result.output);
  if (result.timedOut) {
    return {
      tool: 'tsc',
      problems,
      timedOut: true,
      note: `Проверка типов не уложилась в ${Math.round(budgetMs / 1000)} с — список может быть неполным`,
    };
  }
  if (problems.length === 0 && result.failed) {
    // Ненулевой код без разобранных строк: tsc сказал что-то не по форме.
    return { tool: null, problems: [], timedOut: false, note: result.tail || 'Проверка типов не удалась' };
  }
  return { tool: 'tsc', problems, timedOut: false, note: null };
}

interface TscRun {
  /** stdout и stderr вместе: часть ошибок tsc печатает в поток ошибок. */
  output: string;
  timedOut: boolean;
  /** Ненулевой код возврата — ошибки есть или запуск не удался. */
  failed: boolean;
  /** Первая строка вывода — для объяснения, когда разобрать нечего. */
  tail: string;
}

function runTsc(command: string, args: string[], cwd: string, budgetMs: number): Promise<TscRun> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    let output = '';
    let settled = false;
    let timedOut = false;
    const collect = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer =
      budgetMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, budgetMs)
        : null;

    const finish = (run: Omit<TscRun, 'output'>): void => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ output, ...run });
    };

    child.on('error', (error) => finish({ timedOut, failed: true, tail: error.message }));
    child.on('close', (code) => {
      const firstLine = output.split('\n').find((line) => line.trim() !== '') ?? '';
      finish({ timedOut, failed: code !== 0, tail: firstLine.trim() });
    });
  });
}
