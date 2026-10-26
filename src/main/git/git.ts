import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTool } from '../tool';
import {
  PushTopic,
  RpcErrorCode,
  type GitBranch,
  type GitCommit,
  type GitCommitDiff,
  type GitFileHunks,
  type GitCommitInfo,
  type GitConflictParts,
  type GitDiff,
  type GitNetworkResult,
  type GitRebaseResult,
  type GitRemote,
  type GitStatus,
} from '../../shared/api';
import type { BlameLine } from '../../shared/git-blame';
import { hunkRanges } from '../../shared/git-hunks';
import type { GitReflogEntry } from '../../shared/git-reflog';
import type { GitStashEntry } from '../../shared/git-stash';
import { parseTagList, type GitTag } from '../../shared/git-tags';
import type { RebaseTodoItem } from '../../shared/git-rebase';
import type { PullMode } from '../../shared/git-pull';
import type { GitRefDiff } from '../../shared/git-ref-diff';
import { type GitBisectState } from '../../shared/git-bisect';
import { type BisectContext, bisectMark, bisectReset, bisectStart, bisectState } from './bisect';
import { headText, type InspectContext, reset, revert } from './inspect';
import { commitDiff, discard, discardHunk, fileHunks, stage, stageHunk, unstage, unstageHunk } from './index-staging';

import { type NetworkContext, runNetwork } from './network';
import {
  stashApply as gitStashApply,
  stashDrop as gitStashDrop,
  stashList as gitStashList,
  stashPop as gitStashPop,
  stashSave as gitStashSave,
  stashShow as gitStashShow,
  type StashContext,
} from './stash';
import { nameArg as gitNameArg } from './args';
import { rawDiff } from './diff-text';
import { readFileText } from './file-text';

import { RepositoryWatcher } from './repository-watcher';
import { readStatus, writeLocalConfig } from './status';
import type { GitSubmodule } from '../../shared/git-submodules';
import type { GitWorktree } from '../../shared/git-worktrees';
import type { GitLfsInfo } from '../../shared/git-lfs';
import type { Source } from './git-context-source';
import { listSubmodules, type SubmoduleContext, updateSubmodules } from './submodules';
import {
  rebase as gitRebase,
  rebaseAbort as gitRebaseAbort,
  rebaseContinue as gitRebaseContinue,
  rebaseSkip as gitRebaseSkip,
  type RebaseContext,
} from './rebase';
import {
  sparseAdd as gitSparseAdd,
  sparseDisable as gitSparseDisable,
  sparseInfo as gitSparseInfo,
  sparseSet as gitSparseSet,
  type SparseContext,
} from './sparse';
import { listSshKeys } from './ssh-keys';
import {
  IDENTITY_CONFIG_PATTERN,
  identityFromConfig,
  identityPatch,
  parseIdentityConfig,
  type GitIdentity,
  type GitSshKey,
} from '../../shared/git-identity';
import type { ForgeComment, ForgeInfo, ForgeIssue, ForgeNotification, ForgePipeline } from '../../shared/git-platform';
import {
  type ForgeContext,
  forgeCheckout,
  forgeComment,
  forgeComments,
  forgeCreate,
  forgeInfo,
  forgeIssueClose,
  forgeIssueComment,
  forgeIssueComments,
  forgeIssueCreate,
  forgeIssues,
  forgeNotificationRead,
  forgeNotifications,
  forgePipelineRerun,
  forgePipelines,
} from './forge';
import type { GitSparseInfo } from '../../shared/git-sparse';
import { summarizeRoot, type GitRootFetch, type GitRootSummary } from '../../shared/git-multiroot';
import type { WorkspaceRoot } from '../../shared/workspace-roots';
import {
  lfsInfo as gitLfsInfo,
  lfsInstall as gitLfsInstall,
  lfsPull as gitLfsPull,
  lfsTrack as gitLfsTrack,
  lfsUntrack as gitLfsUntrack,
  type LfsContext,
} from './lfs';
import { addWorktree, listWorktrees, pruneWorktrees, removeWorktree, type WorktreesContext } from './worktree';
import { RpcFailure } from '../ipc/router';
import type { BranchContext, HistoryContext, NetContext, WorktreeContext } from './contexts';
import { fetch, pull, push, remotes } from './net';
import { clone } from './clone';
import { branches, checkout, deleteBranch, renameBranch } from './branches';
import { blame, compareRefs, conflictParts, diffRefs, logGraph, logHistory, logText, reflog, show } from './history';
import { locateFile } from './locate';
export { gitTemplateDir } from './exec';
import { execGit, gitTemplateDir, type GitResult, NETWORK_TIMEOUT_MS } from './exec';

/**
 * Редактор списка шагов для `git rebase -i`: кладёт наш готовый список на место
 * того, что предложил git. Путь к списку приходит переменной окружения, а путь
 * к самому файлу todo git передаёт первым аргументом.
 */
/**
 * Git через обычный CLI, а не через библиотеку: git установлен у того, кто
 * запускает IDE, и ведёт себя ровно так, как настроен у него (алиасы, подписи,
 * хуки). Библиотека же навязывала бы свою реализацию вместо пользовательской.
 *
 * Сервис ничего не знает про renderer: он отдаёт доменные объекты и сам
 * публикует push-событие, когда состояние репозитория изменилось.
 */

export class GitService {
  private readonly watcher: RepositoryWatcher;

  constructor(
    private readonly root: () => string | null,
    private readonly publish: (topic: string, payload: unknown) => void,
    /**
     * «Метаданные репозитория изменились»: чужая операция (коммит из терминала,
     * агента, внешнего инструмента) переписала `.git`, но НЕ файлы дерева. Такую
     * правку в проводнике не видно, а пометки git остались бы старыми. Обработчик
     * пересчитывает статус (см. `main/index.ts`).
     *
     * Без обработчика слежение не заводим: уведомлять некого.
     */
    onRepositoryChange: (() => void) | null = null,
  ) {
    this.watcher = new RepositoryWatcher(onRepositoryChange);
  }

  /** Остановить наблюдение за метаданными: вызывается при выходе приложения. */
  dispose(): void {
    this.watcher.close();
  }

  /**
   * Статус рабочей папки; если она не в репозитории — `repository: null`.
   * `rootPath` задаёт папку явно — им пользуется сводка по всем корням области,
   * когда активен не тот корень, что нужен (`summary`).
   */
  async status(rootPath?: string): Promise<GitStatus> {
    const repoRoot = await this.repositoryRoot(rootPath);
    // Наблюдение ставим по активному корню (его зовут без пути): чужой коммит в
    // другой папке области статус активной не меняет.
    if (rootPath === undefined) this.watcher.sync(repoRoot);
    if (!repoRoot) return { repository: null, files: [] };
    return readStatus(repoRoot);
  }

  /**
   * Сводка по всем корням рабочей области: у каждого — свой репозиторий (или его
   * отсутствие) и счётчики правок. Папки считаем параллельно: git-вызовы в них
   * независимы, а последовательный обход на области из десятка папок заметно
   * медленнее. Сбой в одной папке не губит сводку — она просто окажется пустой.
   */
  async summary(roots: readonly WorkspaceRoot[]): Promise<GitRootSummary[]> {
    return Promise.all(
      roots.map(async (item) => {
        const status = await this.status(item.root).catch<GitStatus>(() => ({ repository: null, files: [] }));
        return summarizeRoot(status, item.root, item.name);
      }),
    );
  }

  async init(): Promise<GitStatus> {
    const root = this.requireRoot();
    const templates = gitTemplateDir();
    if (templates) await fs.mkdir(templates, { recursive: true });
    await execGit(['init'], root);
    return this.refresh();
  }

  /**
   * Коммит. С путями — только они, как «закоммитить этот файл» в других IDE.
   * `amend` заменяет последний коммит: пустое сообщение сохраняет прежнее.
   */
  async commit(message: string, paths?: string[], amend = false): Promise<GitCommitInfo> {
    const text = message.trim();
    // При amend пустое сообщение — это «оставить прежнее»: git возьмёт его через --no-edit.
    if (!amend && !text) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Пустое сообщение коммита');

    const status = await this.status();
    const repoRoot = status.repository?.root;
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');
    if (amend && !status.repository?.head) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, 'Исправлять нечего: коммитов ещё нет');
    }

    const args = ['commit'];
    if (amend) args.push('--amend');
    if (text) args.push('-m', text);
    else args.push('--no-edit');
    // Пути вместе с amend не передаём: `git` не поддерживает частичное исправление.
    if (paths?.length && !amend) {
      const known = new Map(status.files.map((file) => [file.path, file]));
      const relative = paths.map((target) => known.get(path.resolve(target))?.relative ?? path.resolve(target));
      args.push('--', ...relative);
    }

    await execGit(args, repoRoot);
    const info = await execGit(['log', '-1', '--format=%h%x00%s'], repoRoot);
    const [hash, summary] = info.stdout.trim().split('\u0000');
    const result = { hash: hash ?? '', summary: summary ?? '' };
    await this.refresh();
    return result;
  }

  /**
   * Сравнение файла: `staged` — индекс против HEAD, иначе рабочее дерево
   * против индекса. Одну из сторон всегда отдаёт git, вторую — либо git, либо ФС.
   */
  async diff(filePath: string, staged = false, commit?: string): Promise<GitDiff> {
    const status = await this.status();
    const repoRoot = status.repository?.root;
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

    const absolute = path.resolve(filePath);
    const known = status.files.find((file) => file.path === absolute);
    // Обычное сравнение требует правок: без них показывать нечего. Просмотр против
    // коммита возможен и для файла без текущих правок — тогда путь берём от корня.
    if (!commit && !known) throw new RpcFailure(RpcErrorCode.NotFound, 'У файла нет изменений');
    const relative = known?.relative ?? path.relative(repoRoot, absolute);

    // staged: индекс против HEAD, иначе рабочее дерево против индекса. Против
    // названного коммита — рабочее дерево (что реально лежит на диске сейчас).
    let original: string;
    let modified: string;
    if (commit) {
      original = await show(`${commit}:${relative}`, repoRoot);
      modified = await this.readText(absolute);
    } else {
      original = staged ? await show(`HEAD:${relative}`, repoRoot) : await show(`:${relative}`, repoRoot);
      modified = staged ? await show(`:${relative}`, repoRoot) : await this.readText(absolute);
    }

    // Границы блоков нужны интерфейсу: у каждого будет своя кнопка. Считаем из
    // того же diff, что приложит `git apply`, — тогда номера блоков совпадают.
    const hunks = hunkRanges(await rawDiff(relative, repoRoot, { staged, commit }));
    return { original, modified, hunks };
  }

  /**
   * Унифицированный diff файла от самого git (`+`/`-`). Нужен инструментам агента:
   * `diff()` отдаёт обе версии целиком, а модели полезнее готовые строки изменений.
   * Контекст здесь всегда 3 строки, как git показывает в терминале по умолчанию, —
   * не зависит от `diff.context` в настройках git (почему — в теле метода).
   */
  async diffText(filePath?: string, staged = false): Promise<string> {
    const status = await this.status();
    const repoRoot = status.repository?.root;
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

    // Путь не задан — весь рабочий diff: «покажи, что я наменял» одним вызовом.
    // Без него агент перебирал бы файлы по одному, а это шаг и вызов на каждый.
    if (!filePath) return rawDiff('', repoRoot, { staged });

    const known = status.files.find((file) => file.path === path.resolve(filePath));
    if (!known) throw new RpcFailure(RpcErrorCode.NotFound, 'У файла нет изменений');

    return rawDiff(known.relative, repoRoot, { staged });
  }

  /** Контекст для модуля `inspect`: три колбэка, состояние класса наружу не идёт. */
  private inspectContext(): InspectContext {
    return this.gitContext();
  }

  /**
   * Один набор колбэков на все модули `./git/*`.
   *
   * Модули объявляют разные контексты (`lfs.ts` просит только корень, `forge.ts`
   * ещё и удалённые), но дают их все отсюда: иначе каждый перенос метода
   * добавлял бы в класс ещё одну сборку контекста, и вернулась бы та же свалка,
   * только длиннее.
   */
  private gitContext(): Source {
    return {
      root: () => this.requireRoot(),
      repositoryRoot: (explicit?: string) => this.repositoryRoot(explicit),
      refresh: () => this.refresh(),
      status: () => this.refresh(),
      gitPath: (repoRoot: string, name: string) => this.gitPath(repoRoot, name),
      remotes: () => this.remotes(),
    };
  }

  /* ── интерактивный rebase ─────────────────────────────────────────────── */

  async rebase(count: number, items: readonly RebaseTodoItem[]): Promise<GitRebaseResult> {
    return gitRebase(this.rebaseCtx(), count, items);
  }

  /** Продолжить остановленный rebase (конфликт разрешён или шаг `edit` закончен). */
  async rebaseContinue(): Promise<GitRebaseResult> {
    return gitRebaseContinue(this.rebaseCtx());
  }

  /** Пропустить текущий коммит остановленного rebase. */
  async rebaseSkip(): Promise<GitRebaseResult> {
    return gitRebaseSkip(this.rebaseCtx());
  }

  /** Прервать rebase: ветка возвращается туда, где была до запуска. */
  async rebaseAbort(): Promise<GitStatus> {
    return gitRebaseAbort(this.rebaseCtx());
  }

  private rebaseCtx(): RebaseContext {
    return this.gitContext();
  }

  /* ── пошаговый поиск багованного коммита (bisect) ──────────────────────── */

  private bisectContext(): BisectContext {
    return this.gitContext();
  }

  /** Состояние поиска багованного коммита (bisect). */
  async bisectState(): Promise<GitBisectState> {
    return bisectState(this.bisectContext());
  }

  /** Начать поиск: `bad` — известный плохой коммит, `good` — известный хороший. */
  async bisectStart(options: { bad?: string; good?: string } = {}): Promise<GitBisectState> {
    return bisectStart(this.bisectContext(), options);
  }

  /** Пометить текущий проверяемый коммит хорошим, плохим или пропустить его. */
  async bisectMark(mark: 'good' | 'bad' | 'skip'): Promise<GitBisectState> {
    return bisectMark(this.bisectContext(), mark);
  }

  /** Закончить поиск: ветка возвращается туда, где была до него. */
  async bisectReset(): Promise<GitStatus> {
    return bisectReset(this.bisectContext());
  }

  /**
   * Отметить конфликт решённым: содержимое рабочего файла уходит в индекс.
   * Отдельно от `stage`: `add -A` тронул бы и соседние пути, а тут нужен ровно этот.
   */
  async markResolved(filePath: string): Promise<GitStatus> {
    const { repoRoot, relative } = await locateFile(() => this.status(), filePath);
    await execGit(['add', '--', relative], repoRoot);
    return this.refresh();
  }

  /** Статус плюс рассылка события: любую правку в репозитории UI узнаёт отсюда. */
  async refresh(): Promise<GitStatus> {
    const status = await this.status();
    this.publish(PushTopic.GitChanged, status);
    return status;
  }

  /**
   * Содержимое файла в HEAD. `null` — рабочая папка не репозиторий (тогда полосок
   * изменений быть не должно); пустая строка — файл новый или без коммитов.
   */
  async headText(filePath: string): Promise<string | null> {
    return headText(this.inspectContext(), filePath);
  }

  /* ── отложенные изменения (stash) ─────────────────────────────────────── */

  async stashList(): Promise<GitStashEntry[]> {
    return gitStashList(this.stashCtx());
  }

  /** `stash push` без изменений завершается успешно — это пустой результат, не сбой. */
  async stashSave(options: { message?: string; includeUntracked?: boolean } = {}): Promise<GitStatus> {
    return gitStashSave(this.stashCtx(), options);
  }

  async stashApply(index: number): Promise<GitStatus> {
    return gitStashApply(this.stashCtx(), index);
  }

  async stashPop(index: number): Promise<GitStatus> {
    return gitStashPop(this.stashCtx(), index);
  }

  async stashDrop(index: number): Promise<GitStatus> {
    return gitStashDrop(this.stashCtx(), index);
  }

  async stashShow(index: number): Promise<string> {
    return gitStashShow(this.stashCtx(), index);
  }

  private stashCtx(): StashContext {
    return this.gitContext();
  }

  async worktrees(): Promise<GitWorktree[]> {
    return listWorktrees(this.worktreeCtx());
  }

  async worktreeAdd(target: string, options: { branch?: string; newBranch?: string } = {}): Promise<GitWorktree[]> {
    return addWorktree(this.worktreeCtx(), target, options);
  }

  async worktreeRemove(target: string, force = false): Promise<GitWorktree[]> {
    return removeWorktree(this.worktreeCtx(), target, force);
  }

  /** Убрать записи о каталогах, которых уже нет на диске. */
  async worktreePrune(): Promise<GitWorktree[]> {
    return pruneWorktrees(this.worktreeCtx());
  }

  private worktreeCtx(): WorktreesContext {
    return this.gitContext();
  }

  /* ── отдельные коммиты и теги ─────────────────────────────────────────── */

  /** Перенести один коммит в текущую ветку. */
  async cherryPick(commit: string): Promise<GitStatus> {
    const repoRoot = await this.requireRoot();
    await execGit(['cherry-pick', this.commitArg(commit)], repoRoot);
    return this.refresh();
  }

  /** Отменить один коммит новым коммитом с обратными правками. */
  async revert(commit: string): Promise<GitStatus> {
    return revert(this.inspectContext(), commit);
  }

  /** Передвинуть ветку на коммит: soft (только указатель), mixed (+ индекс), hard (+ дерево). */
  async reset(mode: 'soft' | 'mixed' | 'hard', commit: string): Promise<GitStatus> {
    return reset(this.inspectContext(), mode, commit);
  }

  /* ── интерактивный rebase ──────────────────────────────────────────────── */

  /**
   * Путь внутри каталога git (`.git` или рабочий каталог worktree). Спрашиваем у
   * самого git: у связанных рабочих каталогов `.git` — это файл, а не папка.
   */
  private async gitPath(repoRoot: string, name: string): Promise<string | null> {
    const result = await execGit(['rev-parse', '--git-path', name], repoRoot, { allowFailure: true });
    const value = result.stdout.trim();
    if (!result.ok || !value) return null;
    return path.isAbsolute(value) ? value : path.join(repoRoot, value);
  }

  /** Список тегов: от новых к старым, как их показывает git. */
  async tags(): Promise<GitTag[]> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) return [];
    const result = await execGit(
      ['tag', '--list', '--format=%(refname:short)\t%(objectname:short)\t%(contents:subject)'],
      repoRoot,
      {
        allowFailure: true,
      },
    );
    return parseTagList(result.stdout);
  }

  /** Поставить тег. С сообщением — аннотированный, без — лёгкий. */
  async createTag(name: string, options: { message?: string; commit?: string } = {}): Promise<GitStatus> {
    const repoRoot = await this.requireRoot();
    const args = ['tag'];
    const message = options.message?.trim();
    if (message) args.push('-a', '-m', message);
    args.push(this.nameArg(name));
    if (options.commit) args.push(this.commitArg(options.commit));
    await execGit(args, repoRoot);
    return this.refresh();
  }

  /** Удалить тег из репозитория (удалённый не трогаем). */
  async deleteTag(name: string): Promise<GitStatus> {
    const repoRoot = await this.requireRoot();
    await execGit(['tag', '-d', this.nameArg(name)], repoRoot);
    return this.refresh();
  }

  /** Отправить один тег в origin. */
  async pushTag(name: string): Promise<GitNetworkResult> {
    return this.network(['push', 'origin', `refs/tags/${this.nameArg(name)}`]);
  }

  /* ── ветки, .gitignore и журнал ссылок ────────────────────────────────── */

  /**
   * Добавить пути в `.gitignore` корня репозитория. Уже перечисленные не дублируем,
   * а сам файл создаём, если его ещё нет. Путь пишем от корня и со слэшами: так
   * его понимает gitignore на любой системе.
   */
  async ignore(paths: string[]): Promise<GitStatus> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');
    const current = await this.readText(path.join(repoRoot, '.gitignore')).catch(() => '');
    const lines = current.split('\n').filter((line) => line.trim() !== '');
    const known = new Set(lines.map((line) => line.trim()));

    const added: string[] = [];
    for (const target of paths) {
      const relative = path.relative(repoRoot, path.resolve(target)).split(path.sep).join('/');
      if (!relative || relative.startsWith('..') || known.has(relative)) continue;
      known.add(relative);
      added.push(relative);
    }

    if (added.length > 0) {
      const text = [...lines, ...added].join('\n');
      await fs.writeFile(path.join(repoRoot, '.gitignore'), `${text}\n`, 'utf8');
    }
    return this.refresh();
  }

  /** Подмодули репозитория: какие папки — чужие репозитории и в каком они состоянии. */
  async submodules(): Promise<GitSubmodule[]> {
    return listSubmodules(this.submoduleCtx());
  }

  /** Забрать код подмодулей: `git submodule update --init --recursive`. */
  async submoduleUpdate(): Promise<GitStatus> {
    return updateSubmodules(this.submoduleCtx());
  }

  private submoduleCtx(): SubmoduleContext {
    return this.gitContext();
  }

  /* ── площадка хостинга: запросы на слияние (PR/MR) ─────────────────────── */

  /**
   * Что знает репозиторий про свою площадку и её запросы на слияние.
   *
   * Площадку определяем по адресу удалённого репозитория (`origin`, а если его нет —
   * первого попавшегося). Дальше всё зависит от консольного клиента: у GitHub это
   * `gh`, у GitLab — `glab`. Нет клиента или не выполнен вход — не ошибка, а честная
   * пометка в `note`: окно скажет, чего именно не хватает, а не покажет пустоту.
   *
   * `remote` — какой из удалённых смотреть; без него — `origin`, иначе первый по имени.
   */
  /** Площадка: задачи, конвейеры, уведомления. Тело — в `git/forge.ts`. */
  private forgeCtx(): ForgeContext {
    return this.gitContext();
  }

  async forgeInfo(remote?: string): Promise<ForgeInfo> {
    return forgeInfo(this.forgeCtx(), remote);
  }

  async forgeCreate(options: {
    title: string;
    body?: string;
    target?: string;
    draft?: boolean;
    source?: string;
  }): Promise<ForgeInfo> {
    return forgeCreate(this.forgeCtx(), options);
  }

  async forgeCheckout(number: number): Promise<GitStatus> {
    return forgeCheckout(this.forgeCtx(), number);
  }

  async forgeComments(number: number): Promise<ForgeComment[]> {
    return forgeComments(this.forgeCtx(), number);
  }

  async forgeComment(number: number, body: string): Promise<ForgeComment[]> {
    return forgeComment(this.forgeCtx(), number, body);
  }

  async forgeIssues(): Promise<ForgeIssue[]> {
    return forgeIssues(this.forgeCtx());
  }

  async forgeIssueCreate(options: { title: string; body?: string }): Promise<ForgeIssue[]> {
    return forgeIssueCreate(this.forgeCtx(), options);
  }

  async forgeIssueClose(number: number): Promise<ForgeIssue[]> {
    return forgeIssueClose(this.forgeCtx(), number);
  }

  async forgeIssueComments(number: number): Promise<ForgeComment[]> {
    return forgeIssueComments(this.forgeCtx(), number);
  }

  async forgeIssueComment(number: number, body: string): Promise<ForgeComment[]> {
    return forgeIssueComment(this.forgeCtx(), number, body);
  }

  async forgePipelines(): Promise<ForgePipeline[]> {
    return forgePipelines(this.forgeCtx());
  }

  async forgePipelineRerun(id: number): Promise<ForgePipeline[]> {
    return forgePipelineRerun(this.forgeCtx(), id);
  }

  async forgeNotifications(): Promise<ForgeNotification[]> {
    return forgeNotifications(this.forgeCtx());
  }

  async forgeNotificationRead(id: string): Promise<ForgeNotification[]> {
    return forgeNotificationRead(this.forgeCtx(), id);
  }

  /* ── личность, подпись коммитов и ключи ────────────────────────────────── */

  /**
   * Действующие настройки автора и подписи. Одним запуском `git config --get-regexp -z`:
   * он сам собирает значения из системного, глобального и локального конфигов в том же
   * порядке, чем пользуется git при коммите. Семь отдельных `--get` давали семь процессов
   * на каждый вызов, а `identity()` зовётся и из `setIdentity()`, и из окна настроек.
   */
  async identity(): Promise<GitIdentity> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');
    const result = await execGit(['config', '--get-regexp', '-z', IDENTITY_CONFIG_PATTERN], repoRoot, {
      allowFailure: true,
    });
    const draft = identityFromConfig(parseIdentityConfig(result.ok ? result.stdout : ''), false);
    draft.keyFound = await this.signingKeyFound(draft);
    return draft;
  }

  /**
   * Записать настройки в ЛОКАЛЬНЫЙ конфиг репозитория: так правка касается только
   * этого проекта и не переписывает личность человека в его глобальных настройках.
   */
  async setIdentity(values: Partial<GitIdentity>): Promise<GitIdentity> {
    const repoRoot = await this.requireRoot();
    const current = await this.identity();
    const patch = identityPatch(current, values);
    if (patch.length === 0) return current;
    await writeLocalConfig(repoRoot, patch);
    return this.identity();
  }

  /** Есть ли ключ подписи: у ssh — файл на диске, у GPG — секретный ключ в связке. */
  private async signingKeyFound(identity: GitIdentity): Promise<boolean> {
    if (identity.signingKey === '') return false;
    if (identity.format === 'ssh') {
      const raw = identity.signingKey;
      const target = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
      const stat = await fs.stat(target).catch(() => null);
      return Boolean(stat?.isFile());
    }
    const result = await this.tool('gpg', ['--list-secret-keys', '--with-colons', identity.signingKey]);
    return result.ok && /(^|\n)sec:/.test(result.stdout);
  }

  /** Запуск не-git инструмента (gpg, ssh-keygen): сбой — это `ok: false`, а не исключение. */
  private tool(file: string, args: string[]): Promise<GitResult> {
    return runTool(file, args);
  }

  /* ── разреженный рабочий каталог (sparse checkout) ─────────────── */

  async sparseInfo(): Promise<GitSparseInfo> {
    return gitSparseInfo(this.sparseCtx());
  }

  async sparseSet(directories: string[]): Promise<GitSparseInfo> {
    return gitSparseSet(this.sparseCtx(), directories);
  }

  async sparseAdd(directory: string): Promise<GitSparseInfo> {
    return gitSparseAdd(this.sparseCtx(), directory);
  }

  /** Выключить разреженный режим: на диск возвращается весь репозиторий. */
  async sparseDisable(): Promise<GitSparseInfo> {
    return gitSparseDisable(this.sparseCtx());
  }

  private sparseCtx(): SparseContext {
    return this.gitContext();
  }

  async sshKeys(): Promise<GitSshKey[]> {
    return listSshKeys();
  }

  /* ── сеть и удалённые репозитории ─────────────────────────────────────── */

  async remotes(): Promise<GitRemote[]> {
    return remotes(this.netCtx());
  }

  async fetch(): Promise<GitNetworkResult> {
    return fetch(this.netCtx());
  }

  /**
   * Обновление всех корней рабочей папки разом. В контракте это «git.fetchRoots»:
   * список приходит снаружи, потому что корни знает рабочая папка, а не git.
   */
  async fetchRoots(roots: readonly WorkspaceRoot[]): Promise<GitRootFetch[]> {
    const results = await Promise.all(
      roots.map(async (item): Promise<GitRootFetch> => {
        const repoRoot = await this.repositoryRoot(item.root);
        if (!repoRoot) {
          return { root: item.root, name: item.name, ok: false, message: 'не репозиторий git' };
        }
        const result = await execGit(['fetch', '--all', '--prune'], repoRoot, {
          allowFailure: true,
          timeout: NETWORK_TIMEOUT_MS,
        });
        const text = (result.stderr.trim() || result.stdout.trim()).trim();
        return { root: item.root, name: item.name, ok: result.ok, message: text || 'обновлено' };
      }),
    );
    // Активную папку пересчитываем: её статус виден в панели и в строке состояния.
    await this.refresh().catch(() => undefined);
    return results;
  }

  async pull(mode: PullMode = 'default'): Promise<GitNetworkResult> {
    return pull(this.netCtx(), mode);
  }

  async push(options: { setUpstream?: boolean; force?: boolean } = {}): Promise<GitNetworkResult> {
    return push(this.netCtx(), options);
  }

  async clone(url: string, directory: string, onProgress?: (line: string) => void): Promise<{ path: string }> {
    return clone(url, directory, onProgress);
  }

  private netCtx(): NetContext {
    return this.gitContext();
  }

  /* ── ветки ────────────────────────────────────────────────────────────── */

  async branches(): Promise<GitBranch[]> {
    return branches(this.branchCtx());
  }

  async checkout(name: string, create = false): Promise<GitStatus> {
    return checkout(this.branchCtx(), name, create);
  }

  async deleteBranch(name: string, force = false): Promise<GitStatus> {
    return deleteBranch(this.branchCtx(), name, force);
  }

  async renameBranch(from: string, to: string): Promise<GitStatus> {
    return renameBranch(this.branchCtx(), from, to);
  }

  private branchCtx(): BranchContext {
    return this.gitContext();
  }

  /* ── история и содержимое ─────────────────────────────────────────────── */

  async logText(limit = 20, filePath?: string): Promise<string> {
    return logText(this.historyCtx(), limit, filePath);
  }

  async log(limit = 50, filePath?: string): Promise<GitCommit[]> {
    return logHistory(this.historyCtx(), limit, filePath);
  }

  async blame(filePath: string, range?: { startLine?: number; endLine?: number }): Promise<BlameLine[]> {
    return blame(this.historyCtx(), filePath, range);
  }

  async conflictParts(filePath: string): Promise<GitConflictParts> {
    return conflictParts(this.historyCtx(), filePath);
  }

  async compareRefs(base: string, head: string): Promise<GitRefDiff> {
    return compareRefs(this.historyCtx(), base, head);
  }

  async diffRefs(base: string, head: string, filePath: string): Promise<GitDiff> {
    return diffRefs(this.historyCtx(), base, head, filePath);
  }

  async reflog(limit = 50): Promise<GitReflogEntry[]> {
    return reflog(this.historyCtx(), limit);
  }

  async logGraph(limit = 100): Promise<string> {
    return logGraph(this.historyCtx(), limit);
  }

  private historyCtx(): HistoryContext {
    return this.gitContext();
  }

  /* ── индекс и рабочее дерево ──────────────────────────────────────────── */

  async stage(paths: string[]): Promise<GitStatus> {
    return stage(this.stagingCtx(), paths);
  }

  async unstage(paths: string[]): Promise<GitStatus> {
    return unstage(this.stagingCtx(), paths);
  }

  async stageHunk(filePath: string, index: number): Promise<GitStatus> {
    return stageHunk(this.stagingCtx(), filePath, index);
  }

  async unstageHunk(filePath: string, index: number): Promise<GitStatus> {
    return unstageHunk(this.stagingCtx(), filePath, index);
  }

  async discardHunk(filePath: string, index: number): Promise<GitStatus> {
    return discardHunk(this.stagingCtx(), filePath, index);
  }

  async fileHunks(filePath: string): Promise<GitFileHunks> {
    return fileHunks(this.stagingCtx(), filePath);
  }

  async discard(paths: string[]): Promise<GitStatus> {
    return discard(this.stagingCtx(), paths);
  }

  async commitDiff(): Promise<GitCommitDiff> {
    return commitDiff(this.stagingCtx());
  }

  private stagingCtx(): WorktreeContext {
    return this.gitContext();
  }

  /* ── Git LFS (хранение больших файлов) ─────────────────────────────────── */

  async lfsInfo(): Promise<GitLfsInfo> {
    return gitLfsInfo(this.lfsCtx());
  }

  async lfsTrack(pattern: string): Promise<GitLfsInfo> {
    return gitLfsTrack(this.lfsCtx(), pattern);
  }

  async lfsUntrack(pattern: string): Promise<GitLfsInfo> {
    return gitLfsUntrack(this.lfsCtx(), pattern);
  }

  /** Как fetch, только для больших файлов. */
  async lfsPull(): Promise<GitLfsInfo> {
    return gitLfsPull(this.lfsCtx());
  }

  /** Подготовить репозиторий к LFS: `git lfs install --local` (ставит хуки). */
  async lfsInstall(): Promise<GitLfsInfo> {
    return gitLfsInstall(this.lfsCtx());
  }

  private lfsCtx(): LfsContext {
    return this.gitContext();
  }

  /* ── дополнительные рабочие каталоги (worktree) ───────────────────────── */

  /**
   * Какие из путей git считает игнорируемыми (`.gitignore`). Спрашиваем только про
   * то, что реально видно в дереве: полный список игнорируемого на проекте с
   * `node_modules` — это сотни тысяч строк, и читать его незачем.
   *
   * Пути идут на stdin через NUL: так их не ограничивает длина командной строки,
   * а `-z` даёт ответ тоже через NUL — имена со спецсимволами не ломают разбор.
   */
  async checkIgnore(paths: string[]): Promise<string[]> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot || paths.length === 0) return [];
    const relative = paths.map((target) => {
      const absolute = path.resolve(target);
      const text = path.relative(repoRoot, absolute).split(path.sep).join('/');
      return { absolute, text };
    });
    const known = new Map(relative.map((item) => [item.text, item.absolute]));
    const output = await this.checkIgnoreRaw(
      repoRoot,
      relative.map((item) => item.text),
    );
    return (
      output
        .split('\u0000')
        // На Windows git отвечает родным разделителем — сверяем в прямых слэшах.
        .map((line) => line.trim().split('\\').join('/'))
        .map((line) => known.get(line))
        .filter((item): item is string => typeof item === 'string')
    );
  }

  /** Сам вызов `git check-ignore`: пути на stdin, ответ NUL-разделённый. */
  private checkIgnoreRaw(repoRoot: string, relative: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['--no-optional-locks', 'check-ignore', '-z', '--stdin'], {
        cwd: repoRoot,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_EDITOR: 'true',
          GIT_PAGER: 'cat',
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => reject(new RpcFailure(RpcErrorCode.Internal, `git: ${error.message}`)));
      child.on('close', (code) => {
        // Код 1 — «ничего не игнорируется»: это обычный ответ, а не сбой.
        if (code === 0 || code === 1) resolve(stdout);
        else reject(new RpcFailure(RpcErrorCode.Internal, `git check-ignore: ${stderr.trim() || `код ${code}`}`));
      });
      // Пути разделяем NUL: в имени файла перевод строки — законное имя.
      child.stdin.end(relative.map((item) => `${item}\u0000`).join(''));
    });
  }

  /** Имя коммита может начинаться с `-` — тогда git примет его за флаг, а не за ссылку. */
  private commitArg(commit: string): string {
    const value = commit.trim();
    if (!value) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Не задан коммит');
    if (value.startsWith('-'))
      throw new RpcFailure(RpcErrorCode.InvalidParams, `Некорректная ссылка на коммит: ${value}`);
    return value;
  }

  private nameArg(name: string): string {
    return gitNameArg(name);
  }

  /* ── внутреннее ────────────────────────────────────────────────────────── */

  /**
   * Сетевая операция git: запуск, разбор итога и свежий статус. Сбой (нет remote,
   * отказ авторизации, конфликт слияния) — не исключение, а ответ: `ok: false` и
   * текст от git. Ожидание много больше обычного — здесь ждут сеть.
   */
  /** Сетевая команда: свой таймаут, «нечего пушить» — не исключение (см. network.ts). */
  private network(args: string[]): Promise<GitNetworkResult> {
    return runNetwork(this.networkCtx(), args);
  }

  private networkCtx(): NetworkContext {
    return this.gitContext();
  }

  private requireRoot(): string {
    const root = this.root();
    if (!root) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Проект не открыт');
    return root;
  }

  /**
   * Корень репозитория для рабочей папки. Если папка открыта внутри большего
   * репозитория, git вернёт его корень — это ожидаемое поведение.
   */
  private async repositoryRoot(explicit?: string): Promise<string | null> {
    const root = explicit ?? this.root();
    if (!root) return null;
    const result = await execGit(['rev-parse', '--show-toplevel'], root, { allowFailure: true });
    if (!result.ok) return null;
    const value = result.stdout.trim();
    return value || null;
  }

  private readText(absolute: string): Promise<string> {
    return readFileText(absolute);
  }
}
