import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type GitRebaseResult, type GitStatus, RpcErrorCode } from '../../shared/api';
import { formatRebaseTodo, type RebaseTodoItem, validateRebaseTodo } from '../../shared/git-rebase';
import { RpcFailure } from '../ipc/router';
import type { RepositoryContext, StatusContext, GitDirContext } from './contexts';
import { execGit, type GitResult } from './exec';

export interface RebaseContext extends RepositoryContext, StatusContext, GitDirContext {}

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

/**
 * Интерактивный rebase последних `count` коммитов.
 *
 * `git rebase -i` открывает редактор со списком шагов. Мы его не показываем, а
 * подставляем свой: скрипт кладёт на место файла git наш готовый список
 * (`CHUI_REBASE_TODO`). Тем же приёмом подменяем редактор сообщений — он нужен
 * для `reword`. Скрипты пишем во временный каталог и запускаем тем же Node, что
 * и IDE (`process.execPath` + `ELECTRON_RUN_AS_NODE`), — тогда не зависим от
 * того, есть ли `node`/`sh` в PATH у пользователя.
 */
export async function rebase(
  ctx: RebaseContext,
  count: number,
  items: readonly RebaseTodoItem[],
): Promise<GitRebaseResult> {
  const repoRoot = await ctx.root();
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
    const originals = await commitMessages(repoRoot, depth);
    const messages: Record<string, string> = {};
    for (const item of items) {
      if (item.action !== 'reword' || !item.message?.trim()) continue;
      const original = originals.get(item.commit) ?? originals.get(await fullHash(repoRoot, item.commit));
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

    const result = await execGit(['rebase', '-i', `HEAD~${depth}`], repoRoot, {
      allowFailure: true,
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        CHUI_REBASE_TODO: todoPath,
        CHUI_REBASE_MESSAGES: messagesPath,
        GIT_SEQUENCE_EDITOR: editorCommand(sequenceEditor),
        GIT_EDITOR: editorCommand(messageEditor),
      },
    });
    return rebaseOutcome(ctx, repoRoot, result);
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Продолжить остановленный rebase (конфликт разрешён или шаг `edit` закончен). */
export async function rebaseContinue(ctx: RebaseContext): Promise<GitRebaseResult> {
  const repoRoot = await ctx.root();
  // Редактор сообщений тут не нужен: git берёт готовое сообщение (или уже поправленное).
  const result = await execGit(['rebase', '--continue'], repoRoot, { allowFailure: true });
  return rebaseOutcome(ctx, repoRoot, result);
}

/** Пропустить текущий коммит остановленного rebase. */
export async function rebaseSkip(ctx: RebaseContext): Promise<GitRebaseResult> {
  const repoRoot = await ctx.root();
  const result = await execGit(['rebase', '--skip'], repoRoot, { allowFailure: true });
  return rebaseOutcome(ctx, repoRoot, result);
}

/** Прервать rebase: ветка возвращается туда, где была до запуска. */
export async function rebaseAbort(ctx: RebaseContext): Promise<GitStatus> {
  const repoRoot = await ctx.root();
  await execGit(['rebase', '--abort'], repoRoot);
  return ctx.refresh();
}

/**
 * Итог операции rebase. Rebase не всегда завершается: он останавливается на
 * конфликте или на шаге `edit`, и тогда нужно знать, что он ещё идёт
 * (`.git/rebase-merge`), и есть ли неразрешённые конфликты в индексе.
 */
async function rebaseOutcome(ctx: RebaseContext, repoRoot: string, result: GitResult): Promise<GitRebaseResult> {
  const status = await ctx.refresh();
  const inProgress = await rebaseInProgress(ctx, repoRoot);
  const conflict = await hasConflicts(repoRoot);
  const text = (result.stderr.trim() || result.stdout.trim()).trim();
  const message = text || (result.ok && !inProgress ? 'Rebase завершён' : 'Rebase не выполнен');
  return { ok: result.ok && !inProgress, inProgress, conflict, message, status };
}

/** Идёт ли rebase прямо сейчас: git держит своё состояние в каталоге `.git`. */
async function rebaseInProgress(ctx: RebaseContext, repoRoot: string): Promise<boolean> {
  const gitDir = await ctx.gitPath(repoRoot, 'rebase-merge');
  const applyDir = await ctx.gitPath(repoRoot, 'rebase-apply');
  for (const dir of [gitDir, applyDir]) {
    const stat = dir ? await fs.stat(dir).catch(() => null) : null;
    if (stat?.isDirectory()) return true;
  }
  return false;
}

/** Есть ли в индексе неразрешённые конфликты (`git ls-files -u`). */
async function hasConflicts(repoRoot: string): Promise<boolean> {
  const result = await execGit(['ls-files', '-u'], repoRoot, { allowFailure: true });
  return result.ok && result.stdout.trim() !== '';
}

/** Сообщения последних `depth` коммитов: полный хеш → текст. */
async function commitMessages(repoRoot: string, depth: number): Promise<Map<string, string>> {
  const result = await execGit(['log', '-n', String(depth), '--no-color', '--format=%H%x1f%B%x1e'], repoRoot, {
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

/** Полный хеш коммита по сокращённому. */
async function fullHash(repoRoot: string, commit: string): Promise<string> {
  const result = await execGit(['rev-parse', '--verify', commit.trim()], repoRoot, { allowFailure: true });
  return result.ok ? result.stdout.trim() : '';
}

function editorCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`;
}
