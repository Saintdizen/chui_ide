import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import {
  PushTopic,
  RpcErrorCode,
  type GitBranch,
  type GitChange,
  type GitCommitInfo,
  type GitDiff,
  type GitFileStatus,
  type GitRepository,
  type GitStatus,
} from '../../shared/api';
import { RpcFailure } from '../ipc/router';

const GIT_TIMEOUT_MS = 20_000;
/** Клонирование зависит от сети: здесь ограничение по времени много больше. */
const CLONE_TIMEOUT_MS = 10 * 60_000;
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

  /** Коммит. С путями — только они, как «закоммитить этот файл» в других IDE. */
  async commit(message: string, paths?: string[]): Promise<GitCommitInfo> {
    const text = message.trim();
    if (!text) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Пустое сообщение коммита');

    const status = await this.status();
    const repoRoot = status.repository?.root;
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

    const args = ['commit', '-m', text];
    if (paths?.length) {
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
  async diff(filePath: string, staged = false): Promise<GitDiff> {
    const status = await this.status();
    const repoRoot = status.repository?.root;
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

    const absolute = path.resolve(filePath);
    const known = status.files.find((file) => file.path === absolute);
    if (!known) throw new RpcFailure(RpcErrorCode.NotFound, 'У файла нет изменений');

    // staged: индекс против HEAD, иначе рабочее дерево против индекса.
    // Именно против индекса, а не HEAD: иначе в diff попадали бы уже
    // проиндексированные правки, и сравнение теряло бы смысл.
    const original = staged
      ? await this.show(`HEAD:${known.relative}`, repoRoot)
      : await this.show(`:${known.relative}`, repoRoot);
    const modified = staged ? await this.show(`:${known.relative}`, repoRoot) : await this.readText(absolute);

    return { original, modified };
  }

  /**
   * Унифицированный diff файла от самого git — так его видит человек в
   * терминале (`+`/`-`). Нужен инструментам агента: `diff()` отдаёт обе версии
   * целиком, а модели полезнее готовые строки изменений.
   */
  async diffText(filePath: string, staged = false): Promise<string> {
    const status = await this.status();
    const repoRoot = status.repository?.root;
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

    const known = status.files.find((file) => file.path === path.resolve(filePath));
    if (!known) throw new RpcFailure(RpcErrorCode.NotFound, 'У файла нет изменений');

    const args = staged ? ['diff', '--cached', '--', known.relative] : ['diff', '--', known.relative];
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

  /* ── внутреннее ────────────────────────────────────────────────────────── */

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

  private exec(args: string[], cwd: string, options: { allowFailure?: boolean } = {}): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        // --no-optional-locks: IDE не должна менять индекс, пока пользователь просто смотрит на файлы.
        ['--no-optional-locks', '-c', 'core.quotepath=false', ...args],
        {
          cwd,
          timeout: GIT_TIMEOUT_MS,
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
