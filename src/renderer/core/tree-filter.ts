/**
 * Фильтр дерева проводника: какие строки оставить, когда в поле ввода набран
 * запрос.
 *
 * Дерево — не плоский список: у строки есть родитель, и спрятать папку, внутри
 * которой нашлось совпадение, значит спрятать само совпадение. Поэтому фильтр
 * работает как «оставить путь»: строка проходит, если совпала сама или совпал
 * кто-то из её потомков. Иначе говоря, при запросе `util` в списке должны
 * остаться `src`, `src/util` и файлы внутри `src/util`, а `docs` — исчезнуть.
 *
 * Совпадение — подстрока без учёта регистра. Это намеренно проще нечёткого
 * поиска из quick-open: там ищут файл по всему проекту и цена промаха — ещё один
 * запрос, а здесь фильтр листает дерево по мере набора, и предсказуемость важнее
 * снисходительности. `src/utl` не должен внезапно находить `src/util`.
 *
 * Логика чистая и потому проверяется тестами: промах тут означает либо пустой
 * экран при непустом совпадении, либо папку без содержимого.
 */

/** Строка дерева в том виде, в каком её видит фильтр. */
export interface FilterRow {
  /** Отображаемое имя: по нему решается совпадение. */
  readonly name: string;
  /** Путь строки — по нему строятся отношения «родитель — потомок». */
  readonly path: string;
  /** Родительская папка; пусто у корней. */
  readonly parent: string;
}

/** Совпадает ли имя с запросом. Пустой запрос совпадает со всем. */
export function matchesName(name: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return name.toLowerCase().includes(needle);
}

/**
 * Какие строки оставить. Возвращает множество путей, которые нужно показать:
 * совпавшие строки плюс все их предки (иначе до совпадения не добраться).
 *
 * Порядок и вложенность не важны — важен состав. Строки, чей предок отсутствует
 * в наборе, остаются как есть: дерево может быть показано частично (папка ещё
 * не прочитана), и это не повод прятать найденное.
 */
export function filterTreePaths(rows: readonly FilterRow[], query: string): Set<string> {
  const needle = query.trim().toLowerCase();
  if (needle === '') return new Set(rows.map((row) => row.path));

  const byPath = new Map<string, FilterRow>();
  for (const row of rows) byPath.set(row.path, row);

  const keep = new Set<string>();
  for (const row of rows) {
    if (!row.name.toLowerCase().includes(needle)) continue;
    keep.add(row.path);
    // Поднимаемся к корню, пока предок есть в наборе строк.
    let current = row;
    const guard = new Set<string>([current.path]);
    while (current.parent && !guard.has(current.parent)) {
      const ancestor = byPath.get(current.parent);
      if (!ancestor) break;
      keep.add(ancestor.path);
      guard.add(ancestor.path);
      current = ancestor;
    }
  }
  return keep;
}

/**
 * Сколько совпадений (а не просто предков) в наборе. Нужно для подписи
 * «ничего не найдено»: пустой результат может значить и «нет совпадений», и
 * «запрос пуст» — это разные сообщения.
 */
export function countMatches(rows: readonly FilterRow[], query: string): number {
  const needle = query.trim().toLowerCase();
  if (needle === '') return 0;
  let count = 0;
  for (const row of rows) if (row.name.toLowerCase().includes(needle)) count += 1;
  return count;
}
