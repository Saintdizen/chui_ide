import path from 'node:path';
import { shell } from 'electron';
import { RpcErrorCode } from '../../shared/api';
import type { GitCommitDiff, GitFileHunks, GitStatus } from '../../shared/api';
import { COMMIT_DIFF_MAX_CHARS, truncateDiff } from '../../shared/commit-message';
import { hunkPatch, hunkRanges } from '../../shared/git-hunks';
import { RpcFailure } from '../ipc/router';
import { applyToIndex, applyToWorktree } from './apply';
import type { WorktreeContext } from './contexts';
import { rawDiff } from './diff-text';
import { execGit } from './exec';
import { locateFile, locatePaths } from './locate';

/** Путь файла в виде, понятном git: корень репозитория и путь относительно него. */
interface Located {
  repoRoot: string;
  relative: string;
}

/**
 * Проиндексировать всё: `add -A` замечает и удаления — `add --` их не видит.
 */
export async function stage(ctx: WorktreeContext, paths: string[]): Promise<GitStatus> {
  const located = await locatePaths(() => ctx.status(), paths);
  await execGit(['add', '-A', '--', ...located.relative], located.repoRoot);
  return ctx.refresh();
}

/**
 * Убрать из индекса. `restore --staged` требует HEAD, а в репозитории без
 * коммитов его нет — там файл просто убирается из индекса через `rm --cached`.
 */
export async function unstage(ctx: WorktreeContext, paths: string[]): Promise<GitStatus> {
  const { repoRoot, relative } = await locatePaths(() => ctx.status(), paths);
  const result = await execGit(['restore', '--staged', '--', ...relative], repoRoot, { allowFailure: true });
  if (!result.ok) await execGit(['rm', '--cached', '-q', '--', ...relative], repoRoot);
  return ctx.refresh();
}

/**
 * Проиндексировать один блок изменений файла.
 *
 * Блок берётся из diff рабочего дерева против индекса и прикладывается к индексу
 * (`apply --cached`), не трогая остальные правки: файл целиком в индекс не попадает.
 */
export async function stageHunk(ctx: WorktreeContext, filePath: string, index: number): Promise<GitStatus> {
  const { repoRoot, relative } = await locateHunk(ctx, filePath);
  const patch = hunkPatch(await rawDiff(relative, repoRoot, { staged: false }), index);
  if (!patch) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Блок изменений не найден');
  await applyToIndex(patch, repoRoot, false);
  return ctx.refresh();
}

/** Убрать из индекса один блок: обратный патч индекса против HEAD. */
export async function unstageHunk(ctx: WorktreeContext, filePath: string, index: number): Promise<GitStatus> {
  const { repoRoot, relative } = await locateHunk(ctx, filePath);
  const patch = hunkPatch(await rawDiff(relative, repoRoot, { staged: true }), index);
  if (!patch) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Блок изменений не найден');
  await applyToIndex(patch, repoRoot, true);
  return ctx.refresh();
}

/**
 * Откатить ОДИН блок файла в рабочем дереве: обратный патч без `--cached` —
 * правка исчезает из файла, но индекс не трогается. Это «отменить это
 * изменение» из жёлоба. Блок берётся из diff рабочего дерева против индекса:
 * откатывать имеет смысл только то, чего ещё нет в индексе.
 */
export async function discardHunk(ctx: WorktreeContext, filePath: string, index: number): Promise<GitStatus> {
  const { repoRoot, relative } = await locateHunk(ctx, filePath);
  const patch = hunkPatch(await rawDiff(relative, repoRoot, { staged: false }), index);
  if (!patch) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Блок изменений не найден');
  await applyToWorktree(patch, repoRoot);
  return ctx.refresh();
}

/**
 * Блоки изменений файла: что в рабочем дереве и что уже в индексе.
 *
 * Нужно действиям из жёлоба: щёлкнули по полоске на строке — приложение
 * спрашивает блоки и решает, что предложить. Считаем ДВА diff-а, потому что
 * вопросы разные: `unstaged` (рабочее дерево против индекса) — что ещё можно
 * проиндексировать или откатить, `staged` (индекс против HEAD) — что уже в
 * индексе и оттуда убирается.
 */
export async function fileHunks(ctx: WorktreeContext, filePath: string): Promise<GitFileHunks> {
  // Между щелчком по полоске и этим запросом файл могли сохранить или закоммитить:
  // тогда правок уже нет, и это нормальный ответ «блоков нет», а не ошибка.
  const located = await locateHunk(ctx, filePath).catch(() => null);
  if (!located) return { unstaged: [], staged: [] };
  const { repoRoot, relative } = located;
  const unstaged = await rawDiff(relative, repoRoot, { staged: false });
  const staged = await rawDiff(relative, repoRoot, { staged: true });
  return { unstaged: hunkRanges(unstaged), staged: hunkRanges(staged) };
}

/**
 * Откат правок: у отслеживаемых файлов — к состоянию HEAD, у новых — файл
 * отправляется в корзину. Совсем удалять чужие файлы IDE не должна.
 */
export async function discard(ctx: WorktreeContext, paths: string[]): Promise<GitStatus> {
  const status = await ctx.status();
  const repoRoot = status.repository?.root;
  if (!repoRoot || !status.repository) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');
  }

  const known = new Map(status.files.map((file) => [file.path, file]));
  const tracked: string[] = [];
  const loose: string[] = [];

  for (const target of paths) {
    const file = known.get(path.resolve(target));
    if (!file) continue;
    // Нет коммитов — откатывать не к чему, значит файл для git новый.
    if (file.change === 'untracked' || status.repository.head === null) loose.push(file.path);
    else tracked.push(file.relative);
  }

  if (tracked.length) {
    await execGit(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked], repoRoot);
  }
  for (const file of loose) {
    // Корзина, а не удаление: rm уничтожил бы чужую работу без возврата.
    await shell.trashItem(file).catch(() => undefined);
  }

  return ctx.refresh();
}

/**
 * Diff того, что уйдёт в коммит, — для сообщения коммита агентом.
 *
 * Полного diff тут не нужно: по содержимому всё равно не выйдет уместить его в
 * промпт, поэтому режем по потолку здесь же — гнать через IPC мегабайты ни к чему.
 */
export async function commitDiff(ctx: WorktreeContext): Promise<GitCommitDiff> {
  const status = await ctx.status();
  const repoRoot = status.repository?.root;
  if (!repoRoot) {
    return { diff: '', staged: false, truncated: false, files: 0, untracked: [] };
  }

  const staged = status.files.some((file) => file.staged);
  const untracked = status.files.filter((file) => file.change === 'untracked').map((file) => file.relative);
  const args = staged
    ? ['diff', '--cached', '-U3', '--no-color', '--no-ext-diff']
    : ['diff', '-U3', '--no-color', '--no-ext-diff'];
  const result = await execGit(args, repoRoot, { allowFailure: true });

  // Обрезка по потолку — общей функцией: её же проверяют тесты сборки промпта.
  const limited = truncateDiff(result.stdout, COMMIT_DIFF_MAX_CHARS);
  // Сколько файлов уйдёт в коммит: проиндексированные, а без них — все с правками.
  const files = staged ? status.files.filter((file) => file.staged).length : status.files.length;
  return {
    diff: limited.text,
    staged,
    truncated: limited.truncated,
    files,
    untracked,
  };
}

function locateHunk(ctx: WorktreeContext, filePath: string): Promise<Located> {
  return locateFile(() => ctx.status(), filePath);
}
