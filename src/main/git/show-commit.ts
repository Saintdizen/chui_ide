import type { CommitFile, CommitShow } from '../../shared/api/git';
import type { RepositoryContext } from './contexts';
import { execGit } from './exec';

/**
 * Полное представление коммита: заголовок и файлы с числом строк.
 *
 * `git show --stat --numstat` в одном вызове: `--stat` даёт строку «3 files
 * changed», `--numstat` — машиночитаемые пары «+	-	путь» (бинарные файлы
 * пишут `-` вместо чисел).
 */
export async function commitShow(ctx: RepositoryContext, hash: string): Promise<CommitShow> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) return { hash, summary: '', files: [], truncated: false };

  // `--format=%s` — только заголовок; без `--no-patch` и без `-p`, чтобы не
  // тянуть весь текст правки: он нужен при клике, а не для списка файлов.
  const result = await execGit(
    ['show', '--numstat', '--format=%s', '--no-renames', hash],
    repoRoot,
    { allowFailure: true },
  );
  const lines = result.stdout.split('\n');
  const summary = (lines[0] ?? '').trim();

  const status = await commitFileStatus(repoRoot, hash);
  const files = parseNumstat(lines.slice(1), status);

  const MAX_FILES = 2000;
  return {
    hash,
    summary,
    files: files.slice(0, MAX_FILES),
    truncated: files.length > MAX_FILES,
  };
}

/**
 * Разбор строк `git show --numstat`: `добавлено\tудалено\tпуть`.
 *
 * Отдельной функцией, потому что это единственное здесь, что можно проверить
 * без git: бинарник печатает `-` вместо чисел, путь может содержать табуляцию
 * (тогда частей больше трёх), а строка статуса в выводе лишняя.
 */
export function parseNumstat(
  lines: readonly string[],
  status: ReadonlyMap<string, CommitFile['status']>,
): CommitFile[] {
  const files: CommitFile[] = [];
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [added, removed, ...rest] = parts;
    // Путь собираем из хвоста: имя с табуляцией не должно терять часть.
    const path = rest.join('\t');
    if (path.length === 0) continue;
    files.push({
      path,
      status: status.get(path) ?? 'other',
      // `-` вместо числа — бинарный файл: ноль правок честнее выдуманной цифры.
      insertions: numberOrZero(added),
      deletions: numberOrZero(removed),
    });
  }
  return files;
}

function numberOrZero(value: string | undefined): number {
  if (value === undefined || value === '-') return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Статусы файлов из `--name-status`. Отдельный вызов: в `--numstat` статуса нет,
 * а без него «удалён» и «изменён» различались бы только нулём строк.
 */
async function commitFileStatus(repoRoot: string, hash: string): Promise<Map<string, CommitFile['status']>> {
  const map = new Map<string, CommitFile['status']>();
  const result = await execGit(['show', '--name-status', '--format=', '--no-renames', hash], repoRoot, {
    allowFailure: true,
  });
  for (const line of result.stdout.split('\n')) {
    const [code, ...rest] = line.split('\t');
    const file = rest.join('\t');
    if (!code || file.length === 0) continue;
    const letter = code[0];
    map.set(
      file,
      letter === 'A'
        ? 'added'
        : letter === 'D'
          ? 'deleted'
          : letter === 'R'
            ? 'renamed'
            : letter === 'M'
              ? 'modified'
              : 'other',
    );
  }
  return map;
}
