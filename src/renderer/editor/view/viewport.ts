/**
 * Окно просмотра: что из документа сейчас на экране и где край прокрутки.
 *
 * Файл бывает в сто тысяч строк, а на экран помещается сорок. Рисовать надо ровно
 * то, что видно: если построить всю сотню тысяч строк разом, браузер сначала съест
 * память на сотню тысяч узлов, а потом замрёт на перерасчёте. Поэтому представление
 * (см. `editor-view.ts`) держит в DOM только видимые строки плюс небольшой запас
 * сверху и снизу (перескролл), а полную высоту имитирует пустой распоркой.
 *
 * Здесь — арифметика этого дела, без DOM: сколько всего пикселей занимает документ,
 * докуда можно прокрутить, какие строки попадают в экран. Всё это чистые функции
 * от чисел, поэтому и проверяются без браузера.
 */

/**
 * Сколько всего пикселей в документе по вертикали. Одна строка — `lineHeight`.
 * Горизонталь считаем не по всем строкам (это стоило бы прохода по всему файлу), а
 * по самой длинной известной — её сообщает представление.
 */
export function contentHeight(lineCount: number, lineHeight: number): number {
  return Math.max(1, lineCount) * lineHeight;
}

/** Предел прокрутки вниз. Когда документ короче экрана, прокручивать нечего — ноль. */
export function maxScrollTop(lineCount: number, lineHeight: number, viewportHeight: number): number {
  return Math.max(0, contentHeight(lineCount, lineHeight) - viewportHeight);
}

/** Предел прокрутки вправо — по самой длинной строке. */
export function maxScrollLeft(contentWidth: number, viewportWidth: number): number {
  return Math.max(0, contentWidth - viewportWidth);
}

/** Прижать величину прокрутки к допустимому отрезку `[0, max]`. */
export function clamp(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > max) return max;
  return value;
}

export interface VisibleLines {
  /** Индекс первой строки в DOM (с нуля). */
  readonly first: number;
  /** Индекс последней строки в DOM (с нуля, включительно). */
  readonly last: number;
}

/**
 * Какие строки держать в DOM. Берём видимые и добавляем по `overscan` строк с каждой
 * стороны — запас, чтобы при небольшой прокрутке новые строки уже были готовы и не
 * мигали пустым местом.
 *
 * Индексы — с нуля: представление про счёт с единицы (как у человека) знает только
 * в модели текста, а тут сплошная арифметика.
 */
export function visibleLines(
  scrollTop: number,
  lineHeight: number,
  viewportHeight: number,
  lineCount: number,
  overscan = 2,
): VisibleLines {
  const total = Math.max(1, lineCount);
  const top = clamp(scrollTop, Math.max(0, contentHeight(total, lineHeight) - viewportHeight));
  const firstVisible = Math.floor(top / lineHeight);
  const lastVisible = Math.floor((top + viewportHeight) / lineHeight);
  return {
    first: Math.max(0, firstVisible - overscan),
    last: Math.min(total - 1, lastVisible + overscan),
  };
}

/** Строка под точкой y (в координатах документа). За концами — ближайшая. */
export function lineAtY(y: number, lineHeight: number, lineCount: number): number {
  const total = Math.max(1, lineCount);
  const index = Math.floor(y / lineHeight);
  if (index < 0) return 0;
  if (index > total - 1) return total - 1;
  return index;
}

/** Верх строки в координатах документа (с нуля). */
export function yOfLine(line: number, lineHeight: number): number {
  return line * lineHeight;
}

/**
 * Прокрутка, при которой строка попадает в экран, — с полем в одну строку у края,
 * чтобы каретка не упиралась в рамку. Возвращает новый `scrollTop`; если строка и
 * так видна, возвращает прежний.
 */
export function revealLine(
  line: number,
  scrollTop: number,
  lineHeight: number,
  viewportHeight: number,
  lineCount: number,
  margin = 1,
): number {
  const max = maxScrollTop(lineCount, lineHeight, viewportHeight);
  const top = yOfLine(line, lineHeight);
  const bottom = top + lineHeight;
  const marginPx = margin * lineHeight;
  const viewTop = scrollTop;
  const viewBottom = scrollTop + viewportHeight;
  // Поле у края добавляем только когда строка ВЫШЛА за экран: строка, стоящая ровно
  // у края, видна, и дёргать прокрутку из-за неё не нужно.
  if (top < viewTop) return clamp(top - marginPx, max);
  if (bottom > viewBottom) return clamp(bottom - viewportHeight + marginPx, max);
  return clamp(scrollTop, max);
}
