/**
 * Какие строки дерева рисовать: окно вокруг видимой области.
 *
 * Дерево с десятками тысяч файлов нельзя рисовать целиком — это тысячи узлов DOM
 * на каждую перерисовку. Поэтому рисуется только окно: строки, попавшие в видимую
 * область плюс небольшой запас сверху и снизу (чтобы прокрутка не мигала пустотой).
 *
 * Все числа — в пикселях; перевод «прокрутка → номер строки» — деление на высоту
 * строки, потому что строки одной высоты (она задана настройкой плотности).
 * Логика чистая, поэтому проверяется тестами: промах на единицу тут означал бы
 * дырку в списке или лишнюю строку на экране.
 */

export interface TreeWindow {
  /** Первая рисуемая строка (включительно). */
  readonly first: number;
  /** Последняя рисуемая строка (исключительно). */
  readonly last: number;
}

/**
 * Окно строк для текущей прокрутки.
 *
 * `scrollTop` — прокрутка контейнера (0 — начало списка). `viewportHeight` —
 * высота видимой части. `rowHeight` — высота строки. `overscan` — сколько строк
 * запаса с каждой стороны.
 */
export function computeWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 8,
): TreeWindow {
  if (rowCount <= 0 || rowHeight <= 0) return { first: 0, last: 0 };

  const start = Math.max(0, scrollTop);
  const first = Math.max(0, Math.floor(start / rowHeight) - overscan);
  const last = Math.min(rowCount, Math.ceil((start + Math.max(viewportHeight, 0)) / rowHeight) + overscan);
  return { first, last: Math.max(first, last) };
}
