import {
  PushTopic,
  type GitBranch,
  type GitCommitInfo,
  type GitDiff,
  type GitFileStatus,
  type GitStatus,
} from '../../shared/api';
import { Emitter } from './events';
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

  constructor(
    private readonly rpc: RpcClient,
    workspace: WorkspaceModel,
  ) {
    rpc.onPush((message) => {
      if (message.topic === PushTopic.GitChanged) this.apply(message.payload as GitStatus);
    });
    // Другая рабочая папка — другой репозиторий: прежние пометки к ней не относятся.
    workspace.onDidChange(() => void this.refresh());
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

  async commit(message: string, paths?: string[]): Promise<GitCommitInfo> {
    const info = await this.rpc.request('git.commit', { message, paths });
    await this.refresh();
    return info;
  }

  diff(path: string, staged = false): Promise<GitDiff> {
    return this.rpc.request('git.diff', { path, staged });
  }

  branches(): Promise<GitBranch[]> {
    return this.rpc.request('git.branches');
  }

  async checkout(name: string, create = false): Promise<GitStatus> {
    return this.apply(await this.rpc.request('git.checkout', { name, create }));
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
    for (const file of status.files) {
      this.byPath.set(file.path, file);
      // Папки-родители получают счётчик и самую заметную правку из своих файлов.
      const parts = file.path.split('/');
      for (let depth = 1; depth < parts.length; depth += 1) {
        const folder = parts.slice(0, depth).join('/');
        const known = this.insideByFolder.get(folder);
        this.insideByFolder.set(folder, {
          count: (known?.count ?? 0) + 1,
          change: known && CHANGE_WEIGHT[known.change] > CHANGE_WEIGHT[file.change] ? known.change : file.change,
        });
      }
    }
    this.emitter.fire(status);
    return status;
  }
}
