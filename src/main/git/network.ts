import { RpcErrorCode, type GitNetworkResult } from '../../shared/api';
import { RpcFailure } from '../ipc/router';
import type { RepositoryContext, StatusContext } from './contexts';
import { execGit, NETWORK_TIMEOUT_MS } from './exec';

export interface NetworkContext extends RepositoryContext, StatusContext {}

/**
 * Выполнить сетевую команду и вернуть её словами вместе с новым статусом.
 *
 * `allowFailure` здесь осознанно: «нечего пушить» или «отвергнуто хостом» —
 * обычные ответы, их показываем в интерфейсе, а не превращаем в исключение.
 * Таймаут сетевой: у `push` в чужой репозиторий ответ приходит не за секунды.
 */
export async function runNetwork(ctx: NetworkContext, args: string[]): Promise<GitNetworkResult> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

  const result = await execGit(args, repoRoot, { allowFailure: true, timeout: NETWORK_TIMEOUT_MS });
  // У push/fetch итог идёт в stderr, у pull — в stdout: берём то, что непусто.
  const text = (result.stderr.trim() || result.stdout.trim()).trim();
  const message = text || `git ${args[0]}: выполнено`;
  const status = await ctx.refresh();
  return { ok: result.ok, message, status };
}
