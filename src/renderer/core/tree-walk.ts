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

export type WalkKey =
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown'
  | 'Enter'
  | 'Star'
  | 'Space'
  | 'F2'
  | 'Delete'
  | 'ContextMenu';

export type WalkAction =
  | { readonly kind: 'move'; readonly path: string }
  | { readonly kind: 'expand'; readonly path: string }
  | { readonly kind: 'collapse'; readonly path: string }
  | { readonly kind: 'open'; readonly path: string }
  // Папка по `Enter` — раскрыть. Отдельное действие, а не `open`: у файла
  // открытие значит «показать в редакторе», у папки — другое.
  | { readonly kind: 'toggle'; readonly path: string }
  | { readonly kind: 'peek'; readonly path: string }
  | { readonly kind: 'rename'; readonly path: string }
  | { readonly kind: 'delete'; readonly paths: readonly string[] }
  | { readonly kind: 'menu'; readonly path: string }
  | { readonly kind: 'expandAll'; readonly paths: readonly string[] };

/**
 * Куда ведёт нажатие.
 *
 * Договор взят не из головы, а из того, к чему человек привык в проводнике:
 * `Up`/`Down` — соседняя строка; `Right` у свёрнутой папки раскрывает, у
 * раскрытой — уходит к первому ребёнку, у файла не делает ничего;
 * `Left` у раскрытой папки сворачивает, у свёрнутой — поднимается к родителю;
 * `Home`/`End` — край списка; `Enter` — открыть; `Space` — показать файл, не
 * открывая вкладку; `F2` — переименовать; `Delete` — удалить; клавиша меню
 * (`ContextMenu`, она же `Shift+F10`) — контекстное меню строки.
 *
 * `Delete` без выбранной строки не значит ничего: у «удалить» нет разумной цели
 * по умолчанию, и нажатие в пустом дереве не должно сносить первый файл.
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
    // Клавиши, которые бьют по конкретной строке (удалить, переименовать,
    // открыть), без выделения молчат: у них нет разумной цели по умолчанию,
    // а «первая строка» по умолчанию — это удаление первого файла с одного
    // ударения. Движение и края работают как раньше.
    if (NAMED_ROW_KEYS.has(key)) return null;
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
      // Папка по `Enter` раскрывается, а не «открывается»: открытие вкладки у
      // неё значит не то же, что у файла. Так же ведут себя проводники, к которым
      // человек привык (JetBrains, Zed): `Enter` на ветке — это её раскрыть, а
      // открыть файл внутри можно стрелкой и тем же `Enter`.
      return row.directory ? { kind: 'toggle', path: row.path } : { kind: 'open', path: row.path };
    case 'Space':
      return { kind: 'peek', path: row.path };
    case 'F2':
      return { kind: 'rename', path: row.path };
    case 'Delete':
      return { kind: 'delete', paths: [row.path] };
    case 'ContextMenu':
      return { kind: 'menu', path: row.path };
    case 'Star': {
      // Раскрыть всех папок-соседей одного уровня (договор APG для «*»).
      // Файлы и уже раскрытые в набор не попадают: вызывающему незачем их трогать.
      const parent = parentOf(rows, at);
      const paths: string[] = [];
      for (let index = 0; index < rows.length; index += 1) {
        const other = rows[index]!;
        if (other.depth !== row.depth || parentOf(rows, index) !== parent) continue;
        if (other.directory && !other.expanded) paths.push(other.path);
      }
      return paths.length > 0 ? { kind: 'expandAll', paths } : null;
    }
    case 'PageUp':
      return at > 0 ? move(rows, Math.max(0, at - PAGE)) : null;
    case 'PageDown':
      return at < rows.length - 1 ? move(rows, Math.min(rows.length - 1, at + PAGE)) : null;
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

/**
 * Сколько строк прыгает `PageUp`/`PageDown`.
 *
 * Число не по высоте окна: высота у проводника меняется, а прыжок на «страницу»
 * в 15 строк читается одинаково и на минимуме, и на полном экране. Реального
 * размера окна чистый модуль не знает — и знать не должен.
 */
const PAGE = 15;

/** Клавиши, которые без выделения не знают, к чему относятся: молчат. */
const NAMED_ROW_KEYS: ReadonlySet<WalkKey> = new Set<WalkKey>([
  'Enter',
  'Space',
  'F2',
  'Delete',
  'ContextMenu',
]);

/** Индекс родителя строки: ближайшая выше с меньшей глубиной (`-1` — корень). */
function parentOf(rows: readonly WalkRow[], index: number): number {
  const depth = rows[index]!.depth;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (rows[cursor]!.depth < depth) return cursor;
  }
  return -1;
}

function move(rows: readonly WalkRow[], index: number): WalkAction | null {
  const row = rows[index];
  return row ? { kind: 'move', path: row.path } : null;
}
