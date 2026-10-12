/**
 * Раскладка одной строки: где по горизонтали стоит каждый столбец.
 *
 * Задача узкая, но без неё не работает ничего: каретку надо поставить по столбцу,
 * выделение нарисовать между двумя столбцами, а клик мышью перевести в столбец.
 * Всё это — один вопрос: «какому пикселю по x отвечает смещение в строке».
 *
 * Ответ храним массивом: `offsets[i]` — x для смещения `i` в этой строке, а всего
 * значений на одно больше, чем единиц UTF-16, потому что смещений-границ между
 * знаками на один больше, чем знаков. Строим его обходом слева направо, накапливая x:
 *
 *   • обычный знак прибавляет ширину своей клетки;
 *   • табуляция — не фиксированная ширина, а прыжок к СЛЕДУЮЩЕМУ кратному `tabSize`
 *     столбцу: так табуляция выравнивает код в колонки, и это ожидает человек;
 *   • суррогатная пара (эмодзи) — одна клетка на двух единицах UTF-16; обе половины
 *     получают один x. Хоть каретка и не встаёт внутрь пары (это стережёт слой
 *     графем), массив должен остаться монотонным — иначе поиск ближайшего столбца
 *     по x сломается.
 *
 * Держим раскладку строки, а не всего документа: раскладываются только строки у края
 * каретки и видимые — за кадр их единицы. Кэш по версии буфера живёт выше, в представлении.
 */

import type { GlyphMetrics } from './glyph-metrics';

/** Код знака табуляции. */
const TAB = 9;

/**
 * x-координаты для каждого смещения строки. Длина — `text.length + 1`: граница есть
 * и перед первым знаком, и после последнего. Последнее значение — ширина строки.
 */
export function layoutLine(text: string, metrics: GlyphMetrics): number[] {
  const offsets = new Array<number>(text.length + 1);
  const tabStop = metrics.tabSize * metrics.charWidth;
  let x = 0;
  let index = 0;
  while (index < text.length) {
    offsets[index] = x;
    const code = text.codePointAt(index) ?? 0;
    const units = code > 0xffff ? 2 : 1;
    if (code === TAB) {
      // Прыжок к следующему кратному столбцу: ширина шага — tabStop, а не charWidth.
      x = (Math.floor(x / tabStop) + 1) * tabStop;
    } else {
      x += metrics.widthOf(code);
    }
    // Середина суррогатной пары: тот же x, что и начало — массив остаётся монотонным.
    if (units === 2) offsets[index + 1] = x;
    index += units;
  }
  offsets[text.length] = x;
  return offsets;
}

/** Сколько пикселей занимает строка — правый край последнего столбца. */
export function lineWidth(offsets: readonly number[]): number {
  return offsets[offsets.length - 1] ?? 0;
}

/** x для столбца строки (смещение внутрь строки, с нуля). За концом — правый край. */
export function xForColumn(offsets: readonly number[], column: number): number {
  if (column <= 0) return offsets[0] ?? 0;
  if (column >= offsets.length - 1) return offsets[offsets.length - 1] ?? 0;
  return offsets[column];
}

/**
 * Столбец для x — ближайшая граница знака. Клик правее середины знака встаёт за ним,
 * левее — перед ним: так попадание мышью совпадает с ожиданием «щёлкнул у знака —
 * каретка рядом с ним».
 */
export function columnForX(offsets: readonly number[], x: number): number {
  const last = offsets.length - 1;
  if (last <= 0) return 0;
  if (x <= (offsets[0] ?? 0)) return 0;
  if (x >= (offsets[last] ?? 0)) return last;

  let low = 0;
  let high = last;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (offsets[middle] <= x) low = middle + 1;
    else high = middle - 1;
  }
  // `high` — граница слева от x, `low` — справа. Выбираем ту, что ближе.
  const left = high;
  const right = Math.min(low, last);
  const leftDistance = x - offsets[left];
  const rightDistance = offsets[right] - x;
  return rightDistance < leftDistance ? right : left;
}
