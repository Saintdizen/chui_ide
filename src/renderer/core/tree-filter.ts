/**
 * Фильтр дерева проводника: какие строки оставить, когда в поле ввода набран
 * запрос, и что в имени подсветить.
 *
 * Дерево — не плоский список: у строки есть родитель, и спрятать папку, внутри
 * которой нашлось совпадение, значит спрятать само совпадение. Поэтому фильтр
 * работает как «оставить путь»: строка проходит, если совпала сама или совпал
 * кто-то из её потомков. Иначе говоря, при запросе `util` в списке должны
 * остаться `src`, `src/util` и файлы внутри `src/util`, а `docs` — исчезнуть.
 *
 * Слова через пробел складываются: `comp ts` — и то и другое в имени, в каком
 * угодно порядке (`Button.ts`, `ts/compile`). Так ищут, когда помнят куски
 * имени, а не его целиком.
 *
 * Слово без `*` и `?` — подстрока: искать `utl` и находить `util` — неправда.
 * С шаблонами (`*.test.ts`, `util?`) — сравнение по всей строке: именно так
 * читается `*`, иначе он значил бы обычную подстроку.
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

/** Совпадение в имени: от и до (по символам, конец не включается). */
export type MatchRange = readonly [start: number, end: number];

export interface NameMatch {
  /** Имя подходит под весь запрос (все слова). */
  readonly matched: boolean;
  /** Что подсветить. Слитое и по возрастанию, без наложений. */
  readonly ranges: readonly MatchRange[];
}

/** Одно слово запроса: с шаблонами и без. */
export interface QueryToken {
  /** Слово как набрано, в нижнем регистре. */
  readonly text: string;
  /** Есть ли `*` или `?` — от этого зависит способ сравнения. */
  readonly glob: boolean;
}

/**
 * Разобрать запрос на слова. Пустые (от лишних пробелов) пропадают, `*` и `?`
 * включают шаблонное сравнение для своего слова.
 */
export function parseFilterQuery(query: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  for (const piece of query.trim().toLowerCase().split(/\s+/)) {
    if (piece === '') continue;
    tokens.push({ text: piece, glob: piece.includes('*') || piece.includes('?') });
  }
  return tokens;
}

/**
 * Совпадает ли имя с запросом. Пустой запрос совпадает со всем.
 *
 * Оставлено ради старых вызовов: новым нужен `matchName` — ему нужны ещё и
 * диапазоны для подсветки.
 */
export function matchesName(name: string, query: string): boolean {
  return matchName(name, query).matched;
}

/**
 * Позиции символов имени, которые накрыл шаблон, или `null` — не совпало.
 *
 * Шаблон короткий (имя файла), поэтому честный перебор с памяткой дешевле любой
 * хитрой схемы, а главное — он даёт точные позиции для подсветки. `*` ничего не
 * подсвечивает: у него нет своих символов.
 */
function globPositions(text: string, pattern: string): number[] | null {
  const memo = new Map<string, number[] | null>();
  const solve = (textAt: number, patternAt: number): number[] | null => {
    const key = `${textAt}:${patternAt}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: number[] | null;
    if (patternAt === pattern.length) {
      result = textAt === text.length ? [] : null;
    } else {
      const head = text[textAt];
      if (pattern[patternAt] === '*') {
        result = null;
        // `*` съедает сколько угодно символов — от нуля до конца строки.
        for (let take = 0; textAt + take <= text.length; take += 1) {
          const rest = solve(textAt + take, patternAt + 1);
          if (rest) {
            result = rest;
            break;
          }
        }
      } else {
        const ok = pattern[patternAt] === '?' ? head !== undefined : head === pattern[patternAt];
        const rest = ok ? solve(textAt + 1, patternAt + 1) : null;
        result = rest === null || head === undefined ? null : [textAt, ...rest];
      }
    }
    memo.set(key, result);
    return result;
  };
  return solve(0, 0);
}

/** Дополнить набор отрезков новыми позициями, сливая касающиеся. */
function addPositions(ranges: MatchRange[], positions: readonly number[]): void {
  const sorted = [...positions].sort((left, right) => left - right);
  for (const at of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && at <= last[1]) {
      ranges[ranges.length - 1] = [last[0], Math.max(last[1], at + 1)];
      continue;
    }
    ranges.push([at, at + 1]);
  }
}

/** Слить пересекающиеся отрезки: подсветка не должна обрываться на стыке слов. */
function mergeRanges(ranges: readonly MatchRange[]): MatchRange[] {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged: MatchRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) {
      merged[merged.length - 1] = [last[0], Math.max(last[1], range[1])];
      continue;
    }
    merged.push([range[0], range[1]]);
  }
  return merged;
}

/**
 * Совпадение имени со всем запросом и что подсветить.
 *
 * Подсветка — объединение совпадений всех слов: имя, подходящее по двум словам
 * сразу, не должно подсвечиваться двумя отрезками поверх друг друга.
 */
export function matchName(name: string, query: string): NameMatch {
  const tokens = parseFilterQuery(query);
  if (tokens.length === 0) return { matched: true, ranges: [] };

  const lower = name.toLowerCase();
  const ranges: MatchRange[] = [];
  for (const token of tokens) {
    if (token.glob) {
      const positions = globPositions(lower, token.text);
      if (!positions) return { matched: false, ranges: [] };
      addPositions(ranges, positions);
      continue;
    }
    // Слово без шаблонов — подстрока. Показываем все вхождения, а не первое:
    // `tt` в `button-title` — это две подсветки, и обе правдивые.
    let from = lower.indexOf(token.text);
    if (from < 0) return { matched: false, ranges: [] };
    while (from >= 0) {
      addPositions(
        ranges,
        Array.from({ length: token.text.length }, (_, i) => from + i),
      );
      from = lower.indexOf(token.text, from + token.text.length);
    }
  }
  return { matched: true, ranges: mergeRanges(ranges) };
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
  if (query.trim() === '') return new Set(rows.map((row) => row.path));

  const byPath = new Map<string, FilterRow>();
  for (const row of rows) byPath.set(row.path, row);

  const keep = new Set<string>();
  for (const row of rows) {
    if (!matchName(row.name, query).matched) continue;
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
  if (query.trim() === '') return 0;
  let count = 0;
  for (const row of rows) if (matchName(row.name, query).matched) count += 1;
  return count;
}
