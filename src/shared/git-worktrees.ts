/**
 * Дополнительные рабочие каталоги одного репозитория (`git worktree`).
 *
 * Worktree — это ещё одна папка, где тот же репозиторий выложен на другой ветке (или
 * на том же коммите). Удобно, когда параллельно работаешь над двумя ветками: не нужно
 * переключаться, каждый каталог держит своё состояние и свой индекс. Главный каталог —
 * тоже worktree, первый в списке.
 *
 * Разбираем `git worktree list --porcelain`: по блоку на каталог, поля построчные.
 * Это чистая работа с текстом — её видно в тестах без git.
 */

export interface GitWorktree {
  /** Абсолютный путь каталога. */
  path: string;
  /** Коммит, на котором стоит каталог. */
  head: string;
  /** Короткое имя ветки; `null` — отделённый указатель (detached). */
  branch: string | null;
  /** Голый репозиторий (без рабочего дерева). */
  bare: boolean;
  /** Заблокирован ли (и почему); `null` — не заблокирован. */
  locked: string | null;
  /** Помечен ли на удаление (и почему); `null` — нет. */
  prunable: string | null;
}

/** `refs/heads/feature` → `feature`: в списке ветку зовём привычно. */
function shortBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

/**
 * Разбор `git worktree list --porcelain`. Блоки разделены пустой строкой; в каждом —
 * строки `поле [значение]`. Незнакомые поля пропускаем: git их со временем добавляет,
 * а сломать из-за этого разбор нельзя.
 */
export function parseWorktrees(stdout: string): GitWorktree[] {
  const result: GitWorktree[] = [];
  let current: Partial<GitWorktree> | null = null;

  const flush = (): void => {
    if (!current?.path) return;
    result.push({
      path: current.path,
      head: current.head ?? '',
      branch: current.branch ?? null,
      bare: current.bare ?? false,
      locked: current.locked ?? null,
      prunable: current.prunable ?? null,
    });
  };

  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd();
    if (!line) {
      flush();
      current = null;
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    current ??= {};
    // У `locked`/`prunable` значение — причина, и её может не быть. Для нашего вида
    // важно лишь «есть пометка»: пустая причина тоже значит «заблокирован».
    if (key === 'worktree') current.path = value;
    else if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = shortBranch(value);
    else if (key === 'detached') current.branch = null;
    else if (key === 'bare') current.bare = true;
    else if (key === 'locked') current.locked = value || 'заблокирован';
    else if (key === 'prunable') current.prunable = value || 'можно удалить';
  }
  flush();
  return result;
}

/** Заголовок каталога для списка: ветка или «отделённый указатель». */
export function worktreeLabel(worktree: GitWorktree): string {
  if (worktree.bare) return 'голый репозиторий';
  if (worktree.branch) return worktree.branch;
  return 'отделённый указатель';
}
