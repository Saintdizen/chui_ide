import path from 'node:path';
import { RpcErrorCode } from '../../shared/api';
import { parseWorktrees, type GitWorktree } from '../../shared/git-worktrees';
import { RpcFailure } from '../ipc/router';
import { nameArg } from './args';
import type { RepositoryContext } from './contexts';
import { execGit, NETWORK_TIMEOUT_MS } from './exec';

export interface WorktreeContext extends RepositoryContext {}

export async function listWorktrees(ctx: WorktreeContext): Promise<GitWorktree[]> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) return [];
  const result = await execGit(['worktree', 'list', '--porcelain'], repoRoot, { allowFailure: true });
  // git отдаёт пути со слэшами ВСЕГДА, даже на Windows. Приводим к разделителям
  // платформы: иначе путь не совпадёт с тем, что дают fs и остальное приложение.
  return result.ok ? parseWorktrees(result.stdout).map((item) => ({ ...item, path: path.normalize(item.path) })) : [];
}

export async function addWorktree(
  ctx: WorktreeContext,
  target: string,
  options: { branch?: string; newBranch?: string } = {},
): Promise<GitWorktree[]> {
  const repoRoot = await requireRoot(ctx);
  const directory = target.trim();
  if (!directory) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Не задан путь рабочего каталога');
  const args = ['worktree', 'add'];
  if (options.newBranch) args.push('-b', nameArg(options.newBranch));
  args.push(directory);
  if (options.branch) args.push(nameArg(options.branch));
  await execGit(args, repoRoot, { timeout: NETWORK_TIMEOUT_MS });
  return listWorktrees(ctx);
}

export async function removeWorktree(ctx: WorktreeContext, target: string, force: boolean): Promise<GitWorktree[]> {
  const repoRoot = await requireRoot(ctx);
  // Путь начинается с дефиса? Тогда за него примет git — подстрахуемся `--`.
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push('--', target);
  await execGit(args, repoRoot);
  return listWorktrees(ctx);
}

/** Убрать записи о каталогах, которых уже нет на диске. */
export async function pruneWorktrees(ctx: WorktreeContext): Promise<GitWorktree[]> {
  const repoRoot = await requireRoot(ctx);
  await execGit(['worktree', 'prune'], repoRoot);
  return listWorktrees(ctx);
}

async function requireRoot(ctx: WorktreeContext): Promise<string> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');
  return repoRoot;
}
