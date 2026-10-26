import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { execGit } from './exec';
import type { GitChange, GitFileStatus, GitRepository, GitStatus } from '../../shared/api';

/**
 * Прочитать статус репозитория.
 *
 * Вызов отдельно от разбора: разбор нужен и там, где текст уже есть, а здесь
 * важен сам запуск. Флаги не случайны: `v2` — машиночитаемый формат, `-z` —
 * имена без экранирования (пробелы и кириллица в путях не ломаются),
 * `--untracked-files=all` — нераспознанные файлы видны внутри папок, а не
 * целой папкой. `--branch` добавляет строку с веткой и расхождением с upstream.
 */
export async function readStatus(repoRoot: string): Promise<GitStatus> {
  const result = await execGit(['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'], repoRoot);
  return parseStatus(result.stdout, repoRoot);
}

/**
 * Разбор `git status --porcelain=v2 -z`.
 *
 * Живёт вне класса: функции нужны только текст ответа и корень репозитория,
 * состояния `GitService` не требуется ни строкой.
 */
export function parseStatus(stdout: string, repoRoot: string): GitStatus {
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
      files.push(makeFile(parts[1] ?? '', parts.slice(8).join(' '), repoRoot));
    } else if (token.startsWith('2 ')) {
      // У переименования два пути: новый в самой записи, старый — следующим токеном.
      const parts = token.split(' ');
      index += 1;
      files.push(makeFile(parts[1] ?? '', parts.slice(9).join(' '), repoRoot));
    } else if (token.startsWith('u ')) {
      const parts = token.split(' ');
      files.push(makeFile('UU', parts.slice(10).join(' '), repoRoot, 'conflicted'));
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
function makeFile(xy: string, relative: string, repoRoot: string, forced?: GitChange): GitFileStatus {
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

/**
 * Каталог метаданных репозитория: за ним следим, чтобы увидеть чужую git-операцию.
 *
 * У обычного репозитория это `<root>/.git`, но у рабочего дерева (worktree,
 * подмодуль) `.git` — ФАЙЛ со ссылкой `gitdir: <путь>`: тогда идём по ссылке.
 * Не репозиторий или битая ссылка — `null`: следить не за чем.
 */
export function repositoryMetaDir(repoRoot: string): string | null {
  const dotGit = path.join(repoRoot, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    const target = match?.[1]?.trim();
    if (!target) return null;
    const dir = path.resolve(repoRoot, target);
    return statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Ключи в `.git/config` этого репозитория. `-f <путь> --replace-all` ключ заменяет,
 * `--unset-all` с пустым значением его убирает; глобальный конфиг в правке не участвует.
 *
 * Почему не `git config --local`: тот сам ищет `.git` и на рабочем дереве
 * (`.git` — файл со ссылкой) берёт не тот файл.
 */
export async function writeLocalConfig(repoRoot: string, patch: Array<{ key: string; value: string }>): Promise<void> {
  const configPath = path.join(repoRoot, '.git', 'config');
  for (const item of patch) {
    const args =
      item.value === ''
        ? ['config', '-f', configPath, '--unset-all', item.key]
        : ['config', '-f', configPath, '--replace-all', item.key, item.value];
    // Ключа могло и не быть — для нас это не ошибка, тон же, что у `--local --unset`.
    await execGit(args, repoRoot, { allowFailure: true });
  }
}
