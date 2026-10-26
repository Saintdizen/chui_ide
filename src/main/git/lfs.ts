import { promises as fs } from 'node:fs';
import path from 'node:path';
import { RpcErrorCode } from '../../shared/api';
import {
  emptyLfsInfo,
  type GitLfsInfo,
  normalizeLfsPattern,
  parseLfsFiles,
  parseLfsPatterns,
} from '../../shared/git-lfs';
import { RpcFailure } from '../ipc/router';
import type { RepositoryContext } from './contexts';
import { execGit, NETWORK_TIMEOUT_MS } from './exec';

export interface LfsContext extends RepositoryContext {}

export async function lfsInfo(ctx: LfsContext): Promise<GitLfsInfo> {
  const repoRoot = await requireRoot(ctx);

  const attributes = await fs.readFile(path.join(repoRoot, '.gitattributes'), 'utf8').catch(() => '');
  const patterns = parseLfsPatterns(attributes);

  const version = await execGit(['lfs', 'version'], repoRoot, { allowFailure: true });
  if (!version.ok) return emptyLfsInfo(patterns);
  // `git lfs version` печатает «git-lfs/3.4.0 (GitHub; …)» — берём первое слово.
  const versionText = version.stdout.trim().split(/\s+/)[0] ?? '';

  const listing = await execGit(['lfs', 'ls-files'], repoRoot, { allowFailure: true });
  const files = listing.ok ? parseLfsFiles(listing.stdout) : [];
  return {
    available: true,
    configured: patterns.length > 0 || files.length > 0,
    files,
    patterns,
    version: versionText || null,
  };
}

export async function lfsTrack(ctx: LfsContext, pattern: string): Promise<GitLfsInfo> {
  const repoRoot = await requireRoot(ctx);
  const clean = normalizeLfsPattern(pattern);
  if (clean === '' || /\s/.test(clean)) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, 'Шаблон не должен быть пустым или содержать пробелы');
  }
  await execGit(['lfs', 'track', '--', clean], repoRoot);
  return lfsInfo(ctx);
}

export async function lfsUntrack(ctx: LfsContext, pattern: string): Promise<GitLfsInfo> {
  const repoRoot = await requireRoot(ctx);
  const clean = normalizeLfsPattern(pattern);
  if (clean === '') throw new RpcFailure(RpcErrorCode.InvalidParams, 'Пустой шаблон');
  await execGit(['lfs', 'untrack', '--', clean], repoRoot);
  return lfsInfo(ctx);
}

/** Как fetch, только для больших файлов. */
export async function lfsPull(ctx: LfsContext): Promise<GitLfsInfo> {
  const repoRoot = await requireRoot(ctx);
  await execGit(['lfs', 'pull'], repoRoot, { timeout: NETWORK_TIMEOUT_MS });
  return lfsInfo(ctx);
}

/** Подготовить репозиторий к LFS: `git lfs install --local` (ставит хуки). */
export async function lfsInstall(ctx: LfsContext): Promise<GitLfsInfo> {
  const repoRoot = await requireRoot(ctx);
  await execGit(['lfs', 'install', '--local'], repoRoot);
  return lfsInfo(ctx);
}

async function requireRoot(ctx: LfsContext): Promise<string> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');
  return repoRoot;
}
