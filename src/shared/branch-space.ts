/**
 * Пространство, в котором идёт задача: каталог и ветка.
 *
 * Задача может работать не в главном дереве, а в отдельном (git worktree).
 * Тогда в шапке надо написать, где именно она работает, и дать кнопку
 * «применить к рабочему дереву» — иначе человек не понимает, почему правки
 * агента не видны в его дереве, и ищет их в git status главного каталога.
 */
export interface BranchSpace {
  /** Корень, в котором работает задача. */
  root: string;
  /** Ветка; null — не репозиторий, ветки нет или состояние непонятно. */
  branch: string | null;
  /** Задача в отдельном рабочем каталоге, а не в главном. */
  worktree: boolean;
}

/** Слишком длинная ветка неудобна в шапке и в git; столько хватит. */
const BRANCH_SLUG_LIMIT = 40;

/**
 * Имя ветки из заголовка беседы: `chui/<слаг>`.
 *
 * - Берём только латиницу и цифры: кириллица в git работает, но в выводе
 *   команд и в пути каталога она делает ссылки нечитаемыми.
 * - Латиницы в заголовке может и не быть («Почини это») — тогда ветка
 *   называется просто `chui/task`, а номер добавит `uniqueBranchName`.
 */
export function taskBranchName(title: string): string {
  return `chui/${slugOf(title) || 'task'}`;
}

/**
 * Имя без повтора: если такая ветка уже есть, добавляем номер.
 * Иначе второй запуск той же задачи упрётся в «ветка уже существует».
 */
export function uniqueBranchName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.trim()));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const next = `${base}-${index}`;
    if (!used.has(next)) return next;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Куда ставить рабочий каталог задачи: рядом с проектом, в скрытой папке.
 * Слэш имени ветки заменяется — иначе `chui/x` создал бы вложенные каталоги,
 * и уборка одного каталога потребовала бы знания глубины.
 */
export function worktreePathFor(root: string, branch: string): string {
  const separator = root.includes('\\') ? '\\' : '/';
  const trimmed = root.replace(/[\\/]+$/, '');
  const folder = branch.trim().replace(/[\\/]+/g, '-');
  return `${trimmed}${separator}.chui${separator}worktrees${separator}${folder}`;
}

/** Что написать в шапке: где работает задача, словами, а не путём целиком. */
export function describeBranchSpace(space: BranchSpace, mainRoot?: string | null): string {
  const where = space.worktree ? 'отдельный каталог' : 'главное дерево';
  const branch = space.branch ? `ветка ${space.branch}` : 'ветка неизвестна';
  if (!space.worktree) return branch;
  // Каталог показываем хвостом пути: полный адрес в шапку не влезает.
  const tail = lastSegments(space.root, 2);
  const relative =
    mainRoot && space.root.startsWith(mainRoot) ? space.root.slice(mainRoot.length).replace(/^[\\/]+/, '') : '';
  return `${branch} · ${where} ${relative || tail}`;
}

/** Задача идёт не в том каталоге, который человек видит деревом, — надо сказать прямо. */
export function isForeignSpace(space: BranchSpace, currentRoot: string | null): boolean {
  if (!currentRoot) return false;
  return normalize(space.root) !== normalize(currentRoot);
}

function lastSegments(target: string, count: number): string {
  const parts = target.split(/[\\/]+/).filter(Boolean);
  return parts.slice(-count).join('/');
}

function slugOf(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean);
  let slug = '';
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > BRANCH_SLUG_LIMIT) break;
    slug = next;
  }
  return slug;
}

function normalize(target: string): string {
  return target.replace(/[\\/]+$/, '').replace(/\\/g, '/');
}
