/**
 * Выделение в терминале: границы в клетках и текст выделенного.
 *
 * Выделяют мышью или клавиатурой от одной точки к другой, и порядок этих точек заранее
 * не известен — тянуть можно в любую сторону. Поэтому выделение хранится как две точки,
 * а нужный порядок наводит `normalizeSelection`. Текст собирается по СТОЛБЦАМ, а не по
 * знакам строки: широкий знак занимает две клетки, и выделение половины не должно
 * разъезжаться с тем, что видно в сетке.
 *
 * Правило чистое (точки + содержимое строк), поэтому проверяется без DOM и без модели
 * экрана: вид лишь подставляет сюда столбцы видимых строк.
 */

/** Точка в сетке: столбец и строка (обе с нуля, строка — в координатах всей ленты). */
export interface SelectionPoint {
  readonly col: number;
  readonly row: number;
}

/** Упорядоченный отрезок выделения: `start` не позже `end`. */
export interface SelectionRange {
  readonly start: SelectionPoint;
  readonly end: SelectionPoint;
}

/** Привести две точки к отрезку «от начала к концу»: тянуть можно в любую сторону. */
export function normalizeSelection(a: SelectionPoint, b: SelectionPoint): SelectionRange {
  if (a.row < b.row) return { start: a, end: b };
  if (a.row > b.row) return { start: b, end: a };
  return a.col <= b.col ? { start: a, end: b } : { start: b, end: a };
}

/** Выделение пустое, если это одна и та же клетка: тогда и текста нет. */
export function isEmptySelection(range: SelectionRange): boolean {
  return range.start.row === range.end.row && range.start.col === range.end.col;
}

/**
 * Попадает ли клетка в выделение. Строка внутри отрезка выделена целиком, крайние —
 * только от своей колонки: так выделение совпадает со строчными кусками текста.
 */
export function selectionContains(range: SelectionRange, col: number, row: number): boolean {
  if (row < range.start.row || row > range.end.row) return false;
  if (range.start.row === range.end.row) return col >= range.start.col && col <= range.end.col;
  if (row === range.start.row) return col >= range.start.col;
  if (row === range.end.row) return col <= range.end.col;
  return true;
}

/**
 * Текст выделения. `columnsAt(row)` отдаёт столбцы строки: по записи на клетку, вторая
 * половина широкого знака — пустая строка (своего знака у неё нет). Строки сшиваются
 * переводом строки, хвостовые пробелы у каждой строки срезаны — тянуть выделение за
 * пустой хвост незачем, а он в консоли есть почти всегда.
 */
export function selectionText(
  range: SelectionRange,
  columnsAt: (row: number) => readonly string[] | undefined,
): string {
  if (isEmptySelection(range)) return '';
  const parts: string[] = [];
  for (let row = range.start.row; row <= range.end.row; row += 1) {
    const columns = columnsAt(row) ?? [];
    const from = row === range.start.row ? range.start.col : 0;
    const to = row === range.end.row ? range.end.col : columns.length - 1;
    parts.push(
      columns
        .slice(from, to + 1)
        .join('')
        .replace(/\s+$/, ''),
    );
  }
  // Хвостовые пустые строки в выделении не нужны: их не видно, а копировать их незачем.
  while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.join('\n');
}
