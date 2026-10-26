import { RpcErrorCode, type GitNetworkResult, type GitStatus } from '../../shared/api';
import { RpcFailure } from '../ipc/router';
import { execGit, NETWORK_TIMEOUT_MS } from './exec';

/**
 * Сеть в гит-сервисе: fetch/pull/push — единственное место, где запрос может
 * висеть долго, и единственное, после которого состояние меняется у нас «сзади».
 *
 * Своя зависимость, а не класс: нужен корень репозитория и пересчёт статуса.
 */
export interface NetworkContext {
  repositoryRoot(explicit?: string): Promise<string | null>;
  refresh(): Promise<GitStatus>;
}

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
