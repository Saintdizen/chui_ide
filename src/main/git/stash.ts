import { RpcErrorCode, type GitStatus } from '../../shared/api';
import { parseStashList, type GitStashEntry } from '../../shared/git-stash';
import { RpcFailure } from '../ipc/router';
import type { RepositoryContext, StatusContext } from './contexts';
import { execGit } from './exec';

export interface StashContext extends RepositoryContext, StatusContext {}

/** Список записей; вне репозитория — пустой, а не ошибка: панель просто пуста. */
export async function stashList(ctx: StashContext): Promise<GitStashEntry[]> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) return [];
  const result = await execGit(['stash', 'list', '--format=%gd%x1f%gs'], repoRoot, { allowFailure: true });
  return parseStashList(result.stdout);
}

/**
 * Отложить текущие правки. `git stash push` без изменений ничего не делает
 * и завершается успешно — это не сбой, а пустой результат.
 */
export async function stashSave(
  ctx: StashContext,
  options: { message?: string; includeUntracked?: boolean } = {},
): Promise<GitStatus> {
  const repoRoot = await requireRoot(ctx);
  const args = ['stash', 'push'];
  if (options.includeUntracked) args.push('--include-untracked');
  const message = options.message?.trim();
  if (message) args.push('-m', message);
  await execGit(args, repoRoot);
  return ctx.refresh();
}

/** Применить запись, оставив её в списке. */
export function stashApply(ctx: StashContext, index: number): Promise<GitStatus> {
  return stashOp(ctx, 'apply', index);
}

/** Применить запись и убрать из списка. */
export function stashPop(ctx: StashContext, index: number): Promise<GitStatus> {
  return stashOp(ctx, 'pop', index);
}

/** Удалить запись, не трогая рабочее дерево. */
export function stashDrop(ctx: StashContext, index: number): Promise<GitStatus> {
  return stashOp(ctx, 'drop', index);
}

/** Полный патч записи — содержимое для просмотра. */
export async function stashShow(ctx: StashContext, index: number): Promise<string> {
  const { repoRoot, ref } = await locateStash(ctx, index);
  const result = await execGit(['stash', 'show', '-p', '--no-color', '--no-ext-diff', ref], repoRoot, {
    allowFailure: true,
  });
  // Пусто — в записи нет правок отслеживаемых файлов (бывают только новые):
  // скажем это словами, а не пустым экраном.
  return result.stdout.trim() ? result.stdout : 'В этой записи нет правок отслеживаемых файлов.';
}

async function stashOp(ctx: StashContext, op: 'apply' | 'pop' | 'drop', index: number): Promise<GitStatus> {
  const { repoRoot, ref } = await locateStash(ctx, index);
  await execGit(['stash', op, ref], repoRoot);
  return ctx.refresh();
}

/** Проверить номер записи и получить её ссылку. */
async function locateStash(ctx: StashContext, index: number): Promise<{ repoRoot: string; ref: string }> {
  const repoRoot = await requireRoot(ctx);
  if (!Number.isInteger(index) || index < 0) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, 'Номер записи stash — целое число, начиная с нуля');
  }
  return { repoRoot, ref: `stash@{${index}}` };
}

async function requireRoot(ctx: StashContext): Promise<string> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');
  return repoRoot;
}
