/**
 * Поиск по ленте беседы: где в тексте лежат совпадения и как их подсветить.
 *
 * Модуль __чистый__: ни DOM, ни RPC. Из-за этого его можно проверить тестом,
 * а правило «регистр не важен, но позиции считаются по исходному тексту» живёт
 * в одном месте — иначе подсветка разъезжалась бы с длиной строки, стоило
 * кому-то дописать `.toLowerCase()` по одну сторону.
 */

/** Совпадение в тексте: `start` — включительно, `end` — исключительно. */
export interface FindMatch {
  start: number;
  end: number;
}

/** Куски строки: обычный текст и совпадения — чтобы разметить их разными узлами. */
export interface FindSegment {
  text: string;
  match: boolean;
}

/**
 * Все совпадения `query` в `text`. Регистр не важен, перекрытия не ищутся
 * (совпадения идут подряд без наложений, как в браузере).
 *
 * Пустой запрос — нет совпадений: иначе подсветился бы весь текст, а «0 из 0»
 * и «всё найдено» выглядят одинаково и оба бесполезны.
 */
export function findMatches(text: string, query: string): FindMatch[] {
  if (query.length === 0 || text.length === 0) return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const found: FindMatch[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    found.push({ start: at, end: at + needle.length });
    // Шаг на длину совпадения, а не на 1: так перекрытий не будет и цикл
    // заканчивается за число совпадений, а не за число символов.
    from = at + needle.length;
  }
  return found;
}

/** Сколько совпадений в тексте — для счётчика «3 из 12». */
export function countMatches(text: string, query: string): number {
  return findMatches(text, query).length;
}

/**
 * Разбивает строку на куски для разметки. Возвращает пустой массив для пустой
 * строки — `segmentsOf('')` иначе дал бы один пустой узел, и подсветка вставляла
 * бы пустой `span` на каждый абзац.
 */
export function segmentsOf(text: string, query: string): FindSegment[] {
  if (text.length === 0) return [];
  const matches = findMatches(text, query);
  if (matches.length === 0) return [{ text, match: false }];

  const segments: FindSegment[] = [];
  let at = 0;
  for (const match of matches) {
    if (match.start > at) segments.push({ text: text.slice(at, match.start), match: false });
    segments.push({ text: text.slice(match.start, match.end), match: true });
    at = match.end;
  }
  if (at < text.length) segments.push({ text: text.slice(at), match: false });
  return segments;
}

/**
 * Куда перейти по Enter и Shift+Enter: `delta` 1 — вперёд, -1 — назад.
 *
 * Переход замыкается по кругу: из последнего совпадения вперёд — в первое.
 * Без замыкания поиск «упирался» бы в дно и вопрос «сколько там всего» оставался
 * бы без ответа — человек не знал бы, кончилось ли, или он ещё не дошёл.
 */
export function stepIndex(current: number, total: number, delta: number): number {
  if (total <= 0) return -1;
  // `current` вне диапазона (-1 = ничего не выбрано) даёт уверенное начало.
  if (current < 0 || current >= total) return delta < 0 ? total - 1 : 0;
  return (current + delta + total) % total;
}

/**
 * Отступ строки вокруг совпадения: видно, на чём именно сошлось, а не просто
 * первый абзац. `radius` — сколько символов слева и справа оставить.
 */
export function matchExcerpt(text: string, query: string, radius = 40): string {
  const [first] = findMatches(text, query);
  if (!first) return text.slice(0, radius * 2).trim();
  const from = Math.max(0, first.start - radius);
  const to = Math.min(text.length, first.end + radius);
  const head = from > 0 ? '\u2026' : '';
  const tail = to < text.length ? '\u2026' : '';
  return `${head}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${tail}`;
}
