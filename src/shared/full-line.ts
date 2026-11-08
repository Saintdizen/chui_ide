/**
 * Подсказка целой строки (как full-line completion в JetBrains).
 *
 * Идея простая: в проекте уже написано, как выглядит такая строка — ищем её
 * по началу и предлагаем продолжение. Модель не нужна, поэтому подсказка
 * появляется мгновенно и не стоит токенов.
 *
 * Что не предлагаем:
 *  - продолжение, которое уже набрано (курсор в середине такой строки);
 *  - пустой хвост и хвост из одного разделителя — это не подсказка;
 *  - строку без начала: по пустому префиксу «похожего» слишком много.
 */
export interface FullLineCandidate {
  /** Продолжение набранного: только хвост, без уже введённой части. */
  readonly insert: string;
  /** Как часто такой хвост встречался — по ней выбирается лучший. */
  readonly count: number;
}

/** Начало строки без ведущих пробелов — по нему и ищем. */
export function lineHead(line: string): string {
  return line.replace(/^\s+/, '');
}

/**
 * Собрать хвосты для `prefix` из корпуса строк `corpus`.
 *
 * `prefix` — уже набранное (с ведущими пробелами: отступ не теряется).
 * Возвращает `null`, если подсказывать нечего.
 */
export function bestFullLine(prefix: string, corpus: Iterable<string>): FullLineCandidate | null {
  const typed = lineHead(prefix);
  // По слишком короткому началу «похожего» столько, что подсказка станет шумом.
  if (typed.length < 2) return null;

  const tails = new Map<string, number>();

  for (const line of corpus) {
    const candidate = lineHead(line);
    if (candidate.length <= typed.length) continue;
    if (!candidate.startsWith(typed)) continue;
    const tail = candidate.slice(typed.length);
    // Отдельная скобка или точка — не продолжение строки.
    if (!/[\p{L}\p{N}_$]/u.test(tail[0] ?? '')) continue;
    tails.set(tail, (tails.get(tail) ?? 0) + 1);
  }

  let best: string | null = null;
  let count = 0;
  for (const [tail, seen] of tails) {
    // При равенстве выигрывает короткий: он точнее угадывает намерение.
    if (seen > count || (seen === count && best !== null && tail.length < best.length)) {
      best = tail;
      count = seen;
    }
  }
  if (best === null) return null;

  // Хвост мог быть набран только отступом — тогда подсказки нет.
  return best.trim() === '' ? null : { insert: best, count };
}
