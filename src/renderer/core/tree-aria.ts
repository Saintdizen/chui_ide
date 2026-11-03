/**
 * Положение строки дерева для читалки: уровень, номер среди соседей, сколько
 * соседей всего.
 *
 * `aria-level` и `aria-expanded` читалка переживёт и без номера, но без
 * `aria-setsize`/`aria-posinset` она не скажет «3 из 12» — а без этого человек
 * не понимает, сколько ещё листать. Считать надо по РОДИТЕЛЮ: у каждой папки
 * свой набор, и «3 из 12» для ребёнка значит совсем не то, что для корня.
 *
 * Модуль чистый: порядок строк и раскрытие ему дают снаружи, DOM он не знает.
 */
export interface AriaRow {
  readonly path: string;
  readonly depth: number;
}

export interface AriaPosition {
  /** 1-based уровень: корень — 1. */
  readonly level: number;
  /** 1-based место среди соседей по родителю. */
  readonly posInSet: number;
  /** Сколько всего соседей у этого родителя в видимом дереве. */
  readonly setSize: number;
}

/**
 * Позиция каждой строки в наборе.
 *
 * Соседи — строки того же уровня, идущие ПОСЛЕ родителя до первой строки с
 * меньшим или равным уровнем. Считаем по видимому набору: у свёрнутой папки
 * детей в наборе нет, и `setSize` у неё — 1 (сама), как и просит договор
 * (невидимых детей в набор не берём).
 */
export function ariaPositions(rows: readonly AriaRow[]): Map<string, AriaPosition> {
  // Один проход, а не поиск родителя для каждой пары: на большой папке это
  // заметная разница (дерево перерисовывается часто), а правило то же.
  const result = new Map<string, AriaPosition>();
  const parentOf: number[] = [];
  const stack: number[] = [];
  const counts = new Map<number, number>();
  const seen = new Map<number, number>();

  rows.forEach((row, index) => {
    while (stack.length > 0 && rows[stack[stack.length - 1]!]!.depth >= row.depth) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1]! : -1;
    parentOf[index] = parent;
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
    stack.push(index);
  });
  // Второй проход — теперь, когда `setSize` каждого родителя известен.
  rows.forEach((row, index) => {
    const parent = parentOf[index]!;
    const place = (seen.get(parent) ?? 0) + 1;
    seen.set(parent, place);
    result.set(row.path, { level: row.depth + 1, posInSet: place, setSize: counts.get(parent) ?? 1 });
  });
  return result;
}
