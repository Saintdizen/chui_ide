/**
 * Ход по дереву проводника с клавиатуры.
 *
 * Логика отдельным чистым модулем по той же причине, что и выделение
 * (`tree-selection.ts`): порядок строк и что значит «вниз» — это правило, а не
 * отрисовка. Отрисовке остаётся выделить строку и прокрутить к ней.
 *
 * ПОЧЕМУ ЭТО ЗДЕСЬ. Стрелки в дереве не работали вовсе: `onTreeKey` знал
 * `Enter`/`F2`/`Delete`, а хода не было — и комментарий в `explorer.ts` честно
 * объяснял, почему не объявлен `role="treeitem"`: мол, нельзя объявить роль,
 * не выполнив её клавиатурный договор. Не объявлять роль без хода — верно, но и
 * оставлять без стрелок значит, что добраться до файла можно только мышью.
 * Верное лечение — сначала ход, потом роль.
 */

/** Строка дерева в том виде, в каком она видна на экране. */
export interface WalkRow {
  readonly path: string;
  readonly depth: number;
  /** Каталог ли это: у файла `Right` не раскрывает, а `Left` не сворачивает. */
  readonly directory: boolean;
  readonly expanded: boolean;
}

export type WalkKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'Enter';

export type WalkAction =
  | { readonly kind: 'move'; readonly path: string }
  | { readonly kind: 'expand'; readonly path: string }
  | { readonly kind: 'collapse'; readonly path: string }
  | { readonly kind: 'open'; readonly path: string };

/**
 * Куда ведёт нажатие.
 *
 * Договор взят не из головы, а из того, к чему человек привык в проводнике:
 * `Up`/`Down` — соседняя строка; `Right` у свёрнутой папки раскрывает, у
 * раскрытой — уходит к первому ребёнку, у файла не делает ничего;
 * `Left` у раскрытой папки сворачивает, у свёрнутой — поднимается к родителю;
 * `Home`/`End` — край списка; `Enter` — открыть.
 *
 * `null` — нажатие ничего не значит (дерево пусто, край достигнут, строка не
 * выбрана): вызывающему нечего делать, и он не должен ничего предотвращать.
 */
export function walkTree(rows: readonly WalkRow[], current: string | null, key: WalkKey): WalkAction | null {
  if (rows.length === 0) return null;

  // Выделения нет — любое движение начинается с края: так дерево оживает по
  // стрелке, даже если до этого в него только ткнули.
  const at = current === null ? -1 : rows.findIndex((row) => row.path === current);
  if (at < 0) {
    const first = key !== 'ArrowUp' && key !== 'ArrowLeft';
    return move(rows, first ? 0 : rows.length - 1);
  }

  const row = rows[at]!;
  switch (key) {
    case 'ArrowUp':
      return at > 0 ? move(rows, at - 1) : null;
    case 'ArrowDown':
      return at < rows.length - 1 ? move(rows, at + 1) : null;
    case 'Home':
      return at === 0 ? null : move(rows, 0);
    case 'End':
      return at === rows.length - 1 ? null : move(rows, rows.length - 1);
    case 'Enter':
      return { kind: 'open', path: row.path };
    case 'ArrowRight': {
      if (!row.directory) return null;
      if (!row.expanded) return { kind: 'expand', path: row.path };
      // Раскрыта — внутрь, к первому ребёнку (он идёт сразу за папкой).
      const next = rows[at + 1];
      return next && next.depth > row.depth ? move(rows, at + 1) : null;
    }
    case 'ArrowLeft': {
      if (row.directory && row.expanded) return { kind: 'collapse', path: row.path };
      // К родителю: ближайшая строка выше с меньшей глубиной. У корня родителя
      // нет — по `Left` не уходим в никуда.
      for (let index = at - 1; index >= 0; index -= 1) {
        const candidate = rows[index]!;
        if (candidate.depth < row.depth) return move(rows, index);
      }
      return null;
    }
  }
}

function move(rows: readonly WalkRow[], index: number): WalkAction | null {
  const row = rows[index];
  return row ? { kind: 'move', path: row.path } : null;
}
