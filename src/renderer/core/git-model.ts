import {
  PushTopic,
  type GitBranch,
  type GitCommit,
  type GitCommitInfo,
  type GitConflictParts,
  type GitCommitDiff,
  type GitFileHunks,
  type GitDiff,
  type GitFileStatus,
  type GitNetworkResult,
  type GitRebaseResult,
  type GitRemote,
  type GitStatus,
} from '../../shared/api';
import type { BlameLine } from '../../shared/git-blame';
import type { GitReflogEntry } from '../../shared/git-reflog';
import type { GitStashEntry } from '../../shared/git-stash';
import type { GitTag } from '../../shared/git-tags';
import type { RebaseTodoItem } from '../../shared/git-rebase';
import type { PullMode } from '../../shared/git-pull';
import type { GitRefDiff } from '../../shared/git-ref-diff';
import type { GitBisectState } from '../../shared/git-bisect';
import type { GitSubmodule } from '../../shared/git-submodules';
import type { GitWorktree } from '../../shared/git-worktrees';
import type { GitLfsInfo } from '../../shared/git-lfs';
import type { GitIdentity, GitSshKey } from '../../shared/git-identity';
import type { ProjectPackage } from '../../shared/monorepo';
import type { ForgeInfo } from '../../shared/git-platform';
import type { GitRootSummary } from '../../shared/git-multiroot';
import { Emitter } from './events';
import { separatorOf } from '../../shared/paths';
import { deletedInFolder } from '../../shared/git-deleted';
import type { RpcClient } from './rpc';
import type { WorkspaceModel } from './workspace-model';

const EMPTY: GitStatus = { repository: null, files: [] };

/**
 * Что показывать у папки, внутри которой есть правки: сколько их и какая из них
 * самая заметная. Порядок важен: конфликт и удаление — важнее правки, а новая
 * папка внутри свёрнутой должна читаться как добавленное, а не как изменённое.
 */
export interface GitInsideChange {
  count: number;
  change: GitFileStatus['change'];
}

const CHANGE_WEIGHT: Record<GitFileStatus['change'], number> = {
  modified: 0,
  untracked: 1,
  added: 2,
  renamed: 3,
  deleted: 4,
  conflicted: 5,
};

/**
 * Правки, разложенные по папкам-родителям: для каждой — сколько внутри файлов
 * с правками и какая из них самая заметная. Чистая функция: считается по списку
 * файлов, без состояния модели, поэтому проверяется в тестах.
 *
 * Пути приходят от main в родных разделителях (`path.join`), и дерево ключует
 * папки тем же путём. Режем по обоим разделителям, а собираем обратно тем, что
 * был в пути: резать только по «/» значило бы на Windows не найти ни одной папки.
 */
export function changeInsideFolders(files: readonly GitFileStatus[]): Map<string, GitInsideChange> {
  const inside = new Map<string, GitInsideChange>();
  for (const file of files) {
    // Режем по обоим разделителям, собираем обратно родным для пути: с жёстким «/»
    // на Windows папок не находилось вовсе.
    const separator = separatorOf(file.path);
    const parts = file.path.split(/[/\\]/);
    // depth начинается с 2: нулевой сегмент — корень («») или диск («C:»),
    // папкой он не считается, а `parts.slice(0, 2)` — уже первая настоящая папка.
    for (let depth = 2; depth < parts.length; depth += 1) {
      const folder = parts.slice(0, depth).join(separator);
      const known = inside.get(folder);
      inside.set(folder, {
        count: (known?.count ?? 0) + 1,
        change: known && CHANGE_WEIGHT[known.change] > CHANGE_WEIGHT[file.change] ? known.change : file.change,
      });
    }
  }
  return inside;
}

/**
 * Снимок состояния репозитория для renderer.
 *
 * Источник истины — main: он присылает статус push-событием после каждой
 * операции, а модель держит последний снимок и раскладывает файлы по путям,
 * чтобы дереву и панели изменений не приходилось искать их самим.
 */
export class GitModel {
  private snapshot: GitStatus = EMPTY;
  private readonly byPath = new Map<string, GitFileStatus>();
  private readonly insideByFolder = new Map<string, GitInsideChange>();

  private readonly emitter = new Emitter<GitStatus>();
  readonly onDidChange = this.emitter.event;

  /**
   * Сводка по всем корням области: в многообласти их несколько, и правки могут
   * быть в неактивной папке. Обновляется по push, а в обычном проекте пуста —
   * там хватает статуса активного корня.
   */
  private summaries: GitRootSummary[] = [];
  private readonly summaryEmitter = new Emitter<GitRootSummary[]>();
  readonly onDidChangeSummary = this.summaryEmitter.event;

  constructor(
    private readonly rpc: RpcClient,
    workspace: WorkspaceModel,
  ) {
    rpc.onPush((message) => {
      if (message.topic === PushTopic.GitChanged) this.apply(message.payload as GitStatus);
      else if (message.topic === PushTopic.GitSummary) this.applySummary(message.payload as GitRootSummary[]);
    });
    // Другая рабочая папка — другой репозиторий: прежние пометки к ней не относятся.
    workspace.onDidChange(() => {
      void this.refresh();
      void this.refreshSummary();
    });
  }

  /** Сводки по корням области (последний снимок от main). */
  get rootSummaries(): readonly GitRootSummary[] {
    return this.summaries;
  }

  get repository(): GitStatus['repository'] {
    return this.snapshot.repository;
  }

  get isRepository(): boolean {
    return this.snapshot.repository !== null;
  }

  get branch(): string | null {
    return this.snapshot.repository?.branch ?? null;
  }

  /** Файлы с правками в индексе: именно они попадут в коммит. */
  get staged(): GitFileStatus[] {
    return this.snapshot.files.filter((file) => file.staged);
  }

  /** Файлы с правками вне индекса. */
  get unstaged(): GitFileStatus[] {
    return this.snapshot.files.filter((file) => file.unstaged);
  }

  get changeCount(): number {
    return this.snapshot.files.length;
  }

  statusOf(path: string): GitFileStatus | undefined {
    return this.byPath.get(path);
  }

  /**
   * Удалённые, но ещё не закоммиченные файлы, лежащие прямо в папке. В дереве их
   * иначе не видно: оно читает диск, а файла там уже нет — хотя правка (удаление)
   * есть, и о ней стоит знать. Пути здесь абсолютные, как и везде в дереве.
   */
  deletedIn(dir: string): GitFileStatus[] {
    return deletedInFolder(this.snapshot.files, dir);
  }

  /**
   * Правки внутри папки — для свёрнутого дерева: файла не видно, а понять, что
   * в папке что-то меняли, нужно. Сам файл сюда же попадает, но дерево
   * спрашивает только про папки.
   */
  changeInside(path: string): GitInsideChange | undefined {
    return this.insideByFolder.get(path);
  }

  /* ── операции: каждая возвращает свежий статус и рассылает его подписчикам ── */

  async refresh(): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.status'));
  }

  /** Блоки изменений файла: действия прямо из жёлоба редактора (индексировать, убрать, откатить). */
  fileHunks(path: string): Promise<GitFileHunks> {
    return this.rpc.request('git.fileHunks', { path });
  }

  /** Откатить ОДИН блок файла в рабочем дереве. */
  async discardHunk(path: string, index: number): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.discardHunk', { path, index }));
  }

  /** Diff будущего коммита: из него модель собирает сообщение (см. `git.generateCommitMessage`). */
  commitDiff(): Promise<GitCommitDiff> {
    return this.rpc.request('git.commitDiff');
  }

  /** Пересчитать сводку по всем корням области: неактивные папки она видит тоже. */
  async refreshSummary(): Promise<GitRootSummary[]> {
    return this.applySummary(await this.rpc.request('git.summary'));
  }

  async init(): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.init'));
  }

  async stage(paths: string[]): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.stage', { paths }));
  }

  async unstage(paths: string[]): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.unstage', { paths }));
  }

  async discard(paths: string[]): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.discard', { paths }));
  }

  async commit(message: string, paths?: string[], amend = false): Promise<GitCommitInfo> {
    const info = await this.rpc.request('git.commit', { message, paths, amend });
    await this.refresh();
    return info;
  }

  diff(path: string, staged = false, commit?: string): Promise<GitDiff> {
    return this.rpc.request('git.diff', { path, staged, commit });
  }

  /** Происхождение строк файла: кто и когда их менял. `range` — только эти строки. */
  blame(path: string, range?: { startLine?: number; endLine?: number }): Promise<BlameLine[]> {
    return this.rpc.request('git.blame', { path, startLine: range?.startLine, endLine: range?.endLine });
  }

  /** История коммитов: без пути — всего репозитория, с путём — только трогавшие файл. */
  log(path?: string, limit = 50): Promise<GitCommit[]> {
    return this.rpc.request('git.log', { path, limit });
  }

  /** Содержимое файла в HEAD — база для полосок изменений в жёлобе. */
  headText(path: string): Promise<string | null> {
    return this.rpc.request('git.headText', { path });
  }

  /* ── отложенные изменения (stash) ─────────────────────────────────────── */

  /** Список записей stash: свежая — первой. */
  stashList(): Promise<GitStashEntry[]> {
    return this.rpc.request('git.stashList');
  }

  /** Отложить текущие правки; при `includeUntracked` в запись попадут и новые файлы. */
  async stashSave(options: { message?: string; includeUntracked?: boolean } = {}): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.stashSave', options));
  }

  /** Применить запись, оставив её в списке. */
  async stashApply(index: number): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.stashApply', { index }));
  }

  /** Применить запись и убрать из списка. */
  async stashPop(index: number): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.stashPop', { index }));
  }

  /** Удалить запись, не трогая рабочее дерево. */
  async stashDrop(index: number): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.stashDrop', { index }));
  }

  /** Полный патч записи — содержимое для просмотра. */
  stashShow(index: number): Promise<string> {
    return this.rpc.request('git.stashShow', { index });
  }

  /* ── отдельные коммиты и теги ─────────────────────────────────────────── */

  /** Перенести один коммит в текущую ветку. */
  async cherryPick(commit: string): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.cherryPick', { commit }));
  }

  /** Отменить один коммит новым коммитом с обратными правками. */
  async revert(commit: string): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.revert', { commit }));
  }

  /** Передвинуть ветку на коммит: soft, mixed или hard. */
  async reset(mode: 'soft' | 'mixed' | 'hard', commit: string): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.reset', { mode, commit }));
  }

  /**
   * Интерактивный rebase последних `count` коммитов. Модель применяет пришедший
   * статус, но НЕ считает операцию завершённой: rebase может остановиться на
   * конфликте или на шаге `edit` — это видно по `inProgress` в ответе.
   */
  async rebase(count: number, items: readonly RebaseTodoItem[]): Promise<GitRebaseResult> {
    const result = await this.rpc.request('git.rebase', { count, items: [...items] });
    this.apply(result.status);
    return result;
  }

  /** Продолжить остановленный rebase (конфликт разрешён или шаг `edit` закончен). */
  async rebaseContinue(): Promise<GitRebaseResult> {
    const result = await this.rpc.request('git.rebaseContinue');
    this.apply(result.status);
    return result;
  }

  /** Пропустить текущий коммит остановленного rebase. */
  async rebaseSkip(): Promise<GitRebaseResult> {
    const result = await this.rpc.request('git.rebaseSkip');
    this.apply(result.status);
    return result;
  }

  /** Прервать rebase: ветка возвращается туда, где была до запуска. */
  async rebaseAbort(): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.rebaseAbort'));
  }

  /** Список тегов репозитория. */
  tags(): Promise<GitTag[]> {
    return this.rpc.request('git.tags');
  }

  /** Поставить тег: с сообщением — аннотированный, без — лёгкий. */
  async createTag(name: string, options: { message?: string; commit?: string } = {}): Promise<GitStatus> {
    return this.apply(
      await this.rpc.request('git.createTag', { name, message: options.message, commit: options.commit }),
    );
  }

  /** Удалить тег из локального репозитория. */
  async deleteTag(name: string): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.deleteTag', { name }));
  }

  /** Отправить тег в origin. */
  async pushTag(name: string): Promise<GitNetworkResult> {
    return this.network(await this.rpc.request('git.pushTag', { name }));
  }

  /* ── ветки, .gitignore и журнал ссылок ────────────────────────────────── */

  /** Удалить ветку; `force` — когда она не влита, а удалить всё равно нужно. */
  async deleteBranch(name: string, force = false): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.deleteBranch', { name, force }));
  }

  /** Переименовать ветку. */
  async renameBranch(from: string, to: string): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.renameBranch', { from, to }));
  }

  /** Подмодули репозитория: дерево помечает их папки значком. */
  submodules(): Promise<GitSubmodule[]> {
    return this.rpc.request('git.submodules');
  }

  /** Забрать код подмодулей: `update --init --recursive`. */
  async submoduleUpdate(): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.submoduleUpdate'));
  }

  /** Список рабочих каталогов репозитория (главный и добавленные). */
  worktrees(): Promise<GitWorktree[]> {
    return this.rpc.request('git.worktrees');
  }

  /** Добавить рабочий каталог: существующая ветка, новая или отделённый указатель. */
  worktreeAdd(path: string, options: { branch?: string; newBranch?: string } = {}): Promise<GitWorktree[]> {
    return this.rpc.request('git.worktreeAdd', { path, ...options });
  }

  /** Удалить рабочий каталог. */
  worktreeRemove(path: string, force = false): Promise<GitWorktree[]> {
    return this.rpc.request('git.worktreeRemove', { path, force });
  }

  /** Убрать записи о каталогах, которых уже нет на диске. */
  worktreePrune(): Promise<GitWorktree[]> {
    return this.rpc.request('git.worktreePrune');
  }

  /** Какие из путей git считает игнорируемыми: их дерево показывает приглушённо. */
  checkIgnore(paths: readonly string[]): Promise<string[]> {
    if (paths.length === 0) return Promise.resolve([]);
    return this.rpc.request('git.checkIgnore', { paths: [...paths] });
  }

  /** Добавить пути в .gitignore корня репозитория. */
  async ignore(paths: string[]): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.ignore', { paths }));
  }

  /** Журнал ссылок: откат неудачного merge/rebase/reset. */
  reflog(limit = 50): Promise<GitReflogEntry[]> {
    return this.rpc.request('git.reflog', { limit });
  }

  /* ── пошаговый поиск багованного коммита (bisect) ──────────────────────── */

  /** Текущее состояние поиска: идёт ли он и сколько осталось проверить. */
  bisectState(): Promise<GitBisectState> {
    return this.rpc.request('git.bisectState');
  }

  /** Начать поиск; `bad` и `good` — известные плохой и хороший коммиты. */
  async bisectStart(options: { bad?: string; good?: string } = {}): Promise<GitBisectState> {
    return this.applyBisect(await this.rpc.request('git.bisectStart', options));
  }

  /** Пометить проверяемый коммит хорошим, плохим или пропустить его. */
  async bisectMark(mark: 'good' | 'bad' | 'skip'): Promise<GitBisectState> {
    return this.applyBisect(await this.rpc.request('git.bisectMark', { mark }));
  }

  /** Закончить поиск: ветка возвращается туда, где была до него. */
  async bisectReset(): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.bisectReset'));
  }

  /** Поиск переставляет ветку — состояние рабочего дерева меняется вместе с ним. */
  private async applyBisect(state: GitBisectState): Promise<GitBisectState> {
    await this.refresh();
    return state;
  }

  /** Сравнить две ссылки: список изменённых файлов со статусом и счётчиком строк. */
  compareRefs(base: string, head: string): Promise<GitRefDiff> {
    return this.rpc.request('git.compareRefs', { base, head });
  }

  /** Один файл между двумя ссылками: две версии текста. */
  diffRefs(base: string, head: string, path: string): Promise<GitDiff> {
    return this.rpc.request('git.diffRefs', { base, head, path });
  }

  /** История в виде графа веток — текстом, как её рисует git. */
  logGraph(limit = 100): Promise<string> {
    return this.rpc.request('git.logGraph', { limit });
  }

  /** Три версии конфликтного файла: общий предок и обе стороны. */
  conflictParts(path: string): Promise<GitConflictParts> {
    return this.rpc.request('git.conflictParts', { path });
  }

  /** Отметить конфликт решённым: текущее содержимое файла уходит в индекс. */
  /** Пакеты проекта (монорепо) — панель изменений раскладывает по ним правки. */
  projectPackages(): Promise<ProjectPackage[]> {
    return this.rpc.request('project.packages');
  }

  /* Площадка хостинга: запросы на слияние (PR/MR). */

  /** Площадка репозитория, клиент, вход и список запросов. */
  forgeInfo(remote?: string): Promise<ForgeInfo> {
    return this.rpc.request('git.forgeInfo', { remote });
  }

  /** Создать запрос на слияние из ветки. */
  forgeCreate(options: {
    title: string;
    body?: string;
    target?: string;
    source?: string;
    draft?: boolean;
  }): Promise<ForgeInfo> {
    return this.rpc.request('git.forgeCreate', options);
  }

  /** Забрать ветку запроса в рабочий каталог: клиент делает fetch и checkout. */
  async forgeCheckout(number: number): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.forgeCheckout', { number }));
  }

  /** Открыть ссылку в браузере системы. */
  openExternal(url: string): Promise<{ ok: boolean }> {
    return this.rpc.request('shell.openExternal', { url });
  }

  /* Личность, подпись и ключи: это настройки git, статус они не меняют. */

  /** Действующие имя, почта, подпись и хранилище паролей. */
  identity(): Promise<GitIdentity> {
    return this.rpc.request('git.identity');
  }

  /** Записать настройки в локальный конфиг репозитория и вернуть новое состояние. */
  setIdentity(values: Partial<GitIdentity>): Promise<GitIdentity> {
    return this.rpc.request('git.setIdentity', { values });
  }

  /** Открытые ключи из `~/.ssh`. */
  sshKeys(): Promise<GitSshKey[]> {
    return this.rpc.request('git.sshKeys');
  }

  /* Git LFS: большие файлы. Операции не меняют индекс, поэтому статус не трогаем. */

  /** Что знает репозиторий про LFS: доступность, шаблоны и файлы. */
  lfsInfo(): Promise<GitLfsInfo> {
    return this.rpc.request('git.lfsInfo');
  }

  /** Взять шаблон под LFS и вернуть свежее состояние. */
  lfsTrack(pattern: string): Promise<GitLfsInfo> {
    return this.rpc.request('git.lfsTrack', { pattern });
  }

  /** Перестать вести шаблон через LFS. */
  lfsUntrack(pattern: string): Promise<GitLfsInfo> {
    return this.rpc.request('git.lfsUntrack', { pattern });
  }

  /** Подтянуть содержимое больших файлов из хранилища. */
  lfsPull(): Promise<GitLfsInfo> {
    return this.rpc.request('git.lfsPull');
  }

  /** Поставить хуки LFS в этот репозиторий. */
  lfsInstall(): Promise<GitLfsInfo> {
    return this.rpc.request('git.lfsInstall');
  }

  async markResolved(path: string): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.markResolved', { path }));
  }

  /** Проиндексировать один блок изменений файла (не весь файл). */
  async stageHunk(path: string, index: number): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.stageHunk', { path, index }));
  }

  /** Убрать из индекса один блок изменений файла. */
  async unstageHunk(path: string, index: number): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.unstageHunk', { path, index }));
  }

  branches(): Promise<GitBranch[]> {
    return this.rpc.request('git.branches');
  }

  async checkout(name: string, create = false): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.checkout', { name, create }));
  }

  remotes(): Promise<GitRemote[]> {
    return this.rpc.request('git.remotes');
  }

  /** Забрать изменения из удалённого репозитория, не трогая рабочее дерево. */
  async fetch(): Promise<GitNetworkResult> {
    return this.network(await this.rpc.request('git.fetch'));
  }

  /** Влить изменения из удалённого репозитория (`mode` — слиянием, перебазированием или только перемоткой). */
  async pull(mode: PullMode = 'default'): Promise<GitNetworkResult> {
    return this.network(await this.rpc.request('git.pull', { mode }));
  }

  async push(options: { setUpstream?: boolean; force?: boolean } = {}): Promise<GitNetworkResult> {
    return this.network(await this.rpc.request('git.push', options));
  }

  /** Итог сетевой операции: свежий статус уже пришёл внутри ответа. */
  private network(result: GitNetworkResult): GitNetworkResult {
    this.apply(result.status);
    return result;
  }

  /** Принять свежую сводку по корням и сказать об этом подписчикам панели изменений. */
  private applySummary(summaries: GitRootSummary[]): GitRootSummary[] {
    this.summaries = Array.isArray(summaries) ? summaries : [];
    this.summaryEmitter.fire(this.summaries);
    return this.summaries;
  }

  private apply(status: GitStatus | undefined): GitStatus {
    // Защита на границе с main: без списка файлов снимок бессмысленен, а модель
    // с `undefined` вместо состояния утащит за собой весь UI.
    if (!status?.files) {
      console.warn('[chui] git: main вернул статус без списка файлов');
      return this.snapshot;
    }

    this.snapshot = status;
    this.byPath.clear();
    this.insideByFolder.clear();
    for (const file of status.files) this.byPath.set(file.path, file);
    // Папки-родители получают счётчик и самую заметную правку из своих файлов.
    for (const [folder, change] of changeInsideFolders(status.files)) this.insideByFolder.set(folder, change);
    this.emitter.fire(status);
    return status;
  }
}
