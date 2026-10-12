import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shell } from 'electron';
import {
  PushTopic,
  RpcErrorCode,
  type GitBranch,
  type GitChange,
  type GitCommit,
  type GitCommitDiff,
  type GitFileHunks,
  type GitCommitInfo,
  type GitConflictParts,
  type GitDiff,
  type GitFileStatus,
  type GitNetworkResult,
  type GitRebaseResult,
  type GitRemote,
  type GitRepository,
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
import { parseBisectState, type GitBisectState } from '../../shared/git-bisect';
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
  identityFromConfig,
  identityPatch,
  parseSshPublicKey,
  type GitConfigValues,
  type GitIdentity,
  type GitSshKey,
} from '../../shared/git-identity';
import { cliFor, forgeRepo, parseGhRequests, parseGlabRequests, type ForgeInfo } from '../../shared/git-platform';
import { summarizeRoot, type GitRootSummary } from '../../shared/git-multiroot';
import { COMMIT_DIFF_MAX_CHARS, truncateDiff } from '../../shared/commit-message';
import type { WorkspaceRoot } from '../../shared/workspace-roots';
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
  constructor(
    private readonly root: () => string | null,
    private readonly publish: (topic: string, payload: unknown) => void,
  ) {}

  /**
   * Статус рабочей папки; если она не в репозитории — `repository: null`.
   * `rootPath` задаёт папку явно — им пользуется сводка по всем корням области,
   * когда активен не тот корень, что нужен (`summary`).
   */
  async status(rootPath?: string): Promise<GitStatus> {
    const repoRoot = await this.repositoryRoot(rootPath);
    if (!repoRoot) return { repository: null, files: [] };

    const result = await this.exec(['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'], repoRoot);
    return this.parseStatus(result.stdout, repoRoot);
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
    await this.exec(['init'], root);
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
    const result = await this.exec(args, repoRoot, { allowFailure: true });

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
    const names = await this.exec(['diff', '--name-status', '-z', left, right], repoRoot);
    const stats = await this.exec(['diff', '--numstat', '-z', left, right], repoRoot);
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

  /* ── пошаговый поиск багованного коммита (bisect) ──────────────────────── */

  /**
   * Состояние поиска: идёт ли он, на каком коммите стоит рабочее дерево и сколько
   * осталось. Идёт ли — узнаём по файлу `BISECT_START` в каталоге git, а остаток и
   * итог — по тексту, который git пишет в файлы bisect.
   */
  async bisectState(): Promise<GitBisectState> {
    const repoRoot = await this.requireRoot();
    return this.readBisectState(repoRoot, '');
  }

  /** Начать поиск: `bad` — известный плохой коммит, `good` — известный хороший. */
  async bisectStart(options: { bad?: string; good?: string } = {}): Promise<GitBisectState> {
    const repoRoot = await this.requireRoot();
    const args = ['bisect', 'start'];
    if (options.bad) args.push(this.commitArg(options.bad));
    if (options.good) args.push(this.commitArg(options.good));
    const result = await this.exec(args, repoRoot, { allowFailure: true });
    return this.readBisectState(repoRoot, result.stderr || result.stdout);
  }

  /** Пометить текущий проверяемый коммит хорошим, плохим или пропустить его. */
  async bisectMark(mark: 'good' | 'bad' | 'skip'): Promise<GitBisectState> {
    const repoRoot = await this.requireRoot();
    const result = await this.exec(['bisect', mark], repoRoot, { allowFailure: true });
    return this.readBisectState(repoRoot, result.stderr || result.stdout);
  }

  /** Закончить поиск: ветка возвращается туда, где была до него. */
  async bisectReset(): Promise<GitStatus> {
    const repoRoot = await this.requireRoot();
    await this.exec(['bisect', 'reset'], repoRoot);
    return this.refresh();
  }

  /**
   * Собрать состояние поиска. Начало поиска определяем по файлу `BISECT_START`:
   * его git создаёт на время bisect и убирает на `reset`. Текст хода берём из
   * `BISECT_LOG` (журнал шагов) плюс свежий вывод команды.
   */
  private async readBisectState(repoRoot: string, output: string): Promise<GitBisectState> {
    const startFile = await this.gitPath(repoRoot, 'BISECT_START');
    const started = startFile ? (await fs.stat(startFile).catch(() => null))?.isFile() === true : false;

    // Журнал идёт в том же формате, что печатает git: разбираем и его, и свежий вывод.
    const logFile = await this.gitPath(repoRoot, 'BISECT_LOG');
    const log = logFile ? await fs.readFile(logFile, 'utf8').catch(() => '') : '';
    const text = `${log}\n${output}`;
    const parsed = parseBisectState(text, started);

    let current: { hash: string; summary: string } | null = null;
    if (started) {
      const head = await this.exec(['log', '-1', '--format=%h%x00%s'], repoRoot, { allowFailure: true });
      const [hash, summary] = head.stdout.trim().split('\u0000');
      if (hash) current = { hash, summary: summary ?? '' };
    }

    const message = (output.trim() || (parsed.active ? 'Поиск идёт' : 'Поиск завершён')).trim();
    return { ...parsed, current, message };
  }

  /** Имя ссылки или путь не могут начинаться с `-`: иначе git примет их за флаг. */
  private refArg(value: string): string {
    const text = value.trim();
    if (!text) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Не задана ссылка для сравнения');
    if (text.startsWith('-')) throw new RpcFailure(RpcErrorCode.InvalidParams, `Некорректная ссылка: ${text}`);
    return text;
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
    const head = await this.exec(['rev-parse', '--verify', `HEAD~${depth}`], repoRoot, { allowFailure: true });
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
      const result = await this.exec(['rebase', '-i', `HEAD~${depth}`], repoRoot, {
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
    const result = await this.exec(['rebase', '--continue'], repoRoot, { allowFailure: true });
    return this.rebaseOutcome(repoRoot, result);
  }

  /** Пропустить текущий коммит остановленного rebase. */
  async rebaseSkip(): Promise<GitRebaseResult> {
    const repoRoot = await this.requireRoot();
    const result = await this.exec(['rebase', '--skip'], repoRoot, { allowFailure: true });
    return this.rebaseOutcome(repoRoot, result);
  }

  /** Прервать rebase: ветка возвращается туда, где была до запуска. */
  async rebaseAbort(): Promise<GitStatus> {
    const repoRoot = await this.requireRoot();
    await this.exec(['rebase', '--abort'], repoRoot);
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
    const result = await this.exec(['ls-files', '-u'], repoRoot, { allowFailure: true });
    return result.ok && result.stdout.trim() !== '';
  }

  /**
   * Путь внутри каталога git (`.git` или рабочий каталог worktree). Спрашиваем у
   * самого git: у связанных рабочих каталогов `.git` — это файл, а не папка.
   */
  private async gitPath(repoRoot: string, name: string): Promise<string | null> {
    const result = await this.exec(['rev-parse', '--git-path', name], repoRoot, { allowFailure: true });
    const value = result.stdout.trim();
    if (!result.ok || !value) return null;
    return path.isAbsolute(value) ? value : path.join(repoRoot, value);
  }

  /** Полные сообщения последних `depth` коммитов: ключ — хеш, значение — текст целиком. */
  private async commitMessages(repoRoot: string, depth: number): Promise<Map<string, string>> {
    const result = await this.exec(['log', `-n`, String(depth), '--no-color', '--format=%H%x1f%B%x1e'], repoRoot, {
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
    const result = await this.exec(['rev-parse', '--verify', this.commitArg(commit)], repoRoot, {
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

  /* ── ветки, .gitignore и журнал ссылок ────────────────────────────────── */

  /**
   * Удалить ветку. `force` — когда git отказывается: ветка не влита, а человек
   * всё равно настаивает (это его выбор, но предупредить должно быть в UI).
   */
  async deleteBranch(name: string, force = false): Promise<GitStatus> {
    const repoRoot = await this.requireRoot();
    await this.exec(['branch', force ? '-D' : '-d', this.nameArg(name)], repoRoot);
    return this.refresh();
  }

  /** Переименовать ветку (у текущей — без указания старого имени). */
  async renameBranch(from: string, to: string): Promise<GitStatus> {
    const repoRoot = await this.requireRoot();
    await this.exec(['branch', '-m', this.nameArg(from), this.nameArg(to)], repoRoot);
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
    const result = await this.exec(['submodule', 'status'], repoRoot, { allowFailure: true });
    return result.ok ? parseSubmodules(result.stdout) : [];
  }

  /** Забрать код подмодулей: `git submodule update --init --recursive`. */
  async submoduleUpdate(): Promise<GitStatus> {
    const repoRoot = await this.requireRoot();
    await this.exec(['submodule', 'update', '--init', '--recursive'], repoRoot, {
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
  async forgeInfo(remote?: string): Promise<ForgeInfo> {
    const empty: ForgeInfo = {
      repo: null,
      remote: '',
      cli: null,
      cliAvailable: false,
      authenticated: false,
      requests: [],
      note: '',
    };

    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) return { ...empty, note: 'Это не репозиторий git' };

    const remotes = await this.remotes();
    if (remotes.length === 0) return { ...empty, note: 'У репозитория нет удалённых адресов' };
    const picked = remote
      ? remotes.find((item) => item.name === remote)
      : remotes.find((item) => item.name === 'origin');
    const chosen = picked ?? remotes[0]!;
    const repo = forgeRepo(chosen.pushUrl || chosen.fetchUrl);
    if (!repo) {
      return { ...empty, remote: chosen.name, note: `Не разобрал адрес удалённого репозитория: ${chosen.fetchUrl}` };
    }

    const cli = cliFor(repo.platform);
    const info: ForgeInfo = { ...empty, repo, remote: chosen.name, cli };
    if (!cli) {
      info.note = `Для площадки ${repo.host} консольного клиента нет — откройте запросы в браузере`;
      return info;
    }

    // Клиент есть? Спрашиваем версию: так проверка не зависит от того, куда он поставлен.
    const version = await this.forgeRun(cli, ['--version'], repoRoot);
    if (!version.ok) {
      info.note = `Клиент ${cli} не найден в системе — поставьте его, чтобы видеть ${'запросы на слияние'}`;
      return info;
    }
    info.cliAvailable = true;

    // Вход в аккаунт: без него клиент не покажет чужие приватные запросы, но публичные
    // иногда покажет. Если входа нет — так и скажем, а список оставим пустым.
    const auth = await this.forgeRun(cli, ['auth', 'status'], repoRoot);
    info.authenticated = auth.ok;

    const listing =
      cli === 'gh'
        ? await this.forgeRun(
            'gh',
            [
              'pr',
              'list',
              '--limit',
              '40',
              '--json',
              'number,title,author,state,headRefName,baseRefName,url,isDraft,updatedAt,labels',
            ],
            repoRoot,
          )
        : await this.forgeRun('glab', ['mr', 'list', '--output', 'json', '--per-page', '40'], repoRoot);

    if (!listing.ok) {
      info.note = listing.stderr.trim() || listing.stdout.trim() || `Клиент ${cli} не смог получить список`;
      return info;
    }
    info.requests = cli === 'gh' ? parseGhRequests(listing.stdout) : parseGlabRequests(listing.stdout);
    return info;
  }

  /**
   * Создать запрос на слияние из текущей (или названной) ветки. Черновик — флагом
   * клиента; тексты передаём как есть, а площадка сама дополнит шаблоном.
   */
  async forgeCreate(options: {
    title: string;
    body?: string;
    target?: string;
    draft?: boolean;
    source?: string;
  }): Promise<ForgeInfo> {
    const repoRoot = await this.requireRoot();
    const info = await this.forgeInfo();
    if (!info.repo || !info.cli) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, info.note || 'Площадка не определена');
    }
    if (!info.cliAvailable) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `Клиент ${info.cli} не найден в системе`);
    }
    const title = options.title.trim();
    if (title === '') throw new RpcFailure(RpcErrorCode.InvalidParams, 'Нужен заголовок запроса');

    const args =
      info.cli === 'gh'
        ? ['pr', 'create', '--title', title, ...(options.body ? ['--body', options.body] : ['--body', ''])]
        : ['mr', 'create', '--title', title, ...(options.body ? ['--description', options.body] : []), '--yes'];
    if (options.target)
      args.push(...(info.cli === 'gh' ? ['--base', options.target] : ['--target-branch', options.target]));
    if (options.source)
      args.push(...(info.cli === 'gh' ? ['--head', options.source] : ['--source-branch', options.source]));
    if (options.draft) args.push('--draft');

    const result = await this.forgeRun(info.cli, args, repoRoot, NETWORK_TIMEOUT_MS);
    if (!result.ok) {
      throw new RpcFailure(
        RpcErrorCode.Internal,
        result.stderr.trim() || result.stdout.trim() || 'Клиент отказался создавать запрос',
      );
    }
    return this.forgeInfo(info.remote);
  }

  /**
   * Забрать ветку запроса в рабочий каталог: клиент сам делает fetch и переключает
   * ветку. После этого состояние репозитория изменилось — обновляем его.
   */
  async forgeCheckout(number: number): Promise<GitStatus> {
    const repoRoot = await this.requireRoot();
    const info = await this.forgeInfo();
    if (!info.repo || !info.cli) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, info.note || 'Площадка не определена');
    }
    if (!info.cliAvailable) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `Клиент ${info.cli} не найден в системе`);
    }
    const n = Math.floor(number);
    if (!Number.isFinite(n) || n <= 0) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Неверный номер запроса');
    const args = info.cli === 'gh' ? ['pr', 'checkout', String(n)] : ['mr', 'checkout', String(n)];
    const result = await this.forgeRun(info.cli, args, repoRoot, NETWORK_TIMEOUT_MS);
    if (!result.ok) {
      throw new RpcFailure(
        RpcErrorCode.Internal,
        result.stderr.trim() || result.stdout.trim() || 'Не удалось забрать ветку запроса',
      );
    }
    return this.refresh();
  }

  /**
   * Запуск консольного клиента площадки (`gh`, `glab`). Сбой — это `ok: false`, а не
   * исключение: «клиента нет» и «сеть не ответила» — обычные ответы, о которых окно
   * сообщает словами.
   */
  private forgeRun(cli: string, args: string[], cwd: string, timeout = GIT_TIMEOUT_MS): Promise<GitResult> {
    return new Promise((resolve) => {
      execFile(
        cli,
        args,
        {
          cwd,
          timeout,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
          env: {
            ...process.env,
            // Никаких вопросов и браузера: всё, что требует ввода, не для этого окна.
            GH_PROMPT_DISABLED: '1',
            GIT_TERMINAL_PROMPT: '0',
            NO_COLOR: '1',
          },
        },
        (error, stdout, stderr) => {
          resolve({ ok: error === null, stdout: stdout ?? '', stderr: stderr ?? '' });
        },
      );
    });
  }

  /* ── личность, подпись коммитов и ключи ────────────────────────────────── */

  /**
   * Действующие настройки автора и подписи. Читаем через `git config --get`: он сам
   * собирает значение из системного, глобального и локального конфигов — то же, чем
   * пользуется сам git при коммите.
   */
  async identity(): Promise<GitIdentity> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');
    const values: GitConfigValues = {
      'user.name': await this.configGet(repoRoot, 'user.name'),
      'user.email': await this.configGet(repoRoot, 'user.email'),
      'user.signingkey': await this.configGet(repoRoot, 'user.signingkey'),
      'gpg.format': await this.configGet(repoRoot, 'gpg.format'),
      'commit.gpgsign': await this.configGet(repoRoot, 'commit.gpgsign'),
      'tag.gpgsign': await this.configGet(repoRoot, 'tag.gpgsign'),
      'credential.helper': await this.configGet(repoRoot, 'credential.helper'),
    };
    const draft = identityFromConfig(values, false);
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
    for (const item of identityPatch(current, values)) {
      if (item.value === '') {
        // Пустое значение — снять настройку; её могло и не быть.
        await this.exec(['config', '--local', '--unset', item.key], repoRoot, { allowFailure: true });
        continue;
      }
      await this.exec(['config', '--local', item.key, item.value], repoRoot);
    }
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

  /** Значение настройки git: пустая строка, если она не задана. */
  private async configGet(repoRoot: string, key: string): Promise<string> {
    const result = await this.exec(['config', '--get', key], repoRoot, { allowFailure: true });
    return result.ok ? result.stdout.trim() : '';
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

    const version = await this.exec(['lfs', 'version'], repoRoot, { allowFailure: true });
    if (!version.ok) return emptyLfsInfo(patterns);
    // `git lfs version` печатает «git-lfs/3.4.0 (GitHub; …)» — берём первое слово.
    const versionText = version.stdout.trim().split(/\s+/)[0] ?? '';

    const listing = await this.exec(['lfs', 'ls-files'], repoRoot, { allowFailure: true });
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
    await this.exec(['lfs', 'track', '--', clean], repoRoot);
    return this.lfsInfo();
  }

  /** Перестать вести шаблон через LFS (`git lfs untrack`). Сами файлы не трогаются. */
  async lfsUntrack(pattern: string): Promise<GitLfsInfo> {
    const repoRoot = await this.requireRoot();
    const clean = normalizeLfsPattern(pattern);
    if (clean === '') throw new RpcFailure(RpcErrorCode.InvalidParams, 'Пустой шаблон');
    await this.exec(['lfs', 'untrack', '--', clean], repoRoot);
    return this.lfsInfo();
  }

  /** Подтянуть содержимое LFS-файлов (`git lfs pull`) — как fetch, только для больших файлов. */
  async lfsPull(): Promise<GitLfsInfo> {
    const repoRoot = await this.requireRoot();
    await this.exec(['lfs', 'pull'], repoRoot, { timeout: NETWORK_TIMEOUT_MS });
    return this.lfsInfo();
  }

  /** Подготовить репозиторий к LFS: `git lfs install --local` (ставит хуки). */
  async lfsInstall(): Promise<GitLfsInfo> {
    const repoRoot = await this.requireRoot();
    await this.exec(['lfs', 'install', '--local'], repoRoot);
    return this.lfsInfo();
  }

  /* ── дополнительные рабочие каталоги (worktree) ───────────────────────── */

  /** Список рабочих каталогов репозитория: главный и добавленные. */
  async worktrees(): Promise<GitWorktree[]> {
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) return [];
    const result = await this.exec(['worktree', 'list', '--porcelain'], repoRoot, { allowFailure: true });
    return result.ok ? parseWorktrees(result.stdout) : [];
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
    await this.exec(args, repoRoot, { timeout: NETWORK_TIMEOUT_MS });
    return this.worktrees();
  }

  /** Удалить рабочий каталог. `force` — когда в нём есть незакоммиченные правки. */
  async worktreeRemove(target: string, force = false): Promise<GitWorktree[]> {
    const repoRoot = await this.requireRoot();
    // Путь начинается с дефиса? Тогда за него примет git — подстрахуемся `--`.
    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push('--', target);
    await this.exec(args, repoRoot);
    return this.worktrees();
  }

  /** Убрать записи о каталогах, которых уже нет на диске. */
  async worktreePrune(): Promise<GitWorktree[]> {
    const repoRoot = await this.requireRoot();
    await this.exec(['worktree', 'prune'], repoRoot);
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
    return output
      .split('\u0000')
      .map((line) => line.trim())
      .map((line) => known.get(line))
      .filter((item): item is string => typeof item === 'string');
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
    const result = await this.exec(
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
    const result = await this.exec(
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
  private async repositoryRoot(explicit?: string): Promise<string | null> {
    const root = explicit ?? this.root();
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
    const args = ['apply', '--cached', '--whitespace=nowarn'];
    if (reverse) args.push('--reverse');
    return this.runApply(args, repoRoot, patch);
  }

  /**
   * Приложить обратный патч к РАБОЧЕМУ ДЕРЕВУ (без `--cached`): правка исчезает из
   * файла, индекс не меняется. Тем же путём, что `applyToIndex`, только цель другая.
   */
  private applyToWorktree(patch: string, repoRoot: string): Promise<void> {
    return this.runApply(['apply', '--whitespace=nowarn', '--reverse'], repoRoot, patch);
  }

  /**
   * Запустить `git apply` с патчем на входе. Оба применения (в индекс и в рабочее
   * дерево) отличаются только аргументами — общий запуск живёт здесь.
   */
  private runApply(args: readonly string[], repoRoot: string, patch: string): Promise<void> {
    return new Promise((resolve, reject) => {
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
    options: { allowFailure?: boolean; timeout?: number; env?: Record<string, string> } = {},
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
            // Отдельные вызовы (rebase) подменяют редакторы своими — см. `rebaseInteractive`.
            ...options.env,
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
