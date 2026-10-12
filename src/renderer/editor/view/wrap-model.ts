/**
 * Перенос длинных строк (word wrap).
 *
 * Пока строка не шире экрана, она занимает один ряд, и «строка = ряд» — верно.
 * Длинная строка ломает это равенство так же, как свёртка: одна строка буфера
 * растягивается на несколько визуальных рядов. Перевод «столбец → ряд» тоже
 * нелинейный, поэтому он вынесен сюда — отдельно от DOM и от модели текста.
 *
 * Разбиваем строку на ОТРЕЗКИ — куски, каждый из которых рисуется своим рядом от
 * x = 0. Отрезки покрывают строку подряд и не пересекаются. Перенос мягкий, по
 * последнему пробелу внутри ширины: так слова не рвутся посреди. Если слово само
 * шире экрана (длинная ссылка, base64), режем жёстко по знаку — иначе строка повисла
 * бы одним куском шире полотна.
 *
 * Границы считаем по готовой раскладке строки (`line-layout.ts`): `offsets[column]` —
 * это x столбца, и ширина отрезка — разность двух таких x. Значит, табуляции и
 * широкие знаки учтены: отрезок рвётся ровно там, где строка перестаёт влезать.
 *
 * Модуль чистый — ничего не знает ни о DOM, ни о буфере, поэтому проверяется в тестах.
 */

/** Отрезок строки между двумя столбцами. Столбцы — индексы UTF-16, как везде. */
export interface WrapSegment {
  /** Столбец, с которого начинается отрезок (включительно, с нуля). */
  readonly startColumn: number;
  /** Столбец, на котором он кончается (не включительно). */
  readonly endColumn: number;
}

const TAB = 9;
const SPACE = 32;

/** Начало суррогатной пары — резать строку между половинами нельзя. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Вторая половина суррогатной пары — граница переноса перед ней недопустима. */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Разбить строку на отрезки по ширине `maxWidth` (в пикселях). `offsets` — раскладка
 * строки (длина `text.length + 1`). `maxWidth <= 0` или не-число — переноса нет: один
 * отрезок на всю строку (это и есть выключенный word wrap).
 */
export function wrapSegments(text: string, offsets: readonly number[], maxWidth: number): WrapSegment[] {
  const columns = offsets.length - 1;
  if (!(maxWidth > 0) || columns <= 0) return [{ startColumn: 0, endColumn: columns }];

  const left = (column: number): number => offsets[column] ?? 0;
  const segments: WrapSegment[] = [];
  let start = 0;
  while (start < columns) {
    // Докуда влезает от начала отрезка: берём самый дальний столбец, чей правый край
    // ещё в пределах ширины.
    let end = start;
    while (end < columns && left(end + 1) - left(start) <= maxWidth) end += 1;
    // Даже один знак шире экрана — режем жёстко, иначе встанем на месте.
    if (end === start) end = start + 1;
    // Суррогатную пару не разрываем: граница не должна встать между половинами.
    if (end < columns && isLowSurrogate(text.charCodeAt(end))) {
      if (end - 1 > start) end -= 1;
      else end = start + (isHighSurrogate(text.charCodeAt(start)) ? 2 : 1);
    }
    // Мягкий перенос: если строка не кончилась и внутри есть пробел — переносим по
    // последнему пробелу (он остаётся в конце отрезка, как и положено).
    if (end < columns) {
      let brk = -1;
      for (let index = end; index > start; index -= 1) {
        const code = text.charCodeAt(index - 1);
        if (code === SPACE || code === TAB) {
          brk = index;
          break;
        }
      }
      if (brk > start) end = brk;
    }
    segments.push({ startColumn: start, endColumn: end });
    start = end;
  }
  return segments;
}

/** Сколько визуальных рядов занимает строка при данной ширине. */
export function wrapCount(text: string, offsets: readonly number[], maxWidth: number): number {
  return wrapSegments(text, offsets, maxWidth).length;
}

/**
 * Номер отрезка, которому принадлежит столбец. Столбец на самой границе (равен концу
 * отрезка) относится к следующему отрезку, а на конце строки — к последнему: каретка
 * в конце строки стоит на последнем ряду, а не создаёт новую строку.
 */
export function segmentIndexForColumn(segments: readonly WrapSegment[], column: number): number {
  if (segments.length === 0) return 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (column < segment.endColumn) return index;
  }
  return segments.length - 1;
}

/** Проверка, что отрезки покрывают строку подряд — для тестов и ловли опечаток. */
export function segmentsCover(segments: readonly WrapSegment[], columns: number): boolean {
  let at = 0;
  for (const segment of segments) {
    if (segment.startColumn !== at || segment.endColumn <= segment.startColumn) return false;
    at = segment.endColumn;
  }
  return at === columns;
}

/** Начинается ли отрезок с половины суррогатной пары (резать её нельзя) — для тестов. */
export function splitsSurrogate(text: string, segments: readonly WrapSegment[]): boolean {
  for (const segment of segments) {
    if (segment.startColumn > 0 && isLowSurrogate(text.charCodeAt(segment.startColumn))) return true;
    if (segment.startColumn > 0 && isHighSurrogate(text.charCodeAt(segment.startColumn - 1))) return true;
  }
  return false;
}
