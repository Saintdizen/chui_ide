/**
 * Где в файле стоит правка — чтобы открыть его ровно там, а не «где-то сверху».
 *
 * Карточка согласования показывает строки текстом; клик по файлу открывает
 * документ, но ставит курсор на то место, где он был в прошлый раз. Человек
 * ищет глазами то, о чём только что прочитал, — и не находит.
 *
 * Задача узкая: для каждой модифицированной группы «старые строки → новые
 * строки» нужен номер первой новой строки. Полноценный диф с перестановками тут
 * не нужен и вреден: он бы переставлял блоки и уводил место правки.
 */

/** Сколько строк совпало в начале: с них и начинается «ничего не изменилось». */
function commonPrefix(removed: readonly string[], added: readonly string[]): number {
  let head = 0;
  while (head < removed.length && head < added.length && removed[head] === added[head]) head++;
  return head;
}

/** Общая часть в начале и в конце — остальное и есть изменение. */
function trimmed(
  removed: readonly string[],
  added: readonly string[],
): {
  removed: readonly string[];
  added: readonly string[];
} {
  const head = commonPrefix(removed, added);
  let tail = 0;
  while (
    tail < removed.length - head &&
    tail < added.length - head &&
    removed[removed.length - 1 - tail] === added[added.length - 1 - tail]
  ) {
    tail++;
  }
  return {
    removed: removed.slice(head, removed.length - tail),
    added: added.slice(head, added.length - tail),
  };
}

/**
 * Строка (с 1), где новая версия расходится со старой. `0` — правка ничего не
 * меняет: такого в карточке не бывает, но пусть лучше не откроется «на нуле».
 *
 * Считается по старой версии, и для «вставить перед строкой N» это N — как раз
 * та строка, на которую смотрит человек.
 */
export function firstChangedLine(removed: readonly string[], added: readonly string[]): number {
  const head = commonPrefix(removed, added);
  if (head === removed.length && head === added.length) return 0;
  return head + 1;
}

/** Строки для показа около правки: сколько появилось и сколько исчезло. */
export function changedSpan(
  removed: readonly string[],
  added: readonly string[],
): { from: number; removedLines: number; addedLines: number } {
  const parts = trimmed(removed, added);
  const from = firstChangedLine(removed, added);
  return { from, removedLines: parts.removed.length, addedLines: parts.added.length };
}
