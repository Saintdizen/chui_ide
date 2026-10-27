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
 * По истечении бюджета отдаём то, что успели, и честную пометку `timedOut` — но
 * перед этим **убиваем** линтер (`AbortController`). Раньше его просто отпускали:
 * процесс продолжал жить, держал корень проекта рабочим каталогом и мешал убрать
 * временную папку (на Windows — `EBUSY` при уборке, тест падал уборкой, а не
 * разбором).
 */
import { existsSync, readdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NodePackageManager } from '../../shared/node-env';
import { installCommand } from '../../shared/node-env';
import { diffRequirements, parseRequirements } from '../../shared/python-packages';
import type { ProjectStage, ProjectStageEvent } from '../../shared/project-analysis';
import {
  limitProblems,
  lintProblems,
  manifestProblem,
  missingDependencyProblems,
  type ProjectAnalysis,
  type ProjectProblem,
} from '../../shared/project-analysis';
import { declaredDependencyNames } from '../node/environment';
import { installedPackages as installedPythonPackages } from '../python/pip';
import { lintProject } from './lint';

/** Сколько даём анализа целиком: дальше окно и так уже показало бы всё нужное. */
const DEFAULT_BUDGET_MS = 20_000;

export interface AnalyzeOptions {
  /** Потолок времени на линтер; ноль — без ограничения (нужно тестам). */
  budgetMs?: number;
  /**
   * Ход проверки по шагам: по этим событиям строка состояния рисует полосу.
   * Внутри шага чисел нет — линтер один процесс и о середине ничего не говорит,
   * поэтому врём только тем, что показываем: сколько шагов из скольких.
   */
  onStage?: (event: ProjectStageEvent) => void;
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
  /** Отметить шаг начатым и законченным: больше о ходе проверки мы не знаем. */
  const step = <T>(stage: ProjectStage, work: Promise<T>): Promise<T> => {
    options.onStage?.({ stage, phase: 'start' });
    return work.finally(() => options.onStage?.({ stage, phase: 'done' }));
  };
  const [code, deps, pyDeps] = await Promise.all([
    step('code', codeProblems(root, python, budgetMs)),
    step('deps', dependencyProblems(root)),
    step('python-deps', pythonDependencyProblems(root, python)),
  ]);
  const limited = limitProblems([...pyDeps, ...deps.problems, ...code.problems]);
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
  // Не успели — линтер не отпускаем, а завершаем: иначе он живёт дальше и держит
  // корень проекта (см. `project/tool-run.ts`).
  const abort = new AbortController();
  const outcome = await withBudget(lintProject(root, python, undefined, abort.signal), budgetMs, () => abort.abort());
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

/** Тот же промис, но не дольше `budgetMs`; `null` — не успели (и зовём `expire`). */
async function withBudget<T>(work: Promise<T>, budgetMs: number, expire?: () => void): Promise<T | null> {
  if (budgetMs <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      expire?.();
      resolve(null);
    }, budgetMs);
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
  const command = installCommand(packageManagerOf(root));

  // Пустой `node_modules` — это не «нет одной зависимости», а «не устанавливали»:
  // полсотни одинаковых пометок хуже одной честной.
  const nodeModules = path.join(root, 'node_modules');
  const hasTree = existsSync(nodeModules) && readdirSync(nodeModules).length > 0;
  if (!hasTree) {
    const message = `Зависимости объявлены (${declared.length}), но node_modules пуст — выполните ${command}`;
    return { problems: [manifestProblem(manifestPath, message, 'error')], note: null };
  }

  // Сверяем каждый объявленный пакет напрямую, а не через `installedPackages`: там
  // внутри потолок на число пакетов и чтение версии каждого — на большом дереве
  // объявленная зависимость может не попасть в срез и стать «не установленной».
  const missing: string[] = [];
  for (const name of declared) {
    if (!existsSync(path.join(nodeModules, name, 'package.json'))) missing.push(name);
  }
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

/**
 * Python-зависимости: `requirements.txt` против `pip list`.
 *
 * `pip list` — процесс на доли секунды, поэтому идём только когда сверять есть
 * что: файл есть и в нём есть требования. Молчание pip (нет интерпретатора, чужое
 * окружение) не превращаем в пометки: это про окружение, а не про код, и об этом
 * уже говорит попап окружения — здесь достаточно не мешать.
 *
 * `pyproject.toml` не разбираем: там произвольный TOML с группами и extras, и
 * честнее промолчать, чем угадать состав зависимостей.
 */
async function pythonDependencyProblems(root: string, python: string): Promise<ProjectProblem[]> {
  const manifestPath = path.join(root, 'requirements.txt');
  const text = await fs.readFile(manifestPath, 'utf8').catch(() => null);
  if (text === null) return [];

  const requirements = parseRequirements(text);
  if (requirements.length === 0) return [];

  const installed = await installedPythonPackages(python, root).catch(() => null);
  if (installed === null) return [];

  return diffRequirements(requirements, installed).missing.map((item) => ({
    path: manifestPath,
    line: item.line,
    column: 1,
    severity: 'error' as const,
    message: `Пакет ${item.name}${item.specifier} не установлен — pip install '${item.name}${item.specifier}'`,
    source: 'deps',
    code: 'pip-missing',
  }));
}
