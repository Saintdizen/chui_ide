import { RpcErrorCode } from '../../shared/api';
import {
  type GitSparseInfo,
  isConePatterns,
  normalizeSparseDirectory,
  parseSparseFlag,
  parseSparseList,
} from '../../shared/git-sparse';
import { RpcFailure } from '../ipc/router';
import type { RepositoryContext } from './contexts';
import { execGit } from './exec';

export interface SparseContext extends RepositoryContext {}

/**
 * Что выложено на диск: включён ли разреженный режим и какие каталоги выбраны.
 */
export async function sparseInfo(ctx: SparseContext): Promise<GitSparseInfo> {
  const repoRoot = await requireRoot(ctx);

  const enabledRaw = await execGit(['config', '--get', 'core.sparseCheckout'], repoRoot, { allowFailure: true });
  const enabled = enabledRaw.ok && parseSparseFlag(enabledRaw.stdout);
  if (!enabled) return { enabled: false, cone: false, patterns: [] };

  const coneRaw = await execGit(['config', '--get', 'core.sparseCheckoutCone'], repoRoot, { allowFailure: true });
  // Современный git по умолчанию работает в cone-режиме: нет значения — считаем cone,
  // явное `false` — режим шаблонов.
  const cone = !coneRaw.ok || coneRaw.stdout.trim() === '' || parseSparseFlag(coneRaw.stdout);

  const list = await execGit(['sparse-checkout', 'list'], repoRoot, { allowFailure: true });
  const patterns = list.ok ? parseSparseList(list.stdout) : [];
  return { enabled: true, cone: cone || isConePatterns(patterns), patterns };
}

/** Заменить набор каталогов целиком (cone-режим). */
export async function sparseSet(ctx: SparseContext, directories: readonly string[]): Promise<GitSparseInfo> {
  const repoRoot = await requireRoot(ctx);
  const dirs = cleanDirectories(directories);
  if (dirs.length === 0) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Не выбран ни один каталог');
  await execGit(['sparse-checkout', 'set', '--cone', '--', ...dirs], repoRoot);
  return sparseInfo(ctx);
}

/** Добавить каталог к текущему набору (`git sparse-checkout add`). */
export async function sparseAdd(ctx: SparseContext, directory: string): Promise<GitSparseInfo> {
  const repoRoot = await requireRoot(ctx);
  const clean = normalizeSparseDirectory(directory);
  if (clean === null) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Негодный путь каталога');
  await execGit(['sparse-checkout', 'add', '--', clean], repoRoot);
  return sparseInfo(ctx);
}

/** Выключить разреженный режим: на диск возвращается весь репозиторий. */
export async function sparseDisable(ctx: SparseContext): Promise<GitSparseInfo> {
  const repoRoot = await requireRoot(ctx);
  await execGit(['sparse-checkout', 'disable'], repoRoot);
  return sparseInfo(ctx);
}

/** Привести список каталогов к виду git: без повторов и мусора. */
export function cleanDirectories(directories: readonly string[]): string[] {
  const out: string[] = [];
  for (const item of directories) {
    const clean = normalizeSparseDirectory(item);
    if (clean === null || out.includes(clean)) continue;
    out.push(clean);
  }
  return out;
}

async function requireRoot(ctx: SparseContext): Promise<string> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');
  return repoRoot;
}
