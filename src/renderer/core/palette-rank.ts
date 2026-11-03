import type { CommandDescriptor } from './commands';

/**
 * Отбор команд палитры (Ctrl+Shift+P).
 *
 * Было: `haystack.includes(query)` — одна строка поиска целиком. Два дефекта разом:
 *
 *   • «сверн всё» не находило «Свернуть всё» — словарь палитры не та же форма слова,
 *     что в голове человека, и это единственный случай, когда палитра нужна сильнее
 *     всего: когда нужную команду не помнят точно;
 *   • совпадения не ранжировались. «Свернуть всё» и «Вид: свернуть панель» шли в
 *     порядке регистрации, то есть случайно.
 *
 * Порядок совпадений — от «лучше не бывает» к «нашлось как-нибудь»:
 *   0 — название целиком;
 *   1 — начало названия («сверн» → «Свернуть всё»);
 *   2 — слово в названии: «все свернуть» находит «Свернуть всё»;
 *   3 — прочие поля (категория, id, ключевые слова).
 *
 * Пустой запрос не ищет вовсе: там решает история запусков (см. `orderByRecent`).
 */

/** Совпало ли название целиком (без регистра и лишних пробелов). */
const WHOLE = 0;
/** Название начинается с запроса. */
const PREFIX = 1;
/** Каждое слово запроса есть в названии. */
const WORDS = 2;
/** Нашлось вне названия — категория, id, ключевые слова. */
const OTHER = 3;
/** Ничего не нашлось. */
const MISS = -1;

/** Текст, по которому ищем, в одной форме: без регистра, ё-е и лишних пробелов. */
function fold(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function rankOf(descriptor: CommandDescriptor, query: string): number {
  const title = fold(descriptor.title);
  if (title === query) return WHOLE;
  if (title.startsWith(query)) return PREFIX;
  const words = query.split(' ');
  // ВСЕ слова — в начале названия: «свернуть всё» для заголовков «Свернуть всё»
  // и «Свернуть всё до уровня» — одинаково хороший ответ, и решать между ними
  // должна история, а не длина названия (её никто не выбирал).
  //
  // Отдельно от `WORDS`: «переставить всё» не должно обгонять команду, где
  // слова рассыпаны по названию, только потому, что начало совпало.
  if (words.every((word) => title.startsWith(word))) return PREFIX;
  if (words.every((word) => title.includes(word))) return WORDS;

  const rest = fold(`${descriptor.category} ${descriptor.id} ${(descriptor.keywords ?? []).join(' ')}`);
  if (words.every((word) => rest.includes(word))) return OTHER;
  return MISS;
}

/**
 * Отобрать и упорядочить команды под запрос.
 *
 * При РАВНОМ ранге раньше идёт то, что чаще запускают: `recent` — история по
 * свежести, и её индекс служит ценой. Две команды с одинаковым совпадением —
 * редкость, но именно на них «второй раз ищу глазами» и происходит.
 */
export function rankCommands(
  commands: readonly CommandDescriptor[],
  query: string,
  recent: readonly string[] = [],
  limit = Number.POSITIVE_INFINITY,
): CommandDescriptor[] | null {
  // `null`, а не `[]`: без запроса искать нечего, и решать должен вызывающий
  // (палитра покажет историю). Пустой список здесь читался бы как «ничего не
  // нашлось», а это неправда.
  const asked = fold(query);
  if (!asked) return null;

  // Цена свежести: МЕНЬШЕ — свежее. Так соглашение `RecentCommands.ids()` —
  // «первый запускали последним» — само становится порядком сортировки.
  const freshness = new Map<string, number>();
  recent.forEach((id, index) => {
    freshness.set(id, index);
  });

  const scored: { descriptor: CommandDescriptor; rank: number; fresh: number; order: number }[] = [];
  commands.forEach((descriptor, order) => {
    const rank = rankOf(descriptor, asked);
    if (rank === MISS) return;
    // Нет в истории — значит, ни разу не запускали: хуже любой из истории.
    scored.push({ descriptor, rank, fresh: freshness.get(descriptor.id) ?? Number.MAX_SAFE_INTEGER, order });
  });

  scored.sort((a, b) => a.rank - b.rank || a.fresh - b.fresh || a.order - b.order);
  return scored.slice(0, limit).map((entry) => entry.descriptor);
}
