import path from 'node:path';
import { RpcErrorCode } from '../../shared/api';
import type { GitCommit, GitConflictParts, GitDiff } from '../../shared/api';
import { type BlameLine, parseBlamePorcelain } from '../../shared/git-blame';
import { type GitRefDiff, mergeRefDiff } from '../../shared/git-ref-diff';
import { parseReflog, type GitReflogEntry } from '../../shared/git-reflog';
import { RpcFailure } from '../ipc/router';
import { refArg } from './args';
import type { RepositoryContext } from './contexts';
import { execGit } from './exec';
import { showFile } from './file-text';

/**
 * Чтение истории и содержимого репозитория: «что было», а не «что поменять».
 *
 * Ничего не пишет и не рассылает `GitChanged` — поэтому в контексте только
 * корень. Корень здесь берём через `repositoryRoot()`, а `null` — это пустой
 * ответ: список коммитов в папке без git пусть будет пустым, а не ошибкой.
 * Где пустота — ответ, а не сбой (без коммитов, без объекта в индексе), это
 * написано у самих функций.
 */
export interface HistoryContext extends RepositoryContext {}

/**
 * Содержимое файла в состоянии `spec` (`HEAD:путь`, `:путь` — индекс,
 * `коммит:путь`). Если у файла не может быть содержимого в этом состоянии
 * (файл новый, объекта нет), возвращается пустая строка: для интерфейса это
 * «сравнивать не с чем», а не ошибка.
 */
export async function show(spec: string, repoRoot: string): Promise<string> {
  return showFile(spec, repoRoot);
}

/** Внутреннее имя то же, но говорится оно у места вызова: три версии конфликта. */
const fromRef = (repoRoot: string, spec: string) => show(spec, repoRoot);

function relativeTo(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, path.resolve(filePath));
}

export async function logText(ctx: HistoryContext, limit = 20, filePath?: string): Promise<string> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

  const count = Math.min(Math.max(Math.round(limit) || 20, 1), 100);
  const args = ['log', `-n${count}`, '--date=short', '--format=%h %ad %an: %s'];
  if (filePath) args.push('--', relativeTo(repoRoot, filePath));

  // allowFailure: в репозитории без коммитов `git log` завершается ошибкой,
  // а это не сбой — просто истории ещё нет.
  const result = await execGit(args, repoRoot, { allowFailure: true });
  return result.ok ? result.stdout : '';
}

export async function logHistory(ctx: HistoryContext, limit = 50, filePath?: string): Promise<GitCommit[]> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

  const count = Math.min(Math.max(Math.round(limit) || 50, 1), 200);
  // Поля разделяем байтом US (0x1f), который git вставляет по `%x1f`: автор или
  // заголовок могут содержать пробелы и двоеточия, и печатный разделитель
  // рано или поздно совпал бы с текстом.
  // `%at` — время коммита секундами: по нему лента истории файла ставит коммиты и
  // снимки редактора в один порядок (`shared/timeline.ts`). Дата без времени для
  // этого груба: два коммита одного дня встали бы не по порядку.
  const args = ['log', `-n${count}`, '--date=short', '--format=%h%x1f%at%x1f%ad%x1f%an%x1f%s'];
  if (filePath) args.push('--', relativeTo(repoRoot, filePath));

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
export async function blame(
  ctx: HistoryContext,
  filePath: string,
  range?: { startLine?: number; endLine?: number },
): Promise<BlameLine[]> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

  // `-L` требует обе границы: если задана только одна, вторую берём из файла.
  const relative = relativeTo(repoRoot, filePath);
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
export async function conflictParts(ctx: HistoryContext, filePath: string): Promise<GitConflictParts> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

  const relative = relativeTo(repoRoot, filePath);
  const [base, ours, theirs] = await Promise.all([
    fromRef(repoRoot, `:1:${relative}`),
    fromRef(repoRoot, `:2:${relative}`),
    fromRef(repoRoot, `:3:${relative}`),
  ]);
  return { base, ours, theirs };
}

export async function logGraph(ctx: HistoryContext, limit = 100): Promise<string> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) return '';
  const result = await execGit(
    ['log', '--graph', '--oneline', '--decorate', '--all', '-n', String(Math.max(Math.trunc(limit), 1))],
    repoRoot,
    { allowFailure: true },
  );
  return result.stdout;
}

/**
 * Сравнение двух ссылок (веток, коммитов, тегов): что между ними изменилось.
 *
 * Запускаем ДВЕ команды вместо одной: `--name-status` говорит, что случилось с
 * файлом, `--numstat` — насколько. Обе с `-z`: тогда пути со спецсимволами
 * (пробел, кириллица, перевод строки в имени) не ломают разбор.
 */
export async function compareRefs(ctx: HistoryContext, base: string, head: string): Promise<GitRefDiff> {
  const repoRoot = await ctx.root();
  const left = refArg(base);
  const right = refArg(head);
  const names = await execGit(['diff', '--name-status', '-z', left, right], repoRoot);
  const stats = await execGit(['diff', '--numstat', '-z', left, right], repoRoot);
  return { base: left, head: right, files: mergeRefDiff(names.stdout, stats.stdout) };
}

/**
 * Сравнение ОДНОГО файла между двумя ссылками: слева содержимое из `base`,
 * справа — из `head`. Блоки не считаем: части правки между ветками индексировать
 * нечего — это просмотр, а не подготовка коммита.
 */
export async function diffRefs(ctx: HistoryContext, base: string, head: string, filePath: string): Promise<GitDiff> {
  const repoRoot = await ctx.root();
  const left = refArg(base);
  const right = refArg(head);
  // Путь приходит абсолютным (как у остальных сравнений) — git же в `ссылка:путь`
  // хочет путь от корня репозитория. Уже относительный оставляем как есть.
  const relative = path.isAbsolute(filePath) ? path.relative(repoRoot, path.resolve(filePath)) : filePath;
  const target = refArg(relative.split(path.sep).join('/'));
  const [original, modified] = await Promise.all([
    fromRef(repoRoot, `${left}:${target}`),
    fromRef(repoRoot, `${right}:${target}`),
  ]);
  return { original, modified, hunks: [] };
}

/** Журнал ссылок: свежие записи — первыми. */
export async function reflog(ctx: HistoryContext, limit = 50): Promise<GitReflogEntry[]> {
  const repoRoot = await ctx.repositoryRoot();
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
