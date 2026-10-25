import { promises as fs } from 'node:fs';
import { RpcErrorCode, type GitStatus } from '../../shared/api';
import { parseBisectState, type GitBisectState } from '../../shared/git-bisect';
import { RpcFailure } from '../ipc/router';
import { execGit } from './exec';

/**
 * Что нужно пошаговому поиску от `GitService`: три готовых ответа. Состоянием класса
 * он не пользуется — только этими колбэками, отсюда и вынесен.
 */
export interface BisectContext {
  /** Рабочая папка проекта; поиск идёт в ней, а не в корне репозитория. */
  root(): string;
  refresh(): Promise<GitStatus>;
  gitPath(repoRoot: string, name: string): Promise<string | null>;
}

/** Имя коммита может начинаться с `-` — тогда git примет его за флаг, а не за ссылку. */
function commitArg(commit: string): string {
  const value = commit.trim();
  if (!value) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Не задан коммит');
  if (value.startsWith('-'))
    throw new RpcFailure(RpcErrorCode.InvalidParams, `Некорректная ссылка на коммит: ${value}`);
  return value;
}

function requireRoot(ctx: BisectContext): string {
  const root = ctx.root();
  if (!root) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Проект не открыт');
  return root;
}

/**
 * Состояние поиска: идёт ли он, на каком коммите стоит рабочее дерево и сколько
 * осталось. Идёт ли — узнаём по файлу `BISECT_START` в каталоге git, а остаток и
 * итог — по тексту, который git пишет в файлы bisect.
 */
export async function bisectState(ctx: BisectContext): Promise<GitBisectState> {
  return readBisectState(ctx, requireRoot(ctx), '');
}

/** Начать поиск: `bad` — известный плохой коммит, `good` — известный хороший. */
export async function bisectStart(
  ctx: BisectContext,
  options: { bad?: string; good?: string } = {},
): Promise<GitBisectState> {
  const repoRoot = requireRoot(ctx);
  const args = ['bisect', 'start'];
  if (options.bad) args.push(commitArg(options.bad));
  if (options.good) args.push(commitArg(options.good));
  // Берём ОБА потока: git может сказать во stderr (предупреждение), а итог —
  // в stdout. Выбор «stderr || stdout» терял бы сообщение с виновником.
  const result = await execGit(args, repoRoot, { allowFailure: true });
  return readBisectState(ctx, repoRoot, `${result.stdout}\n${result.stderr}`);
}

/** Пометить текущий проверяемый коммит хорошим, плохим или пропустить его. */
export async function bisectMark(ctx: BisectContext, mark: 'good' | 'bad' | 'skip'): Promise<GitBisectState> {
  const repoRoot = requireRoot(ctx);
  const result = await execGit(['bisect', mark], repoRoot, { allowFailure: true });
  return readBisectState(ctx, repoRoot, `${result.stdout}\n${result.stderr}`);
}

/** Закончить поиск: ветка возвращается туда, где была до него. */
export async function bisectReset(ctx: BisectContext): Promise<GitStatus> {
  const repoRoot = requireRoot(ctx);
  await execGit(['bisect', 'reset'], repoRoot);
  return ctx.refresh();
}

/** Состояние по файлам bisect плюс свежий вывод команды (журнал шагов + ответ git). */
async function readBisectState(ctx: BisectContext, repoRoot: string, output: string): Promise<GitBisectState> {
  const startFile = await ctx.gitPath(repoRoot, 'BISECT_START');
  const started = startFile ? (await fs.stat(startFile).catch(() => null))?.isFile() === true : false;

  // Журнал идёт в том же формате, что печатает git: разбираем и его, и свежий вывод.
  const logFile = await ctx.gitPath(repoRoot, 'BISECT_LOG');
  const log = logFile ? await fs.readFile(logFile, 'utf8').catch(() => '') : '';
  const parsed = parseBisectState(`${log}\n${output}`, started);

  let current: { hash: string; summary: string } | null = null;
  if (started) {
    const head = await execGit(['log', '-1', '--format=%h%x00%s'], repoRoot, { allowFailure: true });
    const [hash, summary] = head.stdout.trim().split('\u0000');
    if (hash) current = { hash, summary: summary ?? '' };
  }

  const message = (output.trim() || (parsed.active ? 'Поиск идёт' : 'Поиск завершён')).trim();
  return { ...parsed, current, message };
}
