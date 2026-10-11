import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import {
  PushTopic,
  RpcErrorCode,
  type GitBranch,
  type GitChange,
  type GitCommit,
  type GitCommitInfo,
  type GitConflictParts,
  type GitDiff,
  type GitFileStatus,
  type GitNetworkResult,
  type GitRemote,
  type GitRepository,
  type GitStatus,
} from '../../shared/api';
import { parseBlamePorcelain, type BlameLine } from '../../shared/git-blame';
import { hunkPatch, hunkRanges } from '../../shared/git-hunks';
import { parseStashList, type GitStashEntry } from '../../shared/git-stash';
import { parseTagList, type GitTag } from '../../shared/git-tags';
import { RpcFailure } from '../ipc/router';

const GIT_TIMEOUT_MS = 20_000;
/** Клонирование зависит от сети: здесь ограничение по времени много больше. */
const CLONE_TIMEOUT_MS = 10 * 60_000;
/**
 * Сетевые операции (fetch/pull/push) тоже ждут сеть, но не так долго, как полный
 * клон: обычный fetch укладывается в секунды, а зависший лучше прервать раньше.
 */
const NETWORK_TIMEOUT_MS = 3 * 60_000;
const MAX_BUFFER = 8 * 1024 * 1024;
/** Размер файла, выше которого diff не строим: сравнение такого в редакторе бессмысленно. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

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
  constructor(
    private readonly root: () => string | null,
    private readonly publish: (topic: string, payload: unknown) => void,
  ) {}

  /** Статус рабочей папки; если она не в репозитории — `repository: null`. */
  async status(): Promise<GitStatus> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) return { repository: null, files: [] };

    const result = await this.exec(['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'], repoRoot);
    return this.parseStatus(result.stdout, repoRoot);
  }

  async init(): Promise<GitStatus> {
    const root = this.requireRoot();
    await this.exec(['init'], root);
    return this.refresh();
  }

  async stage(paths: string[]): Promise<GitStatus> {
    const { repoRoot, relative } = await this.locate(paths);
    // `-A` нужен, чтобы одной командой уходили и удаления: `add --` их не замечает.
    await this.exec(['add', '-A', '--', ...relative], repoRoot);
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

  async unstage(paths: string[]): Promise<GitStatus> {
    const { repoRoot, relative } = await this.locate(paths);
    // `restore --staged` требует HEAD, а в репозитории без коммитов его нет —
    // там файл просто убирается из индекса.
    const result = await this.exec(['restore', '--staged', '--', ...relative], repoRoot, { allowFailure: true });
    if (!result.ok) await this.exec(['rm', '--cached', '-q', '--', ...relative], repoRoot);
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
      await this.exec(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked], repoRoot);
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

    await this.exec(args, repoRoot);
    const info = await this.exec(['log', '-1', '--format=%h%x00%s'], repoRoot);
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
  async diffText(filePath: string, staged = false): Promise<string> {
    const status = await this.status();
    const repoRoot = status.repository?.root;
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

    const known = status.files.find((file) => file.path === path.resolve(filePath));
    if (!known) throw new RpcFailure(RpcErrorCode.NotFound, 'У файла нет изменений');

    return this.rawDiff(known.relative, repoRoot, { staged });
  }

  /**
   * Сырой унифицированный diff файла от git. Контекст задаём сами, а не берём из
   * настроек git: инструмент отдаёт текст модели, и у человека в `diff.context`
   * может стоять 25 строк — тогда больше половины отведённого места уйдёт на
   * неизменённый текст (на нашем репозитории такой конфиг раздувает diff в 2,5
   * раза — 769 КБ против 298 КБ). `-U3` — обычная норма, её же ждёт модель, читая
   * хунки, и те же границы блоков видит интерфейс. `--no-color` — цвет в ответе
   * инструмента не нужен; `--no-ext-diff` — иначе `diff.external` подменил бы
   * вывод чужой программой, а нам нужен именно унифицированный diff.
   */
  private async rawDiff(
    relative: string,
    repoRoot: string,
    target: { staged: boolean; commit?: string },
  ): Promise<string> {
    const args = target.commit
      ? ['diff', target.commit, '-U3', '--no-color', '--no-ext-diff', '--', relative]
      : target.staged
        ? ['diff', '--cached', '-U3', '--no-color', '--no-ext-diff', '--', relative]
        : ['diff', '-U3', '--no-color', '--no-ext-diff', '--', relative];
    const result = await this.exec(args, repoRoot, { allowFailure: true });
    return result.stdout;
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
    const result = await this.exec(args, repoRoot, { allowFailure: true });
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
    const args = ['log', `-n${count}`, '--date=short', '--format=%h%x1f%ad%x1f%an%x1f%s'];
    if (filePath) args.push('--', path.relative(repoRoot, path.resolve(filePath)));

    // allowFailure: в репозитории без коммитов `git log` завершается ошибкой,
    // а это не сбой — просто истории ещё нет.
    const result = await this.exec(args, repoRoot, { allowFailure: true });
    if (!result.ok) return [];

    const commits: GitCommit[] = [];
    for (const line of result.stdout.split('\n')) {
      if (!line) continue;
      const [hash, date, author, ...rest] = line.split('\u001f');
      if (!hash || !date || !author) continue;
      commits.push({ hash, date, author, summary: rest.join('\u001f') });
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

    const result = await this.exec(args, repoRoot, { allowFailure: true });
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
    await this.exec(['add', '--', relative], repoRoot);
    return this.refresh();
  }

  async branches(): Promise<GitBranch[]> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) return [];

    const [local, remote] = await Promise.all([
      this.exec(['branch', '--list', '--format=%(refname:short)%09%(HEAD)'], repoRoot),
      this.exec(['branch', '--remotes', '--format=%(refname:short)'], repoRoot),
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
    await this.exec(create ? ['checkout', '-b', branch] : ['checkout', branch], repoRoot);
    return this.refresh();
  }

  /**
   * Удалённые репозитории: имя и адреса. Из `git remote -v` собираем карту по
   * имени — одна строка на `(fetch)`, одна на `(push)`.
   */
  async remotes(): Promise<GitRemote[]> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) return [];

    const result = await this.exec(['remote', '-v'], repoRoot, { allowFailure: true });
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

  /** Влить изменения из удалённого репозитория в текущую ветку. */
  async pull(): Promise<GitNetworkResult> {
    return this.network(['pull', '--no-edit']);
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
    const status = await this.status();
    const repoRoot = status.repository?.root;
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

    const branch = status.repository?.branch;
    if (!branch) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, 'HEAD оторван (detached): нечего отправлять');
    }

    const args = ['push'];
    if (options.force) args.push('--force-with-lease');
    if (options.setUpstream || !(await this.hasUpstream(repoRoot))) args.push('-u', 'origin', branch);
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
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) return null;
    const relative = path.relative(repoRoot, path.resolve(filePath));
    return this.show(`HEAD:${relative}`, repoRoot);
  }

  /* ── отложенные изменения (stash) ─────────────────────────────────────── */

  /** Список записей stash: свежая — первой. */
  async stashList(): Promise<GitStashEntry[]> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) return [];
    const result = await this.exec(['stash', 'list', '--format=%gd%x1f%gs'], repoRoot, { allowFailure: true });
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
    await this.exec(args, repoRoot);
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
    const result = await this.exec(['stash', 'show', '-p', '--no-color', '--no-ext-diff', ref], repoRoot, {
      allowFailure: true,
    });
    // Пусто — в записи нет правок отслеживаемых файлов (бывают только новые):
    // скажем это словами, а не пустым экраном.
    return result.stdout.trim() ? result.stdout : 'В этой записи нет правок отслеживаемых файлов.';
  }

  private async stashOp(op: 'apply' | 'pop' | 'drop', index: number): Promise<GitStatus> {
    const { repoRoot, ref } = await this.locateStash(index);
    await this.exec(['stash', op, ref], repoRoot);
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
    await this.exec(['cherry-pick', this.commitArg(commit)], repoRoot);
    return this.refresh();
  }

  /** Отменить один коммит новым коммитом с обратными правками. */
  async revert(commit: string): Promise<GitStatus> {
    const repoRoot = await this.requireRoot();
    // --no-edit: сообщение берём готовое, редактор не открываем.
    await this.exec(['revert', '--no-edit', this.commitArg(commit)], repoRoot);
    return this.refresh();
  }

  /** Передвинуть ветку на коммит: soft (только указатель), mixed (+ индекс), hard (+ дерево). */
  async reset(mode: 'soft' | 'mixed' | 'hard', commit: string): Promise<GitStatus> {
    const repoRoot = await this.requireRoot();
    await this.exec(['reset', `--${mode}`, this.commitArg(commit)], repoRoot);
    return this.refresh();
  }

  /** Список тегов: от новых к старым, как их показывает git. */
  async tags(): Promise<GitTag[]> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) return [];
    const result = await this.exec(
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
    await this.exec(args, repoRoot);
    return this.refresh();
  }

  /** Удалить тег из репозитория (удалённый не трогаем). */
  async deleteTag(name: string): Promise<GitStatus> {
    const repoRoot = await this.requireRoot();
    await this.exec(['tag', '-d', this.nameArg(name)], repoRoot);
    return this.refresh();
  }

  /** Отправить один тег в origin. */
  async pushTag(name: string): Promise<GitNetworkResult> {
    return this.network(['push', 'origin', `refs/tags/${this.nameArg(name)}`]);
  }

  /** Имя коммита может начинаться с `-` — тогда git примет его за флаг, а не за ссылку. */
  private commitArg(commit: string): string {
    const value = commit.trim();
    if (!value) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Не задан коммит');
    if (value.startsWith('-'))
      throw new RpcFailure(RpcErrorCode.InvalidParams, `Некорректная ссылка на коммит: ${value}`);
    return value;
  }

  /** То же для имени тега. */
  private nameArg(name: string): string {
    const value = name.trim();
    if (!value) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Не задано имя тега');
    if (value.startsWith('-')) throw new RpcFailure(RpcErrorCode.InvalidParams, `Некорректное имя тега: ${value}`);
    return value;
  }

  /* ── внутреннее ────────────────────────────────────────────────────────── */

  /**
   * Сетевая операция git: запуск, разбор итога и свежий статус. Сбой (нет remote,
   * отказ авторизации, конфликт слияния) — не исключение, а ответ: `ok: false` и
   * текст от git. Ожидание много больше обычного — здесь ждут сеть.
   */
  private async network(args: string[]): Promise<GitNetworkResult> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

    const result = await this.exec(args, repoRoot, { allowFailure: true, timeout: NETWORK_TIMEOUT_MS });
    // У push/fetch итог идёт в stderr, у pull — в stdout: берём то, что непусто.
    const text = (result.stderr.trim() || result.stdout.trim()).trim();
    const message = text || `git ${args[0]}: выполнено`;
    const status = await this.refresh();
    return { ok: result.ok, message, status };
  }

  /** Настроен ли upstream у текущей ветки: без него `push`/`pull` не знают пары. */
  private async hasUpstream(repoRoot: string): Promise<boolean> {
    const result = await this.exec(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoRoot, {
      allowFailure: true,
    });
    return result.ok && result.stdout.trim() !== '';
  }

  private requireRoot(): string {
    const root = this.root();
    if (!root) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Рабочая папка не открыта');
    return root;
  }

  /**
   * Корень репозитория для рабочей папки. Если папка открыта внутри большего
   * репозитория, git вернёт его корень — это ожидаемое поведение.
   */
  private async repositoryRoot(): Promise<string | null> {
    const root = this.root();
    if (!root) return null;
    const result = await this.exec(['rev-parse', '--show-toplevel'], root, { allowFailure: true });
    if (!result.ok) return null;
    const value = result.stdout.trim();
    return value || null;
  }

  /** Общий вход для операций с файлами: проверяем, что всё это про наш репозиторий. */
  private async locate(paths: string[]): Promise<{ repoRoot: string; relative: string[] }> {
    const status = await this.status();
    const repoRoot = status.repository?.root;
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

    const known = new Map(status.files.map((file) => [file.path, file]));
    const relative = paths.map((target) => {
      const absolute = path.resolve(target);
      const file = known.get(absolute);
      if (!file) throw new RpcFailure(RpcErrorCode.NotFound, `Вне репозитория или без изменений: ${absolute}`);
      return file.relative;
    });

    return { repoRoot, relative };
  }

  /** Один файл для операции с блоком: должен быть в нашем репозитории и с правками. */
  private async locateHunk(filePath: string): Promise<{ repoRoot: string; relative: string }> {
    const status = await this.status();
    const repoRoot = status.repository?.root;
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

    const known = status.files.find((file) => file.path === path.resolve(filePath));
    if (!known) throw new RpcFailure(RpcErrorCode.NotFound, 'У файла нет изменений');
    return { repoRoot, relative: known.relative };
  }

  /**
   * Приложить патч к индексу (`--cached`), не трогая рабочее дерево. `reverse`
   * убирает блок из индекса. Патч идёт на stdin: так не нужен временный файл,
   * а `git apply` читает его оттуда без оговорок.
   */
  private applyToIndex(patch: string, repoRoot: string, reverse: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['apply', '--cached', '--whitespace=nowarn'];
      if (reverse) args.push('--reverse');
      const child = spawn('git', ['--no-optional-locks', ...args], {
        cwd: repoRoot,
        windowsHide: true,
        env: {
          ...process.env,
          // Никаких диалогов и редакторов: всё, что требует ввода, в IDE решается иначе.
          GIT_TERMINAL_PROMPT: '0',
          GIT_EDITOR: 'true',
          GIT_PAGER: 'cat',
        },
      });

      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => reject(new RpcFailure(RpcErrorCode.Internal, `git: ${error.message}`)));
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new RpcFailure(RpcErrorCode.Internal, `git apply: ${stderr.trim() || `код ${code}`}`));
      });
      child.stdin.end(patch);
    });
  }

  /** Содержимое из дерева git; если объекта нет (новый файл) — пустая строка. */
  private async show(spec: string, cwd: string): Promise<string> {
    const result = await this.exec(['show', spec], cwd, { allowFailure: true });
    return result.ok ? result.stdout : '';
  }

  private async readText(absolute: string): Promise<string> {
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile()) return '';
    if (stat.size > MAX_DIFF_BYTES) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, 'Файл слишком большой для сравнения');
    }
    const buffer = await fs.readFile(absolute);
    if (buffer.includes(0)) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Двоичный файл — сравнение недоступно');
    return buffer.toString('utf8');
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

  private exec(
    args: string[],
    cwd: string,
    options: { allowFailure?: boolean; timeout?: number } = {},
  ): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        // --no-optional-locks: IDE не должна менять индекс, пока пользователь просто смотрит на файлы.
        ['--no-optional-locks', '-c', 'core.quotepath=false', ...args],
        {
          cwd,
          timeout: options.timeout ?? GIT_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
          env: {
            ...process.env,
            // Никаких диалогов и редакторов: всё, что требует ввода, в IDE решается иначе.
            GIT_TERMINAL_PROMPT: '0',
            GIT_EDITOR: 'true',
            GIT_PAGER: 'cat',
          },
        },
        (error, stdout, stderr) => {
          const failed = error !== null;
          const result: GitResult = { ok: !failed, stdout, stderr };
          if (!failed || options.allowFailure) {
            resolve(result);
            return;
          }
          const message = stderr.trim() || stdout.trim() || `git ${args[0]}: код ${error?.code ?? '?'}`;
          reject(new RpcFailure(RpcErrorCode.Internal, `git: ${message}`, message));
        },
      );
    });
  }

  /* ── разбор `git status --porcelain=v2 -z` ─────────────────────────────── */

  private parseStatus(stdout: string, repoRoot: string): GitStatus {
    const repository: GitRepository = {
      root: repoRoot,
      branch: null,
      detached: false,
      head: null,
      ahead: 0,
      behind: 0,
    };
    const files: GitFileStatus[] = [];

    const applyHeader = (line: string): void => {
      const body = line.slice(1).trim();
      const [key, ...rest] = body.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.head') {
        repository.detached = value === '(detached)';
        repository.branch = value === '(detached)' || value === '' ? null : value;
      } else if (key === 'branch.oid') {
        repository.head = value === '(initial)' || value === '' ? null : value.slice(0, 7);
      } else if (key === 'branch.ab') {
        const [ahead, behind] = value.split(' ');
        repository.ahead = Math.abs(Number(ahead ?? 0)) || 0;
        repository.behind = Math.abs(Number(behind ?? 0)) || 0;
      }
    };

    const tokens = stdout.split('\u0000');
    for (let index = 0; index < tokens.length; index += 1) {
      let token = tokens[index] ?? '';

      // Шапка приходит строками, разделёнными LF, и может склеиться с первой записью.
      while (token.startsWith('#')) {
        const end = token.indexOf('\n');
        if (end === -1) {
          applyHeader(token);
          token = '';
          break;
        }
        applyHeader(token.slice(0, end));
        token = token.slice(end + 1);
      }

      if (!token) continue;

      if (token.startsWith('1 ')) {
        const parts = token.split(' ');
        files.push(this.makeFile(parts[1] ?? '', parts.slice(8).join(' '), repoRoot));
      } else if (token.startsWith('2 ')) {
        // У переименования два пути: новый в самой записи, старый — следующим токеном.
        const parts = token.split(' ');
        index += 1;
        files.push(this.makeFile(parts[1] ?? '', parts.slice(9).join(' '), repoRoot));
      } else if (token.startsWith('u ')) {
        const parts = token.split(' ');
        files.push(this.makeFile('UU', parts.slice(10).join(' '), repoRoot, 'conflicted'));
      } else if (token.startsWith('? ')) {
        const relative = token.slice(2);
        files.push({
          path: path.join(repoRoot, relative),
          relative,
          change: 'untracked',
          staged: false,
          unstaged: true,
        });
      }
      // `!` — игнорируемые файлы: в интерфейсе они не нужны.
    }

    files.sort((a, b) => a.relative.localeCompare(b.relative));
    return { repository, files };
  }

  /** `XY` из porcelain: X — индекс, Y — рабочее дерево. */
  private makeFile(xy: string, relative: string, repoRoot: string, forced?: GitChange): GitFileStatus {
    const index = xy[0] ?? '.';
    const worktree = xy[1] ?? '.';
    const staged = index !== '.' && index !== ' ' && index !== '?';
    const unstaged = worktree !== '.' && worktree !== ' ';

    let change: GitChange;
    if (forced) change = forced;
    else if (index === 'A') change = 'added';
    else if (index === 'D' || worktree === 'D') change = 'deleted';
    else if (index === 'R') change = 'renamed';
    else change = 'modified';

    return { path: path.join(repoRoot, relative), relative, change, staged, unstaged };
  }
}
