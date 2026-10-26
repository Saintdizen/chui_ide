import { RpcErrorCode } from '../../shared/api';
import type { GitNetworkResult, GitRemote } from '../../shared/api';
import { pullModeArgs, type PullMode } from '../../shared/git-pull';
import { RpcFailure } from '../ipc/router';
import type { NetContext } from './contexts';
import { execGit } from './exec';
import { runNetwork } from './network';

/**
 * Сеть и адреса удалённых репозиториев.
 *
 * Три вещи, которые кажутся соседями только здесь: `remotes` — чтение списка,
 * `fetch`/`pull`/`push` — сетевая операция с новым статусом, а `push` ещё и
 * сам решает, нужен ли `-u`. Общее у них одно — `runNetwork`, который знает
 * про таймаут и про то, что ответ git идёт в stderr.
 */

/** Удалённые репозитории. Нет репозитория — пустой список: показать нечего, а не сбой. */
export async function remotes(ctx: NetContext): Promise<GitRemote[]> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) return [];

  const result = await execGit(['remote', '-v'], repoRoot, { allowFailure: true });
  const byName = new Map<string, GitRemote>();
  for (const line of result.stdout.split('\n')) {
    // Формат: `origin\thttps://… (fetch)`. Пробелы в адресе недопустимы, поэтому хвост режем по нему.
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const name = match[1]!;
    const url = match[2]!;
    const known = byName.get(name) ?? { name, fetchUrl: '', pushUrl: '' };
    if (match[3] === 'fetch') known.fetchUrl = url;
    else known.pushUrl = url;
    byName.set(name, known);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Забрать изменения из удалённого репозитория, не трогая рабочее дерево. */
export async function fetch(ctx: NetContext): Promise<GitNetworkResult> {
  return runNetwork(ctx, ['fetch', '--all', '--prune']);
}

/**
 * Влить изменения из удалённого репозитория в текущую ветку. `mode` задаёт флаги:
 * слияние, перебазирование или только перемотка; `default` не подсказывает ничего —
 * git ведёт себя так, как настроен у человека.
 */
export async function pull(ctx: NetContext, mode: PullMode = 'default'): Promise<GitNetworkResult> {
  return runNetwork(ctx, ['pull', '--no-edit', ...pullModeArgs(mode)]);
}

/**
 * Отправить текущую ветку. Одна команда вместо цепочки «статус → проверка
 * upstream → push»: каждый запуск процесса стоит времени, а git отдаёт нужное сам.
 *
 * Отдельно про detached HEAD: `%(refname:short)` для него пуст, а не «HEAD» —
 * пустое имя git отвергнет сам, и это честнее нашего прежнего отказа. Ветку
 * берём из `symbolic-ref`: он отвечает «не ветка» кодом, а не пустой строкой,
 * которую нельзя отличить от ошибки запуска.
 */
export async function push(
  ctx: NetContext,
  options: { setUpstream?: boolean; force?: boolean } = {},
): Promise<GitNetworkResult> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

  const head = await execGit(['symbolic-ref', '--short', '-q', 'HEAD'], repoRoot, { allowFailure: true });
  if (!head.ok || !head.stdout.trim()) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, 'HEAD оторван (detached): нечего отправлять');
  }
  const branch = head.stdout.trim();
  const probe = await execGit(['config', '--get', `branch.${branch}.remote`], repoRoot, { allowFailure: true });
  const args = ['push'];
  if (options.force) args.push('--force-with-lease');
  if (options.setUpstream || !probe.stdout.trim()) args.push('-u', 'origin', branch);
  return runNetwork(ctx, args);
}
