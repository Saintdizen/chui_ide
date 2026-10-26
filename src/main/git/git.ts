import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shell } from 'electron';
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
import { parseBlamePorcelain, type BlameLine } from '../../shared/git-blame';
import { hunkPatch, hunkRanges } from '../../shared/git-hunks';
import { parseReflog, type GitReflogEntry } from '../../shared/git-reflog';
import { parseStashList, type GitStashEntry } from '../../shared/git-stash';
import { parseTagList, type GitTag } from '../../shared/git-tags';
import { formatRebaseTodo, validateRebaseTodo, type RebaseTodoItem } from '../../shared/git-rebase';
import { pullModeArgs, type PullMode } from '../../shared/git-pull';
import { mergeRefDiff, type GitRefDiff } from '../../shared/git-ref-diff';
import { type GitBisectState } from '../../shared/git-bisect';
import { type BisectContext, bisectMark, bisectReset, bisectStart, bisectState } from './bisect';
import { headText, type InspectContext, reset, revert } from './inspect';
import { applyToIndex as gitApplyToIndex, applyToWorktree as gitApplyToWorktree } from './apply';
import { type NetworkContext, runNetwork } from './network';
import { nameArg as gitNameArg, refArg as gitRefArg } from './args';
import { rawDiff as gitRawDiff } from './diff-text';
import { readFileText, showFile } from './file-text';
import { locateFile, locatePaths } from './locate';
import { RepositoryWatcher } from './repository-watcher';
import { parseStatus, writeLocalConfig } from './status';
import { parseSubmodules, type GitSubmodule } from '../../shared/git-submodules';
import { parseWorktrees, type GitWorktree } from '../../shared/git-worktrees';
import {
  emptyLfsInfo,
  normalizeLfsPattern,
  parseLfsFiles,
  parseLfsPatterns,
  type GitLfsInfo,
} from '../../shared/git-lfs';
import {
  IDENTITY_CONFIG_PATTERN,
  identityFromConfig,
  identityPatch,
  parseIdentityConfig,
  parseSshPublicKey,
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
import {
  isConePatterns,
  normalizeSparseDirectory,
  parseSparseFlag,
  parseSparseList,
  type GitSparseInfo,
} from '../../shared/git-sparse';
import { summarizeRoot, type GitRootFetch, type GitRootSummary } from '../../shared/git-multiroot';
import { COMMIT_DIFF_MAX_CHARS, truncateDiff } from '../../shared/commit-message';
import type { WorkspaceRoot } from '../../shared/workspace-roots';
import { RpcFailure } from '../ipc/router';
export { gitTemplateDir } from './exec';
import { CLONE_TIMEOUT_MS, execGit, gitTemplateDir, GIT_TIMEOUT_MS, NETWORK_TIMEOUT_MS } from './exec';

/**
 * Редактор списка шагов для `git rebase -i`: кладёт наш готовый список на место
 * того, что предложил git. Путь к списку приходит переменной окружения, а путь
 * к самому файлу todo git передаёт первым аргументом.
 */
const SEQUENCE_EDITOR_SCRIPT = `
const fs = require('node:fs');
const target = process.argv[2];
const source = process.env.CHUI_REBASE_TODO;
if (target && source) fs.writeFileSync(target, fs.readFileSync(source, 'utf8'));
`;

/**
 * Редактор сообщений коммита: нужен для `reword`. По исходному тексту коммита
 * (git кладёт его в файл) подставляет новое сообщение из карты. Если текста в карте
 * нет — оставляет как есть (так `squash` сохраняет составленное git сообщение).
 */
const MESSAGE_EDITOR_SCRIPT = `
const fs = require('node:fs');
const NEWLINE = String.fromCharCode(10);
const target = process.argv[2];
if (!target) process.exit(0);
let current = '';
try { current = fs.readFileSync(target, 'utf8'); } catch { current = ''; }
// git кладёт в файл и само сообщение, и подсказки (строки с '#') — их отбрасываем,
// иначе исходное сообщение не совпадёт с тем, что мы помним о коммите.
const message = current
  .split(NEWLINE)
  .filter((line) => !line.startsWith('#'))
  .join(NEWLINE)
  .trimEnd();
let map = {};
try { map = JSON.parse(fs.readFileSync(process.env.CHUI_REBASE_MESSAGES, 'utf8')); } catch { map = {}; }
if (Object.prototype.hasOwnProperty.call(map, message)) fs.writeFileSync(target, map[message]);
`;

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

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

    const result = await execGit(['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'], repoRoot);
    return parseStatus(result.stdout, repoRoot);
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
   * Diff того, что попадёт в коммит. С индексированными правками — индекс против
   * HEAD (ровно содержимое будущего коммита), без них — рабочее дерево против
   * индекса: человек просит сообщение по тому, что видит в панели изменений.
   *
   * Новые файлы в `git diff` не видны вовсе: их отдаём отдельным списком имён —
   * по названиям уже понятно, что за правка («тесты», «миграция»), а тянуть их
   * содержимое в промпт незачем. Diff режем по потолку здесь же: гнать через IPC
   * мегабайты смысла нет, а в промпт они всё равно не поместятся.
   */
  async commitDiff(): Promise<GitCommitDiff> {
    const status = await this.status();
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

  async stage(paths: string[]): Promise<GitStatus> {
    const { repoRoot, relative } = await this.locate(paths);
    // `-A` нужен, чтобы одной командой уходили и удаления: `add --` их не замечает.
    await execGit(['add', '-A', '--', ...relative], repoRoot);
    return this.refresh();
  }

  /**
   * Проиндексировать только один блок изменений файла. Блок берётся из diff
   * рабочего дерева против индекса и прикладывается к индексу (`apply --cached`),
   * не трогая остальные правки: файл целиком в индекс не попадает.
   */
  async stageHunk(filePath: string, index: number): Promise<GitStatus> {
    const { repoRoot, relative } = await this.locateHunk(filePath);
    const patch = hunkPatch(await this.rawDiff(relative, repoRoot, { staged: false }), index);
    if (!patch) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Блок изменений не найден');
    await this.applyToIndex(patch, repoRoot, false);
    return this.refresh();
  }

  /** Убрать из индекса один блок: обратный патч индекса против HEAD. */
  async unstageHunk(filePath: string, index: number): Promise<GitStatus> {
    const { repoRoot, relative } = await this.locateHunk(filePath);
    const patch = hunkPatch(await this.rawDiff(relative, repoRoot, { staged: true }), index);
    if (!patch) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Блок изменений не найден');
    await this.applyToIndex(patch, repoRoot, true);
    return this.refresh();
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
  async fileHunks(filePath: string): Promise<GitFileHunks> {
    // Между щелчком по полоске и этим запросом файл могли сохранить или закоммитить:
    // тогда правок уже нет, и это нормальный ответ «блоков нет», а не ошибка.
    const located = await this.locateHunk(filePath).catch(() => null);
    if (!located) return { unstaged: [], staged: [] };
    const { repoRoot, relative } = located;
    const unstaged = await this.rawDiff(relative, repoRoot, { staged: false });
    const staged = await this.rawDiff(relative, repoRoot, { staged: true });
    return { unstaged: hunkRanges(unstaged), staged: hunkRanges(staged) };
  }

  /**
   * Откатить ОДИН блок файла в рабочем дереве: обратный патч прикладывается без
   * `--cached` — правка исчезает из файла, но индекс не трогается. Это и есть
   * «отменить это изменение» из жёлоба. Блок берётся из diff рабочего дерева
   * против индекса: откатывать имеет смысл только то, чего ещё нет в индексе.
   */
  async discardHunk(filePath: string, index: number): Promise<GitStatus> {
    const { repoRoot, relative } = await this.locateHunk(filePath);
    const patch = hunkPatch(await this.rawDiff(relative, repoRoot, { staged: false }), index);
    if (!patch) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Блок изменений не найден');
    await this.applyToWorktree(patch, repoRoot);
    return this.refresh();
  }

  async unstage(paths: string[]): Promise<GitStatus> {
    const { repoRoot, relative } = await this.locate(paths);
    // `restore --staged` требует HEAD, а в репозитории без коммитов его нет —
    // там файл просто убирается из индекса.
    const result = await execGit(['restore', '--staged', '--', ...relative], repoRoot, { allowFailure: true });
    if (!result.ok) await execGit(['rm', '--cached', '-q', '--', ...relative], repoRoot);
    return this.refresh();
  }

  /**
   * Откат правок: у отслеживаемых файлов — к состоянию HEAD, у новых —
   * файл отправляется в корзину. Совсем удалять чужие файлы IDE не должна.
   */
  async discard(paths: string[]): Promise<GitStatus> {
    const status = await this.status();
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
      await shell.trashItem(file).catch(() => undefined);
    }

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
      original = await this.show(`${commit}:${relative}`, repoRoot);
      modified = await this.readText(absolute);
    } else {
      original = staged ? await this.show(`HEAD:${relative}`, repoRoot) : await this.show(`:${relative}`, repoRoot);
      modified = staged ? await this.show(`:${relative}`, repoRoot) : await this.readText(absolute);
    }

    // Границы блоков нужны интерфейсу: у каждого будет своя кнопка. Считаем из
    // того же diff, что приложит `git apply`, — тогда номера блоков совпадают.
    const hunks = hunkRanges(await this.rawDiff(relative, repoRoot, { staged, commit }));
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
    if (!filePath) return this.rawDiff('', repoRoot, { staged });

    const known = status.files.find((file) => file.path === path.resolve(filePath));
    if (!known) throw new RpcFailure(RpcErrorCode.NotFound, 'У файла нет изменений');

    return this.rawDiff(known.relative, repoRoot, { staged });
  }

  /**
   * Сравнение двух ссылок (веток, коммитов, тегов): что между ними изменилось.
   * Список файлов со статусом и счётчиком строк — его показывает экран «сравнить
   * ветки», а сам файл открывается уже своим сравнением (`diffRefs`).
   *
   * Запускаем ДВЕ команды вместо одной: `--name-status` говорит, что случилось с
   * файлом, `--numstat` — насколько. Обе с `-z`: тогда пути со спецсимволами
   * (пробел, кириллица, перевод строки в имени) не ломают разбор.
   */
  async compareRefs(base: string, head: string): Promise<GitRefDiff> {
    const repoRoot = await this.requireRoot();
    const left = this.refArg(base);
    const right = this.refArg(head);
    const names = await execGit(['diff', '--name-status', '-z', left, right], repoRoot);
    const stats = await execGit(['diff', '--numstat', '-z', left, right], repoRoot);
    return { base: left, head: right, files: mergeRefDiff(names.stdout, stats.stdout) };
  }

  /**
   * Сравнение ОДНОГО файла между двумя ссылками: слева содержимое из `base`,
   * справа — из `head`. Блоки не считаем: части правки между ветками индексировать
   * нечего — это просмотр, а не подготовка коммита.
   */
  async diffRefs(base: string, head: string, filePath: string): Promise<GitDiff> {
    const repoRoot = await this.requireRoot();
    const left = this.refArg(base);
    const right = this.refArg(head);
    // Путь приходит абсолютным (как у остальных сравнений) — git же в `ref:путь`
    // хочет путь от корня репозитория. Уже относительный оставляем как есть.
    const relative = path.isAbsolute(filePath) ? path.relative(repoRoot, path.resolve(filePath)) : filePath;
    const target = this.refArg(relative.split(path.sep).join('/'));
    const [original, modified] = await Promise.all([
      this.show(`${left}:${target}`, repoRoot),
      this.show(`${right}:${target}`, repoRoot),
    ]);
    return { original, modified, hunks: [] };
  }

  /** Контекст для модуля `inspect`: три колбэка, состояние класса наружу не идёт. */
  private inspectContext(): InspectContext {
    return {
      repositoryRoot: () => this.repositoryRoot(),
      requireRoot: () => this.requireRoot(),
      refresh: () => this.refresh(),
    };
  }

  /* ── пошаговый поиск багованного коммита (bisect) ──────────────────────── */

  private bisectContext(): BisectContext {
    return {
      root: () => this.requireRoot(),
      refresh: () => this.refresh(),
      gitPath: (repoRoot, name) => this.gitPath(repoRoot, name),
    };
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

  private refArg(value: string): string {
    return gitRefArg(value);
  }

  /** Сырой diff файла (контекст, цвет, внешний diff — см. diff-text.ts). */
  private rawDiff(relative: string, repoRoot: string, target: { staged: boolean; commit?: string }): Promise<string> {
    return gitRawDiff(relative, repoRoot, target);
  }

  /**
   * История коммитов текстом: hash, дата, автор, заголовок. Read-only — нужна
   * агенту, чтобы понять контекст, не вычитывая файл целиком. Поле `path`
   * ограничивает историю одним файлом.
   */
  async logText(limit = 20, filePath?: string): Promise<string> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

    const count = Math.min(Math.max(Math.round(limit) || 20, 1), 100);
    const args = ['log', `-n${count}`, '--date=short', '--format=%h %ad %an: %s'];
    if (filePath) args.push('--', path.relative(repoRoot, path.resolve(filePath)));

    // allowFailure: в репозитории без коммитов `git log` завершается ошибкой,
    // а это не сбой — просто истории ещё нет.
    const result = await execGit(args, repoRoot, { allowFailure: true });
    return result.ok ? result.stdout : '';
  }

  /**
   * История коммитов в виде записей: хеш, автор, дата, заголовок. Нужна списку
   * в интерфейсе — в отличие от `logText`, здесь поля разделены, а не собраны
   * в одну строку. Файл (`path`) ограничивает историю теми коммитами, что его трогали.
   */
  async log(limit = 50, filePath?: string): Promise<GitCommit[]> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

    const count = Math.min(Math.max(Math.round(limit) || 50, 1), 200);
    // Поля разделяем байтом US (0x1f), который git вставляет по `%x1f`: автор или
    // заголовок могут содержать пробелы и двоеточия, и печатный разделитель
    // рано или поздно совпал бы с текстом.
    // `%at` — время коммита секундами: по нему лента истории файла ставит коммиты и
    // снимки редактора в один порядок (`shared/timeline.ts`). Дата без времени для
    // этого груба: два коммита одного дня встали бы не по порядку.
    const args = ['log', `-n${count}`, '--date=short', '--format=%h%x1f%at%x1f%ad%x1f%an%x1f%s'];
    if (filePath) args.push('--', path.relative(repoRoot, path.resolve(filePath)));

    // allowFailure: в репозитории без коммитов `git log` завершается ошибкой,
    // а это не сбой — просто истории ещё нет.
    const result = await execGit(args, repoRoot, { allowFailure: true });
    if (!result.ok) return [];

    const commits: GitCommit[] = [];
    for (const line of result.stdout.split('\n')) {
      if (!line) continue;
      const [hash, seconds, date, author, ...rest] = line.split('\u001f');
      if (!hash || !date || !author) continue;
      const at = Number(seconds);
      commits.push({
        hash,
        date,
        author,
        summary: rest.join('\u001f'),
        ...(Number.isFinite(at) && at > 0 ? { at: at * 1000 } : {}),
      });
    }
    return commits;
  }

  /**
   * Кто и когда менял строки файла. `range` ограничивает вывод строками — на
   * большом файле blame целиком никому не нужен. Пустой список — файл не
   * отслеживается или blame не сложился: это ответ, а не сбой.
   */
  async blame(filePath: string, range?: { startLine?: number; endLine?: number }): Promise<BlameLine[]> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

    // `-L` требует обе границы: если задана только одна, вторую берём из файла.
    const relative = path.relative(repoRoot, path.resolve(filePath));
    const args = ['blame', '--line-porcelain'];
    const start = range?.startLine;
    const end = range?.endLine;
    if (start !== undefined || end !== undefined) {
      args.push('-L', `${Math.max(start ?? 1, 1)},${Math.max(end ?? start ?? 1, 1)}`);
    }
    args.push('--', relative);

    const result = await execGit(args, repoRoot, { allowFailure: true });
    return result.ok ? parseBlamePorcelain(result.stdout) : [];
  }

  /**
   * Три версии конфликтного файла из индекса: общий предок и обе стороны.
   * Нет объекта в индексе (файл добавлен только одной стороной) — пустая строка:
   * для интерфейса это «сравнивать не с чем», а не ошибка.
   */
  async conflictParts(filePath: string): Promise<GitConflictParts> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

    const relative = path.relative(repoRoot, path.resolve(filePath));
    const [base, ours, theirs] = await Promise.all([
      this.show(`:1:${relative}`, repoRoot),
      this.show(`:2:${relative}`, repoRoot),
      this.show(`:3:${relative}`, repoRoot),
    ]);
    return { base, ours, theirs };
  }

  /**
   * Отметить конфликт решённым: содержимое рабочего файла уходит в индекс.
   * Отдельно от `stage`: `add -A` тронул бы и соседние пути, а тут нужен ровно этот.
   */
  async markResolved(filePath: string): Promise<GitStatus> {
    const { repoRoot, relative } = await this.locateHunk(filePath);
    await execGit(['add', '--', relative], repoRoot);
    return this.refresh();
  }

  async branches(): Promise<GitBranch[]> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) return [];

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
      if (!name || name.endsWith('/HEAD')) continue;
      parsed.push({ name, current: false, remote: true });
    }

    return parsed.sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      if (a.remote !== b.remote) return a.remote ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  }

  async checkout(name: string, create = false): Promise<GitStatus> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

    const branch = name.trim();
    if (!branch) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Пустое имя ветки');
    await execGit(create ? ['checkout', '-b', branch] : ['checkout', branch], repoRoot);
    return this.refresh();
  }

  /**
   * Удалённые репозитории: имя и адреса. Из `git remote -v` собираем карту по
   * имени — одна строка на `(fetch)`, одна на `(push)`.
   */
  async remotes(): Promise<GitRemote[]> {
    const repoRoot = await this.repositoryRoot();
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
  async fetch(): Promise<GitNetworkResult> {
    return this.network(['fetch', '--all', '--prune']);
  }

  /**
   * Забрать изменения во ВСЕХ корнях области, а не только в активном. В многообласти
   * папки — разные репозитории, и «обновить всё» одним нажатием удобнее, чем
   * переключать корень на каждую. Папка без репозитория или с недоступным remote
   * не губит остальные: по каждой отдаём свой итог.
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

  /**
   * Влить изменения из удалённого репозитория в текущую ветку. `mode` задаёт флаги:
   * слияние, перебазирование или только перемотка; `default` не подсказывает ничего —
   * git ведёт себя так, как настроен у человека.
   */
  async pull(mode: PullMode = 'default'): Promise<GitNetworkResult> {
    return this.network(['pull', '--no-edit', ...pullModeArgs(mode)]);
  }

  /**
   * Отправить коммиты в удалённый репозиторий.
   *
   * Первая отправка ветки ставит upstream (`-u origin <ветка>`): без него
   * следующий `push` и `pull` не знают, куда идут. Принудительную отправку делаем
   * через `--force-with-lease`, а не `--force`: она не затрёт чужие коммиты,
   * если удалённая ветка уехала вперёд, — то есть страхует от чужой работы.
   */
  async push(options: { setUpstream?: boolean; force?: boolean } = {}): Promise<GitNetworkResult> {
    // Одна команда вместо цепочки «статус → проверка upstream → push»: каждый
    // запуск процесса стоит времени, а git отдаёт нужное сам. `%00` разделяет
    // поля, потому что имя ветки может содержать что угодно, кроме NUL.
    //
    // Отдельно про detached HEAD: `%(refname:short)` для него пуст, а не «HEAD» —
    // пустое имя git отвергнет сам (`fatal: dst refspec ... does not match any`),
    // и это честнее нашего прежнего отказа. Ветку берём из `symbolic-ref`: он
    // отвечает «не ветка» кодом, а не пустой строкой, которую нельзя отличить
    // от ошибки запуска.
    const repoRoot = await this.requireRoot();
    const head = await execGit(['symbolic-ref', '--short', '-q', 'HEAD'], repoRoot, { allowFailure: true });
    if (!head.ok || !head.stdout.trim()) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, 'HEAD оторван (detached): нечего отправлять');
    }
    const branch = head.stdout.trim();
    const probe = await execGit(['config', '--get', `branch.${branch}.remote`], repoRoot, { allowFailure: true });
    const args = ['push'];
    if (options.force) args.push('--force-with-lease');
    if (options.setUpstream || !probe.stdout.trim()) args.push('-u', 'origin', branch);
    return this.network(args);
  }

  /**
   * Клонирование в новую папку. Прогресс git пишет в stderr, поэтому нужен
   * поток, а не буферизованный вызов: иначе пользователь видит только тишину.
   */
  async clone(url: string, directory: string, onProgress?: (line: string) => void): Promise<{ path: string }> {
    const link = url.trim();
    if (!link) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Пустой адрес репозитория');

    const target = path.resolve(directory);
    const existing = await fs.stat(target).catch(() => null);
    if (existing) throw new RpcFailure(RpcErrorCode.InvalidParams, `Папка уже существует: ${target}`);
    await fs.mkdir(path.dirname(target), { recursive: true });

    await this.stream(['clone', '--progress', link, target], path.dirname(target), onProgress);
    return { path: target };
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

  /** Список записей stash: свежая — первой. */
  async stashList(): Promise<GitStashEntry[]> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) return [];
    const result = await execGit(['stash', 'list', '--format=%gd%x1f%gs'], repoRoot, { allowFailure: true });
    return parseStashList(result.stdout);
  }

  /**
   * Отложить текущие правки. `git stash push` без изменений ничего не делает
   * и завершается успешно — это не сбой, а пустой результат.
   */
  async stashSave(options: { message?: string; includeUntracked?: boolean } = {}): Promise<GitStatus> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

    const args = ['stash', 'push'];
    if (options.includeUntracked) args.push('--include-untracked');
    const message = options.message?.trim();
    if (message) args.push('-m', message);
    await execGit(args, repoRoot);
    return this.refresh();
  }

  /** Применить запись, оставив её в списке. */
  async stashApply(index: number): Promise<GitStatus> {
    return this.stashOp('apply', index);
  }

  /** Применить запись и убрать из списка. */
  async stashPop(index: number): Promise<GitStatus> {
    return this.stashOp('pop', index);
  }

  /** Удалить запись, не трогая рабочее дерево. */
  async stashDrop(index: number): Promise<GitStatus> {
    return this.stashOp('drop', index);
  }

  /** Полный патч записи — содержимое для просмотра. */
  async stashShow(index: number): Promise<string> {
    const { repoRoot, ref } = await this.locateStash(index);
    const result = await execGit(['stash', 'show', '-p', '--no-color', '--no-ext-diff', ref], repoRoot, {
      allowFailure: true,
    });
    // Пусто — в записи нет правок отслеживаемых файлов (бывают только новые):
    // скажем это словами, а не пустым экраном.
    return result.stdout.trim() ? result.stdout : 'В этой записи нет правок отслеживаемых файлов.';
  }

  private async stashOp(op: 'apply' | 'pop' | 'drop', index: number): Promise<GitStatus> {
    const { repoRoot, ref } = await this.locateStash(index);
    await execGit(['stash', op, ref], repoRoot);
    return this.refresh();
  }

  /** Проверить номер записи и получить её ссылку. */
  private async locateStash(index: number): Promise<{ repoRoot: string; ref: string }> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');
    if (!Number.isInteger(index) || index < 0) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, 'Номер записи stash — целое число, начиная с нуля');
    }
    return { repoRoot, ref: `stash@{${index}}` };
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
   * Интерактивный rebase последних `count` коммитов.
   *
   * `git rebase -i` открывает редактор со списком шагов. Мы редактор не показываем,
   * а подставляем свой: маленький скрипт, который кладёт на место файла git наш
   * готовый список (`CHUI_REBASE_TODO`). Тем же приёмом подменяем редактор сообщений:
   * он нужен для `reword` — по исходному тексту коммита подставляет новое сообщение.
   * Скрипты пишем во временный каталог и запускаем тем же Node, что и IDE
   * (`process.execPath` + `ELECTRON_RUN_AS_NODE`), — тогда не зависим от того, есть ли
   * `node`/`sh` в PATH у пользователя.
   */
  async rebase(count: number, items: readonly RebaseTodoItem[]): Promise<GitRebaseResult> {
    const repoRoot = await this.requireRoot();
    const invalid = validateRebaseTodo(items);
    if (invalid) throw new RpcFailure(RpcErrorCode.InvalidParams, invalid);
    const depth = Math.max(Math.trunc(count), 1);
    const head = await execGit(['rev-parse', '--verify', `HEAD~${depth}`], repoRoot, { allowFailure: true });
    if (!head.ok) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, 'В ветке меньше коммитов, чем выбрано для перестройки');
    }

    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-rebase-'));
    try {
      // Сообщения для `reword`: редактор git видит только текст коммита, поэтому
      // сопоставляем по нему — исходное сообщение → новое.
      const originals = await this.commitMessages(repoRoot, depth);
      const messages: Record<string, string> = {};
      for (const item of items) {
        if (item.action !== 'reword' || !item.message?.trim()) continue;
        const original = originals.get(item.commit) ?? originals.get(await this.fullHash(repoRoot, item.commit));
        if (original) messages[original.trimEnd()] = item.message;
      }

      const todoPath = path.join(work, 'todo.txt');
      const messagesPath = path.join(work, 'messages.json');
      const sequenceEditor = path.join(work, 'sequence-editor.cjs');
      const messageEditor = path.join(work, 'message-editor.cjs');
      await fs.writeFile(todoPath, formatRebaseTodo(items), 'utf8');
      await fs.writeFile(messagesPath, JSON.stringify(messages), 'utf8');
      await fs.writeFile(sequenceEditor, SEQUENCE_EDITOR_SCRIPT, 'utf8');
      await fs.writeFile(messageEditor, MESSAGE_EDITOR_SCRIPT, 'utf8');

      const runner = this.editorCommand(sequenceEditor);
      const result = await execGit(['rebase', '-i', `HEAD~${depth}`], repoRoot, {
        allowFailure: true,
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          CHUI_REBASE_TODO: todoPath,
          CHUI_REBASE_MESSAGES: messagesPath,
          GIT_SEQUENCE_EDITOR: runner,
          GIT_EDITOR: this.editorCommand(messageEditor),
        },
      });
      return this.rebaseOutcome(repoRoot, result);
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Продолжить остановленный rebase (конфликт разрешён или `edit` закончен). */
  async rebaseContinue(): Promise<GitRebaseResult> {
    const repoRoot = await this.requireRoot();
    // Редактор сообщений тут не нужен: git берёт готовое сообщение (или уже поправленное).
    const result = await execGit(['rebase', '--continue'], repoRoot, { allowFailure: true });
    return this.rebaseOutcome(repoRoot, result);
  }

  /** Пропустить текущий коммит остановленного rebase. */
  async rebaseSkip(): Promise<GitRebaseResult> {
    const repoRoot = await this.requireRoot();
    const result = await execGit(['rebase', '--skip'], repoRoot, { allowFailure: true });
    return this.rebaseOutcome(repoRoot, result);
  }

  /** Прервать rebase: ветка возвращается туда, где была до запуска. */
  async rebaseAbort(): Promise<GitStatus> {
    const repoRoot = await this.requireRoot();
    await execGit(['rebase', '--abort'], repoRoot);
    return this.refresh();
  }

  /**
   * Итог операции rebase. Rebase не всегда завершается: он останавливается на
   * конфликте или на шаге `edit`, и тогда нужно знать, что он ещё идёт (`.git/rebase-merge`),
   * и есть ли неразрешённые конфликты в индексе.
   */
  private async rebaseOutcome(repoRoot: string, result: GitResult): Promise<GitRebaseResult> {
    const status = await this.refresh();
    const inProgress = await this.rebaseInProgress(repoRoot);
    const conflict = await this.hasConflicts(repoRoot);
    const text = (result.stderr.trim() || result.stdout.trim()).trim();
    const message = text || (result.ok && !inProgress ? 'Rebase завершён' : 'Rebase не выполнен');
    return { ok: result.ok && !inProgress, inProgress, conflict, message, status };
  }

  /** Идёт ли rebase прямо сейчас: git держит своё состояние в каталоге `.git`. */
  private async rebaseInProgress(repoRoot: string): Promise<boolean> {
    const gitDir = await this.gitPath(repoRoot, 'rebase-merge');
    const applyDir = await this.gitPath(repoRoot, 'rebase-apply');
    for (const dir of [gitDir, applyDir]) {
      const stat = dir ? await fs.stat(dir).catch(() => null) : null;
      if (stat?.isDirectory()) return true;
    }
    return false;
  }

  /** Есть ли в индексе неразрешённые конфликты (`git ls-files -u`). */
  private async hasConflicts(repoRoot: string): Promise<boolean> {
    const result = await execGit(['ls-files', '-u'], repoRoot, { allowFailure: true });
    return result.ok && result.stdout.trim() !== '';
  }

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

  /** Полные сообщения последних `depth` коммитов: ключ — хеш, значение — текст целиком. */
  private async commitMessages(repoRoot: string, depth: number): Promise<Map<string, string>> {
    const result = await execGit(['log', `-n`, String(depth), '--no-color', '--format=%H%x1f%B%x1e'], repoRoot, {
      allowFailure: true,
    });
    const map = new Map<string, string>();
    if (!result.ok) return map;
    for (const record of result.stdout.split('\u001e')) {
      const cut = record.indexOf('\u001f');
      if (cut === -1) continue;
      const hash = record.slice(0, cut).trim();
      const body = record.slice(cut + 1).replace(/^\n/, '');
      if (hash) map.set(hash, body);
    }
    return map;
  }

  /** Полный хеш по короткому: редактор сообщений сопоставляет по исходному тексту. */
  private async fullHash(repoRoot: string, commit: string): Promise<string> {
    const result = await execGit(['rev-parse', '--verify', this.commitArg(commit)], repoRoot, {
      allowFailure: true,
    });
    return result.ok ? result.stdout.trim() : '';
  }

  /**
   * Команда-редактор для git: наш Node плюс путь к скрипту, каждый — в кавычках.
   * git запускает редактор через `sh -c '<команда> "$@"'`, поэтому кавычки нужны
   * свои: путь может содержать пробелы (временный каталог на Windows — часто так).
   */
  private editorCommand(scriptPath: string): string {
    return `"${process.execPath}" "${scriptPath}"`;
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
   * Удалить ветку. `force` — когда git отказывается: ветка не влита, а человек
   * всё равно настаивает (это его выбор, но предупредить должно быть в UI).
   */
  async deleteBranch(name: string, force = false): Promise<GitStatus> {
    const repoRoot = await this.requireRoot();
    await execGit(['branch', force ? '-D' : '-d', this.nameArg(name)], repoRoot);
    return this.refresh();
  }

  /** Переименовать ветку (у текущей — без указания старого имени). */
  async renameBranch(from: string, to: string): Promise<GitStatus> {
    const repoRoot = await this.requireRoot();
    await execGit(['branch', '-m', this.nameArg(from), this.nameArg(to)], repoRoot);
    return this.refresh();
  }

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
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) return [];
    const result = await execGit(['submodule', 'status'], repoRoot, { allowFailure: true });
    return result.ok ? parseSubmodules(result.stdout) : [];
  }

  /** Забрать код подмодулей: `git submodule update --init --recursive`. */
  async submoduleUpdate(): Promise<GitStatus> {
    const repoRoot = await this.requireRoot();
    await execGit(['submodule', 'update', '--init', '--recursive'], repoRoot, {
      timeout: NETWORK_TIMEOUT_MS,
    });
    return this.refresh();
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
    return {
      root: () => this.requireRoot(),
      repositoryRoot: (explicit?: string) => this.repositoryRoot(explicit),
      remotes: () => this.remotes(),
      refresh: () => this.refresh(),
    };
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

  /**
   * Открытые ключи из `~/.ssh`. Ими работают с удалёнными репозиториями, а с git
   * 2.34 — и подписывают коммиты (`gpg.format=ssh`).
   */
  async sshKeys(): Promise<GitSshKey[]> {
    const dir = path.join(os.homedir(), '.ssh');
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    const keys: GitSshKey[] = [];
    for (const name of entries) {
      if (!name.endsWith('.pub')) continue;
      const full = path.join(dir, name);
      const text = await fs.readFile(full, 'utf8').catch(() => '');
      const parsed = parseSshPublicKey(text);
      if (!parsed) continue;
      keys.push({
        path: full,
        type: parsed.type,
        comment: parsed.comment,
        fingerprint: await this.sshFingerprint(full),
        publicKey: text.trim(),
      });
    }
    return keys.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Отпечаток ключа (`ssh-keygen -lf`). Нет ssh-keygen — пусто, а не отказ. */
  private async sshFingerprint(file: string): Promise<string> {
    const result = await this.tool('ssh-keygen', ['-l', '-f', file]);
    if (!result.ok) return '';
    // «256 SHA256:abcd… comment (ED25519)» — берём второй столбец.
    return result.stdout.trim().split(/\s+/)[1] ?? '';
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
    return new Promise((resolve) => {
      execFile(
        file,
        args,
        { timeout: GIT_TIMEOUT_MS, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
        (error, stdout, stderr) => {
          resolve({ ok: error === null, stdout: stdout ?? '', stderr: stderr ?? '' });
        },
      );
    });
  }

  /* ── разреженный рабочий каталог (sparse checkout) ─────────────── */

  /**
   * Что выложено на диск: включён ли разреженный режим и какие каталоги выбраны.
   * Читаем из конфига и `git sparse-checkout list`; своё состояние не держим — репозиторий
   * могли настроить и мимо IDE (в терминале).
   */
  async sparseInfo(): Promise<GitSparseInfo> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

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

  /**
   * Задать набор каталогов (cone-режим). Заменяет прежний набор целиком:
   * `git sparse-checkout set` выкладывает только перечисленное и корень.
   * Пустой набор — ошибка: выключение режима отдельная операция (`sparseDisable`),
   * а не вероятно забытый аргумент.
   */
  async sparseSet(directories: readonly string[]): Promise<GitSparseInfo> {
    const repoRoot = await this.requireRoot();
    const dirs = this.cleanDirectories(directories);
    if (dirs.length === 0) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Не выбран ни один каталог');
    await execGit(['sparse-checkout', 'set', '--cone', '--', ...dirs], repoRoot);
    return this.sparseInfo();
  }

  /** Добавить каталог к текущему набору (`git sparse-checkout add`). */
  async sparseAdd(directory: string): Promise<GitSparseInfo> {
    const repoRoot = await this.requireRoot();
    const clean = normalizeSparseDirectory(directory);
    if (clean === null) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Негодный путь каталога');
    await execGit(['sparse-checkout', 'add', '--', clean], repoRoot);
    return this.sparseInfo();
  }

  /** Выключить разреженный режим: на диск возвращается весь репозиторий. */
  async sparseDisable(): Promise<GitSparseInfo> {
    const repoRoot = await this.requireRoot();
    await execGit(['sparse-checkout', 'disable'], repoRoot);
    return this.sparseInfo();
  }

  /** Привести список каталогов к виду git: без повторов и мусора. */
  private cleanDirectories(directories: readonly string[]): string[] {
    const out: string[] = [];
    for (const item of directories) {
      const clean = normalizeSparseDirectory(item);
      if (clean === null || out.includes(clean)) continue;
      out.push(clean);
    }
    return out;
  }

  /* ── Git LFS (хранение больших файлов) ─────────────────────────────────── */

  /**
   * Что знает репозиторий про LFS: доступен ли `git lfs`, какие шаблоны заданы и
   * какие файлы ведёт хранилище. Без git-lfs не ошибка: окно LFS честно скажет, что
   * инструмент не найден, и предложит его поставить.
   */
  async lfsInfo(): Promise<GitLfsInfo> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

    // Шаблоны читаем с диска: они нужны и когда сам git-lfs не установлен.
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

  /** Взять шаблон под LFS: `git lfs track` дописывает строку в `.gitattributes`. */
  async lfsTrack(pattern: string): Promise<GitLfsInfo> {
    const repoRoot = await this.requireRoot();
    const clean = normalizeLfsPattern(pattern);
    if (clean === '' || /\s/.test(clean)) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, 'Шаблон не должен быть пустым или содержать пробелы');
    }
    await execGit(['lfs', 'track', '--', clean], repoRoot);
    return this.lfsInfo();
  }

  /** Перестать вести шаблон через LFS (`git lfs untrack`). Сами файлы не трогаются. */
  async lfsUntrack(pattern: string): Promise<GitLfsInfo> {
    const repoRoot = await this.requireRoot();
    const clean = normalizeLfsPattern(pattern);
    if (clean === '') throw new RpcFailure(RpcErrorCode.InvalidParams, 'Пустой шаблон');
    await execGit(['lfs', 'untrack', '--', clean], repoRoot);
    return this.lfsInfo();
  }

  /** Подтянуть содержимое LFS-файлов (`git lfs pull`) — как fetch, только для больших файлов. */
  async lfsPull(): Promise<GitLfsInfo> {
    const repoRoot = await this.requireRoot();
    await execGit(['lfs', 'pull'], repoRoot, { timeout: NETWORK_TIMEOUT_MS });
    return this.lfsInfo();
  }

  /** Подготовить репозиторий к LFS: `git lfs install --local` (ставит хуки). */
  async lfsInstall(): Promise<GitLfsInfo> {
    const repoRoot = await this.requireRoot();
    await execGit(['lfs', 'install', '--local'], repoRoot);
    return this.lfsInfo();
  }

  /* ── дополнительные рабочие каталоги (worktree) ───────────────────────── */

  /** Список рабочих каталогов репозитория: главный и добавленные. */
  async worktrees(): Promise<GitWorktree[]> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) return [];
    const result = await execGit(['worktree', 'list', '--porcelain'], repoRoot, { allowFailure: true });
    // git отдаёт пути со слэшами ВСЕГДА, даже на Windows. Приводим к разделителям
    // платформы: иначе путь не совпадёт с тем, что дают fs и остальное приложение.
    return result.ok ? parseWorktrees(result.stdout).map((item) => ({ ...item, path: path.normalize(item.path) })) : [];
  }

  /**
   * Добавить рабочий каталог. С `branch` существующей веткой — выложим её; с
   * `newBranch` — создадим ветку в новом каталоге. Без них — отделённый указатель.
   */
  async worktreeAdd(target: string, options: { branch?: string; newBranch?: string } = {}): Promise<GitWorktree[]> {
    const repoRoot = await this.requireRoot();
    const directory = target.trim();
    if (!directory) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Не задан путь рабочего каталога');
    const args = ['worktree', 'add'];
    if (options.newBranch) args.push('-b', this.nameArg(options.newBranch));
    args.push(directory);
    if (options.branch) args.push(this.nameArg(options.branch));
    await execGit(args, repoRoot, { timeout: NETWORK_TIMEOUT_MS });
    return this.worktrees();
  }

  /** Удалить рабочий каталог. `force` — когда в нём есть незакоммиченные правки. */
  async worktreeRemove(target: string, force = false): Promise<GitWorktree[]> {
    const repoRoot = await this.requireRoot();
    // Путь начинается с дефиса? Тогда за него примет git — подстрахуемся `--`.
    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push('--', target);
    await execGit(args, repoRoot);
    return this.worktrees();
  }

  /** Убрать записи о каталогах, которых уже нет на диске. */
  async worktreePrune(): Promise<GitWorktree[]> {
    const repoRoot = await this.requireRoot();
    await execGit(['worktree', 'prune'], repoRoot);
    return this.worktrees();
  }

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

  /** Журнал ссылок: свежие записи — первыми. */
  async reflog(limit = 50): Promise<GitReflogEntry[]> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) return [];
    const result = await execGit(
      ['reflog', '--date=short', '-n', String(Math.max(Math.trunc(limit), 1)), '--format=%h%x1f%gd%x1f%ad%x1f%gs'],
      repoRoot,
      { allowFailure: true },
    );
    const entries = parseReflog(result.stdout);
    // `--date=short` превращает селектор в `HEAD@{2026-10-12}`, а нам нужна ссылка
    // на запись: берём номер по порядку вывода — он же и есть её индекс у git.
    return entries.map((entry, index) => ({ ...entry, ref: `HEAD@{${index}}` }));
  }

  /**
   * История в виде графа веток — текстом, как её рисует сам git. Свой разбор
   * графа не делаем: `--graph` рисует ASCII-схему, а её проще показать как есть,
   * чем воспроизводить колонки и связи своим кодом.
   */
  async logGraph(limit = 100): Promise<string> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) return '';
    const result = await execGit(
      ['log', '--graph', '--oneline', '--decorate', '--all', '-n', String(Math.max(Math.trunc(limit), 1))],
      repoRoot,
      { allowFailure: true },
    );
    return result.stdout;
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
    return {
      repositoryRoot: (explicit?: string) => this.repositoryRoot(explicit),
      refresh: () => this.refresh(),
    };
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

  private locate(paths: string[]): Promise<{ repoRoot: string; relative: string[] }> {
    return locatePaths(() => this.status(), paths);
  }

  private locateHunk(filePath: string): Promise<{ repoRoot: string; relative: string }> {
    return locateFile(() => this.status(), filePath);
  }

  private applyToIndex(patch: string, repoRoot: string, reverse: boolean): Promise<void> {
    return gitApplyToIndex(patch, repoRoot, reverse);
  }

  private applyToWorktree(patch: string, repoRoot: string): Promise<void> {
    return gitApplyToWorktree(patch, repoRoot);
  }

  private show(spec: string, cwd: string): Promise<string> {
    return showFile(spec, cwd);
  }

  private readText(absolute: string): Promise<string> {
    return readFileText(absolute);
  }

  /**
   * Долгая операция с построчным выводом: прогресс и ошибки приходят из stderr,
   * причём прогресс-строки разделены не переводом строки, а возвратом каретки.
   */
  private stream(args: string[], cwd: string, onLine?: (line: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['--no-optional-locks', '-c', 'core.quotepath=false', ...args], {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_EDITOR: 'true',
          GIT_PAGER: 'cat',
        },
      });

      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new RpcFailure(RpcErrorCode.Internal, 'git не ответил за 10 минут'));
      }, CLONE_TIMEOUT_MS);

      let rest = '';
      const feed = (chunk: string): void => {
        rest += chunk;
        const lines = rest.split(/\r?\n|\r/);
        rest = lines.pop() ?? '';
        for (const line of lines) {
          const text = line.trim();
          if (text) onLine?.(text);
        }
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(new RpcFailure(RpcErrorCode.Internal, `git: ${error.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new RpcFailure(RpcErrorCode.Internal, `git ${args[0]} завершился с кодом ${code}`, rest.trim()));
      });
    });
  }
}
