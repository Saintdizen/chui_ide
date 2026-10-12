/**
 * Рабочая область: один или несколько корней (папок) в одном окне.
 *
 * Обычно проект — одна папка, и всё в IDE считает от неё. Но бывает и несколько:
 * репозиторий с фронтендом рядом с бэкендом, микросервисы, чужая библиотека, которую
 * правишь заодно. Тогда «корень» — не один: у каждого своя папка, свои правила
 * исключения и свой наблюдатель, а вместе они и есть рабочая область.
 *
 * Здесь — только модель и правила работы с путями, общие для main и renderer:
 * какой корень вмещает путь, как показать путь относительно корней, как добавить
 * и убрать корень. Ни ФС, ни процессов: их дело — в main (`workspace/workspace.ts`).
 *
 * Разделитель пути берётся из самого пути (`shared/paths`): на Windows это обратные
 * слэши, и жёстко резать по «/» нельзя.
 */

import { isInsidePath, nameOf, pathAfter } from './paths';

/** Корень рабочей области: папка и её короткое имя. */
export interface WorkspaceRoot {
  /** Абсолютный путь папки. */
  root: string;
  /** Короткое имя — из последнего сегмента пути. */
  name: string;
}

/** Свести список путей к корням: без повторов, в порядке появления. */
export function normalizeRootList(paths: readonly string[]): WorkspaceRoot[] {
  const roots: WorkspaceRoot[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const root = trimTrailing(raw);
    if (root === '' || seen.has(root)) continue;
    seen.add(root);
    roots.push({ root, name: nameOf(root) || root });
  }
  return roots;
}

/** Путь без хвостовых разделителей: сравнивать и показывать его так вернее. */
function trimTrailing(target: string): string {
  return target.replace(/[/\\]+$/, '');
}

/**
 * Самый ГЛУБОКИЙ корень, вмещающий путь: файл принадлежит тому корню, который
 * ближе всего. Если корни вложены (внутри проекта открыли ещё одну папку), файл
 * из вложенной папки относится к ней, а не к внешнему проекту.
 */
export function rootForPath(roots: readonly WorkspaceRoot[], target: string): WorkspaceRoot | null {
  const clean = trimTrailing(target);
  let found: WorkspaceRoot | null = null;
  for (const candidate of roots) {
    if (!isInsidePath(candidate.root, clean)) continue;
    if (!found || candidate.root.length > found.root.length) found = candidate;
  }
  return found;
}

/**
 * Путь относительно самого глубокого вмещающего корня — так его показывают дерево,
 * крошки и заголовок вкладки. Файл вне всех корней остаётся как есть.
 */
export function relativeToRoots(roots: readonly WorkspaceRoot[], target: string): string {
  const owner = rootForPath(roots, target);
  return owner ? pathAfter(owner.root, target) : target;
}

/** Корень с таким путём (сравнение с точностью до хвостовых разделителей). */
export function hasRoot(roots: readonly WorkspaceRoot[], root: string): boolean {
  const clean = trimTrailing(root);
  return roots.some((item) => item.root === clean);
}

/** Добавить корень к списку: уже есть — список не меняется. */
export function appendRoot(roots: readonly WorkspaceRoot[], root: string): WorkspaceRoot[] {
  if (hasRoot(roots, root)) return [...roots];
  return [...roots, ...normalizeRootList([root])];
}

/** Убрать корень из списка. */
export function removeRoot(roots: readonly WorkspaceRoot[], root: string): WorkspaceRoot[] {
  const clean = trimTrailing(root);
  return roots.filter((item) => item.root !== clean);
}

/**
 * Корень, который становится активным после удаления нынешнего: первый оставшийся
 * (или `null`, если корней не осталось). Активный корень задаёт, что видит git,
 * поиск и запуск, когда файл не назван явно.
 */
export function nextActiveRoot(roots: readonly WorkspaceRoot[], removed: string): string | null {
  const left = removeRoot(roots, removed);
  return left[0]?.root ?? null;
}

/** Подпись рабочей области: имя одинокого корня или число папок. */
export function workspaceLabel(roots: readonly WorkspaceRoot[]): string {
  if (roots.length === 0) return 'нет папки';
  if (roots.length === 1) return roots[0]!.name;
  return `${roots.length} папки`;
}
