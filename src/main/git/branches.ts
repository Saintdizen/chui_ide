import { RpcErrorCode } from '../../shared/api';
import type { GitBranch, GitStatus } from '../../shared/api';
import { RpcFailure } from '../ipc/router';
import { nameArg } from './args';
import type { BranchContext } from './contexts';
import { execGit } from './exec';

/**
 * Ветки: локальные и удалённые, переключение, создание, переименование,
 * удаление.
 *
 * Только чтение списка терпит пустоту: нет репозитория — пустой список, а не
 * ошибка. Всё, что меняет ветку, требует корень и заканчивается `refresh`:
 * `checkout` меняет рабочие файлы целиком, и без рассылки `GitChanged`
 * интерфейс остался бы со старым деревом.
 */

/** Локальные и удалённые ветки одним списком: текущая — первой, затем локальные, затем удалённые. */
export async function branches(ctx: BranchContext): Promise<GitBranch[]> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) return [];

  // `%09` — табуляция: имена веток с пробелами и кириллицей не ломают разбор.
  const [local, remote] = await Promise.all([
    execGit(['branch', '--list', '--format=%(refname:short)%09%(HEAD)'], repoRoot),
    execGit(['branch', '--remotes', '--format=%(refname:short)'], repoRoot),
  ]);

  const parsed: GitBranch[] = [];
  for (const line of local.stdout.split('\n')) {
    const [name, head] = line.split('\t');
    if (name) parsed.push({ name, current: head?.trim() === '*', remote: false });
  }
  for (const line of remote.stdout.split('\n')) {
    const name = line.trim();
    // `origin/HEAD` — символьная ссылка на ветку по умолчанию, в списке она лишняя.
    if (!name || name.endsWith('/HEAD')) continue;
    parsed.push({ name, current: false, remote: true });
  }

  return parsed.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.remote !== b.remote) return a.remote ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

/** Переключить ветку. `create` — заодно создать её от текущего места. */
export async function checkout(ctx: BranchContext, name: string, create = false): Promise<GitStatus> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

  const branch = name.trim();
  if (!branch) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Пустое имя ветки');
  await execGit(create ? ['checkout', '-b', branch] : ['checkout', branch], repoRoot);
  return ctx.refresh();
}

/**
 * Удалить ветку. `force` — когда git отказывается: ветка не влита, а человек
 * всё равно настаивает (это его выбор, но предупредить должно быть в UI).
 */
export async function deleteBranch(ctx: BranchContext, name: string, force = false): Promise<GitStatus> {
  const repoRoot = await ctx.root();
  await execGit(['branch', force ? '-D' : '-d', nameArg(name)], repoRoot);
  return ctx.refresh();
}

/** Переименовать ветку. */
export async function renameBranch(ctx: BranchContext, from: string, to: string): Promise<GitStatus> {
  const repoRoot = await ctx.root();
  await execGit(['branch', '-m', nameArg(from), nameArg(to)], repoRoot);
  return ctx.refresh();
}
