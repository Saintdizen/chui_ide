import { RpcErrorCode, type GitStatus } from '../../shared/api';
import { type GitSubmodule, parseSubmodules } from '../../shared/git-submodules';
import { RpcFailure } from '../ipc/router';
import type { RepositoryContext, StatusContext } from './contexts';
import { execGit, NETWORK_TIMEOUT_MS } from './exec';

export interface SubmoduleContext extends RepositoryContext, StatusContext {}

/** Какие папки — чужие репозитории и в каком они состоянии. */
export async function listSubmodules(ctx: SubmoduleContext): Promise<GitSubmodule[]> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) return [];
  const result = await execGit(['submodule', 'status'], repoRoot, { allowFailure: true });
  return result.ok ? parseSubmodules(result.stdout) : [];
}

/**
 * Забрать код подмодулей: `git submodule update --init --recursive`.
 *
 * Сетевой таймаут: первый `--init` тянет чужие репозитории целиком, а
 * вложенные подмодули — рекурсивно.
 */
export async function updateSubmodules(ctx: SubmoduleContext): Promise<GitStatus> {
  const repoRoot = await requireRoot(ctx);
  await execGit(['submodule', 'update', '--init', '--recursive'], repoRoot, { timeout: NETWORK_TIMEOUT_MS });
  return ctx.refresh();
}

async function requireRoot(ctx: SubmoduleContext): Promise<string> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');
  return repoRoot;
}
