/**
 * Границы того, что человек считает одним символом.
 *
 * Длина строки в JS — в единицах UTF-16, и это не то же самое, что «символы на
 * экране». Одна видимая вещь может занимать несколько единиц:
 *
 *   • эмодзи вне основной плоскости («😀») — суррогатная пара, две единицы;
 *   • эмодзи с модификатором или составной («👍🏽», «👨‍👩‍👧») — до десятка единиц
 *     с соединителями нулевой ширины;
 *   • буква с диакритикой в разложенном виде («е́») — буква плюс комбинирующий знак;
 *   • флаг страны — две региональные буквы.
 *
 * Стрелка вправо, Backspace или выделение должны двигаться на такую группу целиком.
 * Иначе курсор встаёт «внутрь» одного видимого символа, и половина эмодзи едет
 * отдельно от второй половины. Разбиение на такие группы делает платформа — стандарт
 * Unicode Text Segmentation: в JS его реализует `Intl.Segmenter` (есть и в Chromium,
 * и в Node 20+, то есть и в рабочем окне, и в тестах).
 *
 * Здесь только границы. Правки по этим границам — в командном слое, чтобы модель
 * текста (`text-buffer.ts`) не знала ни о языке, ни о локали.
 */

/** Что вернул `Intl.Segmenter`: от начала до конца группы и признак «это слово». */
export interface Segment {
  readonly start: number;
  readonly end: number;
  readonly isWordLike: boolean;
}

const graphemeSegmenters = new Map<string, Intl.Segmenter>();
const wordSegmenters = new Map<string, Intl.Segmenter>();

/** Есть ли разбиение от платформы. Без него остаются границы кодовых точек — грубее, но не хуже строки JS. */
export function hasSegmentation(): boolean {
  return typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
}

function segmenter(granularity: 'grapheme' | 'word', locale?: string): Intl.Segmenter | null {
  if (!hasSegmentation()) return null;
  const key = `${granularity}|${locale ?? ''}`;
  const cache = granularity === 'grapheme' ? graphemeSegmenters : wordSegmenters;
  const cached = cache.get(key);
  if (cached) return cached;
  const created = new Intl.Segmenter(locale, { granularity });
  cache.set(key, created);
  return created;
}

/**
 * Границы кодовых точек — запасной путь, когда разбиения от платформы нет.
 * Суррогатные пары он склеивает (эмодзи не развалится), а вот составные кластеры
 * вроде «👨‍👩‍👧» останутся несколькими группами. Это заведомо хуже `Intl.Segmenter`,
 * поэтому запасной путь и помечен отдельно.
 */
function codepointBoundaries(text: string): number[] {
  const bounds: number[] = [0];
  for (let index = 0; index < text.length; ) {
    const code = text.charCodeAt(index);
    index += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    bounds.push(Math.min(index, text.length));
  }
  return bounds;
}

/** Все границы групп, включая 0 и конец текста. */
export function graphemeBoundaries(text: string, locale?: string): number[] {
  const engine = segmenter('grapheme', locale);
  if (!engine) return codepointBoundaries(text);
  const bounds: number[] = [0];
  for (const { index } of engine.segment(text)) {
    if (index > 0) bounds.push(index);
  }
  if (bounds[bounds.length - 1] !== text.length) bounds.push(text.length);
  return bounds;
}

/** Группа, в которую попадает смещение (или вплотную к которой оно стоит). */
export function graphemeAt(text: string, offset: number, locale?: string): { start: number; end: number } {
  const at = Math.max(0, Math.min(offset, text.length));
  if (text.length === 0) return { start: 0, end: 0 };
  const engine = segmenter('grapheme', locale);
  if (engine) {
    const found = engine.segment(text).containing(Math.min(at, text.length - 1));
    if (found) return { start: found.index, end: found.index + found.segment.length };
  }
  const bounds = codepointBoundaries(text);
  return boundsAt(bounds, at);
}

/** Ближайшая граница группы слева (для Backspace и стрелки влево). */
export function previousGraphemeBoundary(text: string, offset: number, locale?: string): number {
  const at = Math.max(0, Math.min(offset, text.length));
  if (at <= 0) return 0;
  return graphemeAt(text, at - 1, locale).start;
}

/** Ближайшая граница группы справа (для Delete и стрелки вправо). */
export function nextGraphemeBoundary(text: string, offset: number, locale?: string): number {
  const at = Math.max(0, Math.min(offset, text.length));
  if (at >= text.length) return text.length;
  return graphemeAt(text, at, locale).end;
}

/** Слова и промежутки между ними (пробелы, знаки) — для выделения и ходьбы по словам. */
export function wordSegments(text: string, locale?: string): Segment[] {
  const engine = segmenter('word', locale);
  if (!engine) return fallbackWords(text);
  const out: Segment[] = [];
  for (const part of engine.segment(text)) {
    out.push({ start: part.index, end: part.index + part.segment.length, isWordLike: part.isWordLike === true });
  }
  return out;
}

/** Слово под смещением: для двойного клика. `null` — под смещением слово не стоит. */
export function wordAt(text: string, offset: number, locale?: string): Segment | null {
  if (text.length === 0) return null;
  const at = Math.max(0, Math.min(offset, text.length - 1));
  for (const part of wordSegments(text, locale)) {
    if (at >= part.start && at < part.end) return part.isWordLike ? part : null;
  }
  return null;
}

/** Границы участка внутри готового списка границ — по смещению. */
function boundsAt(bounds: readonly number[], offset: number): { start: number; end: number } {
  let low = 0;
  let high = bounds.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (bounds[middle]! <= offset) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const start = bounds[found]!;
  const end = found + 1 < bounds.length ? bounds[found + 1]! : start;
  return { start, end };
}

/**
 * Запасное разбиение на слова без платформы: буквы и цифры — слово, остальное —
 * промежутки. Регулярка работает по кодовым точкам, такие же, как в тестах.
 */
function fallbackWords(text: string): Segment[] {
  const out: Segment[] = [];
  let index = 0;
  while (index < text.length) {
    const code = text.codePointAt(index) ?? 0;
    const isWord = isWordCode(code);
    const start = index;
    index += code > 0xffff ? 2 : 1;
    while (index < text.length) {
      const next = text.codePointAt(index) ?? 0;
      if (isWordCode(next) !== isWord) break;
      index += next > 0xffff ? 2 : 1;
    }
    out.push({ start, end: index, isWordLike: isWord });
  }
  return out;
}

/** Буква, цифра или подчёркивание — то, что стоит считать одним словом в запасном разбиении. */
function isWordCode(code: number): boolean {
  if (code === 0x5f) return true;
  if (code >= 0x30 && code <= 0x39) return true;
  if (code >= 0x41 && code <= 0x5a) return true;
  if (code >= 0x61 && code <= 0x7a) return true;
  // Всё, что вне ASCII и не пробел/пунктуация, считаем буквой: кириллица, греческий,
  // иероглифы. Точнее скажет только платформенное разбиение.
  return code > 0x7f && code !== 0x200b && !(code >= 0x2000 && code <= 0x206f);
}
