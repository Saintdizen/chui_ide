/**
 * Анализ проекта целиком — то, что редактор может сказать о коде до открытия файлов.
 *
 * Зачем это здесь: пометки обычных источников (языковой сервер, проверка импортов)
 * говорят только про ОТКРЫТЫЕ файлы. На старте открытых файлов нет, поэтому
 * «Проблемы» пусты и счётчики молчат — хотя проект может быть полон ошибок. Этот
 * модуль проходит по корню целиком и возвращает тот же вид пометок, что и все
 * остальные: путь, строка, уровень, сообщение.
 *
 * Две части и обе недешёвые: линтер по всему корню (процесс, секунды) и сверка
 * зависимостей с `node_modules` (много мелких статов). Поэтому вызывать это надо
 * фоном и один раз, а не на каждое сохранение.
 *
 * Время ограничено намеренно: анализ, повисший навсегда, хуже отсутствия анализа.
 * По истечении бюджета отдаём то, что успели, и честную пометку `timedOut`.
 * Убивать чужой процесс нечем (он живёт в своём дереве), поэтому просто отпускаем.
 */
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NodePackageManager } from '../../shared/node-env';
import { installCommand } from '../../shared/node-env';
import {
  limitProblems,
  lintProblems,
  manifestProblem,
  missingDependencyProblems,
  type ProjectAnalysis,
  type ProjectProblem,
} from '../../shared/project-analysis';
import { declaredDependencyNames, installedPackages } from '../node/environment';
import { lintProject } from './lint';

/** Сколько даём анализа целиком: дальше окно и так уже показало бы всё нужное. */
const DEFAULT_BUDGET_MS = 20_000;

export interface AnalyzeOptions {
  /** Потолок времени на линтер; ноль — без ограничения (нужно тестам). */
  budgetMs?: number;
}

/**
 * Проверить проект целиком: линтер по корню плюс нехватка зависимостей.
 *
 * Зависимости и код смотрятся впараллель: это разные процессы, ждать их по
 * очереди значило бы удвоить время старта.
 */
export async function analyzeProject(
  root: string,
  python: string,
  options: AnalyzeOptions = {},
): Promise<ProjectAnalysis> {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const [code, deps] = await Promise.all([codeProblems(root, python, budgetMs), dependencyProblems(root)]);
  const limited = limitProblems([...deps.problems, ...code.problems]);
  const notes = [deps.note, code.note].filter((item): item is string => item !== null);
  if (limited.dropped > 0) {
    notes.push(`Показано ${limited.problems.length} пометок — ещё ${limited.dropped} осталось за потолком`);
  }

  return {
    tool: code.tool,
    problems: limited.problems,
    timedOut: code.timedOut,
    note: notes.length > 0 ? notes.join('. ') : null,
  };
}

/* ── код ────────────────────────────────────────────────────────────────── */

interface CodePart {
  tool: string | null;
  problems: ProjectProblem[];
  timedOut: boolean;
  note: string | null;
}

/** Линтер по всему корню с потолком времени. */
async function codeProblems(root: string, python: string, budgetMs: number): Promise<CodePart> {
  const outcome = await withBudget(lintProject(root, python), budgetMs);
  if (outcome === null) {
    return {
      tool: null,
      problems: [],
      timedOut: true,
      note: `Проверка кода не уложилась в ${Math.round(budgetMs / 1000)} с`,
    };
  }
  if (outcome.tool === null) {
    return { tool: null, problems: [], timedOut: false, note: 'Проверять код нечем: линтера в проекте нет' };
  }
  return { tool: outcome.tool, problems: lintProblems(root, outcome.problems), timedOut: false, note: null };
}

/** Тот же промис, но не дольше `budgetMs`; `null` — не успели. */
async function withBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | null> {
  if (budgetMs <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ── зависимости ───────────────────────────────────────────────────────── */

interface DependencyPart {
  problems: ProjectProblem[];
  note: string | null;
}

/**
 * Объявленные в `package.json`, но отсутствующие в `node_modules`.
 *
 * Пометка ставится на строку манифеста — так клик по проблеме открывает то место,
 * где зависимость объявлена, а рядом видно команду установки. Когда `node_modules`
 * нет вовсе, список из полусотни одинаковых пометок вреден: одна общая честнее.
 */
async function dependencyProblems(root: string): Promise<DependencyPart> {
  const manifestPath = path.join(root, 'package.json');
  const text = await fs.readFile(manifestPath, 'utf8').catch(() => null);
  if (text === null) {
    return { problems: [], note: null };
  }

  const declared = await declaredDependencyNames(root).catch(() => []);
  if (declared.length === 0) return { problems: [], note: null };

  const installed = await installedPackages(root).catch(() => []);
  const command = installCommand(packageManagerOf(root));
  if (installed.length === 0) {
    const message = `Зависимости объявлены (${declared.length}), но node_modules пуст — выполните ${command}`;
    return { problems: [manifestProblem(manifestPath, message, 'error')], note: null };
  }

  const have = new Set(installed.map((item) => item.name));
  const missing = declared.filter((name) => !have.has(name));
  return { problems: missingDependencyProblems(manifestPath, text, missing, command), note: null };
}

/** Менеджер пакетов — по файлу блокировки; запуск версии ради этого не нужен. */
function packageManagerOf(root: string): NodePackageManager {
  const lockfiles: Array<[string, NodePackageManager]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ];
  for (const [file, manager] of lockfiles) {
    if (existsSync(path.join(root, file))) return manager;
  }
  return 'npm';
}
