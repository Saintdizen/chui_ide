/**
 * Выделение в дереве проводника: одна строка, несколько и диапазон.
 *
 * Логика вынесена из отрисовки (`ui/explorer.ts`) отдельным чистым модулем: по
 * клику она получает порядок видимых строк и решает, что считать выделенным. Так
 * поведение (обычный клик, `Ctrl`/`Cmd` — точечно, `Shift` — диапазон) проверяется
 * тестами, а отрисовке остаётся только раскрасить строки.
 *
 * Порядок путей — это порядок строк в дереве, а не порядок кликов: операции над
 * выделением (удаление, перенос) идут сверху вниз, как читается список.
 */

export type TreeClickMode = 'single' | 'toggle' | 'range';

export interface TreeSelection {
  /** Выделенные пути в порядке строк дерева. */
  readonly paths: readonly string[];
  /** Путь, от которого отсчитывается диапазон (`Shift`). `null` — выделения нет. */
  readonly anchor: string | null;
}

export const EMPTY_SELECTION: TreeSelection = { paths: [], anchor: null };

/** Расставить пути по порядку строк дерева; чужие (их нет в списке) — следом. */
function inTreeOrder(ordered: readonly string[], wanted: Iterable<string>): string[] {
  const set = new Set(wanted);
  const result = ordered.filter((path) => set.has(path));
  // Путь, пропавший из списка (папку свернули), не выбрасываем: исчезнувшее
  // выделение выглядело бы поломкой.
  for (const path of set) if (!result.includes(path)) result.push(path);
  return result;
}

export function isSelected(selection: TreeSelection, path: string): boolean {
  return selection.paths.includes(path);
}

/**
 * Новое выделение после клика по `path`.
 *
 * `single` — только эта строка; `toggle` — добавить/снять одну (её же делает
 * якорем); `range` — всё от якоря до кликнутой строки включительно. Якоря нет
 * (или он вне видимых строк) — диапазон вырождается в одну строку: честнее, чем
 * тянуть выделение наугад.
 */
export function clickSelection(
  selection: TreeSelection,
  ordered: readonly string[],
  path: string,
  mode: TreeClickMode,
): TreeSelection {
  if (mode === 'single') return { paths: [path], anchor: path };

  if (mode === 'toggle') {
    if (isSelected(selection, path)) {
      return { paths: selection.paths.filter((item) => item !== path), anchor: path };
    }
    return { paths: inTreeOrder(ordered, [...selection.paths, path]), anchor: path };
  }

  const from = selection.anchor === null ? -1 : ordered.indexOf(selection.anchor);
  const to = ordered.indexOf(path);
  if (from < 0 || to < 0) return { paths: [path], anchor: path };
  const bounds = from <= to ? [from, to] : [to, from];
  return { paths: ordered.slice(bounds[0]!, bounds[1]! + 1), anchor: selection.anchor };
}

/**
 * Убрать пути, которых больше нет. Зовётся после перечитывания дерева: файл мог
 * исчезнуть (удалили извне), и держать его выделенным нельзя — следующая операция
 * над выделением споткнулась бы о несуществующий путь.
 */
export function normalizeSelection(selection: TreeSelection, existing: ReadonlySet<string>): TreeSelection {
  const paths = selection.paths.filter((path) => existing.has(path));
  const anchor =
    selection.anchor !== null && existing.has(selection.anchor) ? selection.anchor : (paths.at(-1) ?? null);
  return { paths, anchor };
}
