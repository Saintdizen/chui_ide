import path from 'node:path';
import { execGit } from '../git/exec';
import { readStatus } from '../git/status';
import { logText } from '../git/history';
import { optionalInteger, optionalString, requireString } from './tool-args';
import { relativePath } from './agent-terminal';
import type { ToolContext, ToolOutcome } from './tool-context';

/**
 * `git` инструментом: status, diff, log, blame, show — только чтение.
 *
 * Зачем: git шёл через `terminal` — с `cd` впереди, без структуры и без потолка
 * вывода. `git diff` на большой правке — десятки тысяч символов сырого патча, а
 * модели обычно нужны имена файлов и счётчики; `git log` — те же коммиты без
 * формата, который читается.
 *
 * Пишущие операции (commit, checkout, reset, откат файла) сюда сознательно не
 * входят: они меняют дерево без подтверждения человека, а для этого есть
 * `terminal` с карточкой подтверждения. Этот инструмент — глаза.
 */

/** Сколько строк патча отдаём по умолчанию и сколько всего. */
const DIFF_DEFAULT_LINES = 200;
const DIFF_MAX_LINES = 1200;
/** Буквы изменений: домен `GitChange` → нотация `git status --short`. */
const FILE_LETTERS: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
  conflicted: 'U',
};

/** Коммитов в `log` по умолчанию. */
const LOG_DEFAULT = 15;

/**
 * Корень репозитория: спрашиваем git, а не сервис, — так инструмент работает и в
 * тестах, и когда сервис ещё не поднял наблюдатель за репозиторием.
 */
async function repoRoot(ctx: ToolContext): Promise<string | null> {
  const base = ctx.workspace.rootPath();
  if (!base) return null;
  const result = await execGit(['rev-parse', '--show-toplevel'], base, { allowFailure: true });
  return result.ok && result.stdout.trim() ? result.stdout.trim() : null;
}

export async function gitAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = (optionalString(args, 'action') ?? 'status').trim() || 'status';
  const root = await repoRoot(ctx);
  if (!root) {
    return {
      ok: false,
      summary: 'Это не репозиторий git',
      detail: 'В папке проекта нет git — работать с историей не с чем.',
    };
  }
  const projectRoot = ctx.workspace.rootPath();

  switch (action) {
    case 'status':
      return await statusOutcome(root, projectRoot);
    case 'diff':
      return await diffOutcome(root, args);
    case 'log':
      return await logOutcome(ctx, args);
    case 'blame':
      return await blameOutcome(root, args);
    case 'show':
      return await showOutcome(root, args);
    default:
      return {
        ok: false,
        summary: `Неизвестное действие git: ${action}`,
        detail: 'Можно: status, diff, log, blame, show. Пишущие операции — terminal с подтверждением.',
      };
  }
}

/**
 * `status`: ветка, впереди/позади upstream и файлы по группам.
 *
 * Счётчики, а не патчи: «изменено 12 файлов» — то, что нужно знать перед
 * правкой. Что именно поменялось — `diff`.
 */
async function statusOutcome(root: string, projectRoot: string | null): Promise<ToolOutcome> {
  const status = await readStatus(root);
  const repo = status.repository;
  if (!repo) {
    return {
      ok: false,
      summary: 'git status: репозиторий не открылся',
      detail: 'git есть, но статус не прочитать — проверь права на папку .git.',
    };
  }
  const branch = repo.branch ?? (repo.detached ? '(detached)' : '(нет ветки)');
  const ahead = repo.ahead ?? 0;
  const behind = repo.behind ?? 0;
  const divergence = ahead || behind ? `, впереди ${ahead}, позади ${behind}` : '';
  if (status.files.length === 0) {
    return {
      ok: true,
      summary: `git: ${branch}, дерево чистое`,
      detail: `Ветка ${branch}${divergence}. Изменённых файлов нет.`,
    };
  }
  const rows = status.files.map((file) => {
    // Те же буквы, что у `git status --short`: одна колонка — индекс, вторая — дерево.
    const letter = FILE_LETTERS[file.change];
    const flags = `${file.staged ? letter : '.'}${file.unstaged ? letter : '.'}`;
    return `  ${flags} ${relativePath(file.path, projectRoot)}`;
  });
  return {
    ok: true,
    summary: `git: ${branch}, изменено ${status.files.length}`,
    detail:
      `Ветка ${branch}${divergence}. Изменения (индекс, дерево):\n${rows.join('\n')}\n` +
      'Полный текст изменений — git diff (с path — по одному файлу).',
  };
}

/**
 * `diff`: подсчёт по файлам заголовком и сам патч в пределах потолка.
 *
 * Сначала `--stat`: по нему видно, где правка большая и стоит ли её читать.
 * Потолок строк нужен, потому что дифф одного сгенерированного файла бывает
 * на весь контекст.
 */
async function diffOutcome(root: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const file = optionalString(args, 'path');
  const staged = args.staged === true;
  const gitArgs = ['diff', '--no-color'];
  if (staged) gitArgs.push('--cached');
  if (file) gitArgs.push('--', file.startsWith('/') ? path.relative(root, file) : file);

  const stat = await execGit([...gitArgs, '--stat'], root, { allowFailure: true });
  if (!stat.ok || stat.stdout.trim() === '') {
    const where = staged ? 'в индексе' : 'в дереве';
    return {
      ok: true,
      summary: `git diff: пусто ${where}`,
      detail: `Изменений ${where} нет${file ? ` по ${file}` : ''}.`,
    };
  }

  const limit = Math.min(Math.max(optionalInteger(args, 'maxLines') ?? DIFF_DEFAULT_LINES, 1), DIFF_MAX_LINES);
  const patch = await execGit(gitArgs, root, { allowFailure: true });
  const lines = (patch.stdout ?? '').split('\n');
  const shown = lines.slice(0, limit);
  const rest = lines.length - shown.length;
  const tail =
    rest > 0
      ? `\n… (патч длиннее: показаны ${shown.length} строк из ${lines.length}. ` +
        'Сузь до одного файла — path — или увеличь maxLines.)'
      : '';
  return {
    ok: true,
    summary: `git diff${staged ? ' --cached' : ''}: ${Math.max(0, stat.stdout.trim().split('\n').length - 1)} файл(ов)`,
    detail: `Что изменено:\n${stat.stdout.trim()}\n\nПатч:\n${shown.join('\n')}${tail}`,
  };
}

/** `log`: коммиты одной строкой — хеш, дата, автор, тема. */
async function logOutcome(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const limit = Math.min(Math.max(optionalInteger(args, 'limit') ?? LOG_DEFAULT, 1), 100);
  const file = optionalString(args, 'path');
  const root = await repoRoot(ctx);
  if (!root) return { ok: false, summary: 'Это не репозиторий git', detail: 'git не найден.' };
  const text = await logText({ root: () => root ?? '', repositoryRoot: async () => root }, limit, file);
  if (!text.trim()) {
    return { ok: true, summary: 'git log: истории нет', detail: 'Коммитов нет — показать нечего.' };
  }
  return {
    ok: true,
    summary: `git log: ${text.trim().split('\n').length} коммит(ов)${file ? ` по ${file}` : ''}`,
    detail: text.trim(),
  };
}

/** `blame`: кто и когда последний раз трогал строки файла. */
async function blameOutcome(root: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const file = requireString(args, 'path');
  const relative = file.startsWith('/') ? path.relative(root, file) : file;
  const from = optionalInteger(args, 'startLine');
  const to = optionalInteger(args, 'endLine');
  // `-L` — только нужный диапазон: blame всего файла бесполезен, а стоит дорого.
  const gitArgs = ['blame', '--date=short'];
  // Проверка была `if (from && to)` — нулевая строка ложно-ложна в JS, и `0..0`
  // молча отбрасывал диапазон: blame шёл по всему файлу. Заданного конца
  // хватает: второй берём от фиксации.
  if (from !== undefined || to !== undefined) {
    // git считает строки с единицы и на `-L 0,0` падает с `fatal: invalid line
    // number`. Ноль от модели — обычное «с начала», поэтому поднимаем до 1.
    const start = Math.max(1, from ?? 1);
    const stop = Math.max(start, to ?? start);
    gitArgs.push('-L', `${start},${stop}`);
  }
  gitArgs.push('--', relative);
  const result = await execGit(gitArgs, root, { allowFailure: true });
  if (!result.ok || !result.stdout.trim()) {
    return {
      ok: false,
      summary: `git blame: не вышло по ${relative}`,
      detail: 'Файл не отслеживается git или путь неверен. Статус — git status.',
    };
  }
  const lines = result.stdout.trim().split('\n');
  const cap = Math.min(lines.length, DIFF_DEFAULT_LINES * 2);
  return {
    ok: true,
    summary: `git blame: ${relative}, ${lines.length} строк`,
    detail: `${lines.slice(0, cap).join('\n')}${lines.length > cap ? '\n… (дальше — сузь startLine/endLine)' : ''}`,
  };
}

/** `show`: коммит целиком или его подсчёт — что именно поменялось тогда. */
async function showOutcome(root: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const ref = optionalString(args, 'ref') ?? 'HEAD';
  const result = await execGit(['show', '--no-color', '--stat', ref], root, { allowFailure: true });
  if (!result.ok) {
    return {
      ok: false,
      summary: `git show: нет такого коммита — ${ref}`,
      detail: 'Верное имя — из git log: хеш, ветка или HEAD~1.',
    };
  }
  const lines = result.stdout.split('\n');
  // Схема давно обещала `maxLines`, а потолок был жёстким: совет в обрезке
  // («сузь maxLines») выполнить было нечем — любой коммит резался на 200.
  const cap = Math.min(lines.length, optionalInteger(args, 'maxLines') ?? DIFF_DEFAULT_LINES);
  return {
    ok: true,
    summary: `git show ${ref}: ${(lines[0] ?? '').slice(0, 60)}`,
    detail: `${lines.slice(0, cap).join('\n')}${lines.length > cap ? '\n… (коммит длиннее — сузь maxLines или возьми файл через read)' : ''}`,
  };
}
