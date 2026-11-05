import { loosePositions } from '../../shared/fuzzy';
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
/**
 * Буквы нашлись по порядку, но не подряд: `свн` → «Свернуть всё».
 *
 * Ранг ниже `WORDS` и выше `OTHER`: это настоящее совпадение по названию, но
 * менее точное, чем слово целиком — иначе редкие «угаданные» команды лезли
 * бы вперёд тех, где запрос есть буквально.
 */
const FUZZY = 3;
/** Нашлось вне названия — категория, id, ключевые слова. */
const OTHER = 4;
/** Ничего не нашлось. */
const MISS = -1;

/** Текст, по которому ищем, в одной форме: без регистра, ё-е и лишних пробелов. */
function fold(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/**
 * Свёрнутый текст вместе с картой обратно в исходные индексы.
 *
 * Карта нужна подсветке: ищем по свёрнутому («Свернуть» → «свернуть»), а
 * рисовать надо в исходном, иначе первая же заглавная или `ё` сдвинет все
 * отметки на символ. Пробелы схлопываются в один, с индексом первого.
 */
function foldWithMap(text: string): { folded: string; origin: number[] } {
  const origin: number[] = [];
  let folded = '';
  let pendingSpace = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (/\s/.test(char)) {
      if (pendingSpace < 0) pendingSpace = index;
      continue;
    }
    if (pendingSpace >= 0 && folded !== '') {
      folded += ' ';
      origin.push(pendingSpace);
    }
    pendingSpace = -1;
    folded += char.toLowerCase().replace(/ё/g, 'е');
    origin.push(index);
  }
  return { folded, origin };
}

/**
 * Позиции букв запроса в названии, если они нашлись ПО ПОРЯДКУ (не подряд).
 *
 * Последний шанс палитры: человек помнит обрывки («свн»), а не слово.
 * Берём ВОЛЬНЫЙ поиск (`shared/fuzzy` loosePositions), а не строгий `matchScore`:
 * названия сюда приходят уже свёрнутыми в нижний регистр, горбов в них нет по
 * построению, и строгое правило отвергло бы `свн` в «свернуть все» — ровно тот
 * случай, ради которого фаззи и нужна.
 */
function subsequencePositions(folded: string, query: string): readonly number[] | null {
  return loosePositions(folded, query.replace(/\s+/g, ''));
}

function rankOf(descriptor: CommandDescriptor, query: string, foldedTitle: string): number {
  const title = foldedTitle;
  if (title === query) return WHOLE;
  if (title.startsWith(query)) return PREFIX;
  const words = query.split(' ');
  // ВСЕ слова — в начале названия: «свернуть всё» для заголовков «Свернуть всё»
  // и «Свернуть всё до уровня» — одинаково хороший ответ, и решать между ними
  // должна история, а не длина названия (её никто не выбирал).
  //
  // Отдельно от `WORDS`: «переставить всё» не должно обгонять команду, где
  // слова рассыпаны, только потому, что начало совпало.
  if (words.every((word) => title.startsWith(word))) return PREFIX;
  if (words.every((word) => title.includes(word))) return WORDS;
  // Обрывки букв: `свн` → «Свернуть всё».
  if (subsequencePositions(title, query)) return FUZZY;

  const rest = fold(`${descriptor.category} ${descriptor.id} ${(descriptor.keywords ?? []).join(' ')}`);
  if (words.every((word) => rest.includes(word))) return OTHER;
  return MISS;
}

/** Строка палитры: команда и что в названии подсветить. */
export interface RankedCommand {
  readonly descriptor: CommandDescriptor;
  /**
   * Индексы символов НАЗВАНИЯ, которые нужно подсветить.
   *
   * Пусто, когда совпало не название (категория, id, ключевые слова):
   * подсвечивать в названии нечего, и выдумывать нечего тоже.
   */
  readonly positions: readonly number[];
}

/**
 * Где подсветить в названии. `OTHER` — ничего: совпало не название, и тогда
 * подсветка врала бы, будто совпала именно она.
 */
function positionsOf(descriptor: CommandDescriptor, query: string, rank: number): number[] {
  if (rank === OTHER || rank === MISS) return [];
  const { folded, origin } = foldWithMap(descriptor.title);
  // ≥ WORDS: слова запроса подсвечиваем по большим позициям, каждая целиком.
  const inFolded = rank === WHOLE || rank === PREFIX ? [...Array(Math.min(query.length, folded.length)).keys()] : [];
  if (rank === WORDS) {
    for (const word of query.split(' ')) {
      const at = folded.indexOf(word);
      if (at < 0) continue;
      for (let index = at; index < at + word.length; index += 1) inFolded.push(index);
    }
  }
  if (rank === FUZZY) inFolded.push(...(subsequencePositions(folded, query) ?? []));
  // NOTE: свёрнутые индексы переводятся в исходные здесь же — подсветка рисует
  // по исходному названию, где `ё` и заглавные сдвигают все отметки.
  return [...new Set(inFolded)].sort((left, right) => left - right).map((index) => origin[index] ?? index);
}

/**
 * Отобрать и упорядочить команды под запрос — вместе с тем, что подсветить.
 *
 * При РАВНОМ ранге раньше идёт то, что чаще запускают: `recent` — история по
 * свежести, и её индекс служит ценой. Две команды с одинаковым совпадением —
 * редкость, но именно на них «второй раз ищу глазами» и происходит.
 */
export function rankCommandMatches(
  commands: readonly CommandDescriptor[],
  query: string,
  recent: readonly string[] = [],
  limit = Number.POSITIVE_INFINITY,
): RankedCommand[] | null {
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

  const scored: { entry: RankedCommand; rank: number; fresh: number; order: number }[] = [];
  commands.forEach((descriptor, order) => {
    const foldedTitle = fold(descriptor.title);
    const rank = rankOf(descriptor, asked, foldedTitle);
    if (rank === MISS) return;
    const entry: RankedCommand = { descriptor, positions: positionsOf(descriptor, asked, rank) };
    // Нет в истории — значит, ни разу не запускали: хуже любой из истории.
    scored.push({ entry, rank, fresh: freshness.get(descriptor.id) ?? Number.MAX_SAFE_INTEGER, order });
  });

  scored.sort((a, b) => a.rank - b.rank || a.fresh - b.fresh || a.order - b.order);
  return scored.slice(0, limit).map((item) => item.entry);
}

/**
 * То же без подсветки — для тех, кому нужны только сами команды.
 *
 * Два входа вместо одного: у вызывающего с подсветкой своих забот хватает,
 * а расхождение между двумя списками было бы багом на пустом месте.
 */
export function rankCommands(
  commands: readonly CommandDescriptor[],
  query: string,
  recent: readonly string[] = [],
  limit = Number.POSITIVE_INFINITY,
): CommandDescriptor[] | null {
  const ranked = rankCommandMatches(commands, query, recent, limit);
  return ranked ? ranked.map((item) => item.descriptor) : null;
}

/** Заголовок группы недавних: команды отсюда уже запускали. */
export const RECENT_GROUP = 'Недавние';

/**
 * Разложить команды по категориям для пустого ввода.
 *
 * «Заголовок при смене категории» на этих данных врёт: команды регистрируются
 * файлами (`file-commands`, `view-commands`, ...), поэтому «Файл» встречается
 * семь раз вперемешку с другими. Группа должна быть настоящей: сначала
 * недавние (в порядке свежести), затем категории в порядке первого появления,
 * внутри категории — порядок реестра.
 *
 * Категория без названия собирается под «Прочее»: пустой заголовок выглядел бы
 * как сбой отрисовки.
 */
export function groupCommands(
  descriptors: readonly CommandDescriptor[],
  recent: readonly string[] = [],
): { header: string; items: CommandDescriptor[] }[] {
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const groups: { header: string; items: CommandDescriptor[] }[] = [];

  const fresh = recent.map((id) => byId.get(id)).filter((descriptor) => descriptor !== undefined);
  if (fresh.length > 0) groups.push({ header: RECENT_GROUP, items: fresh });

  const taken = new Set(fresh.map((descriptor) => descriptor.id));
  for (const descriptor of descriptors) {
    if (taken.has(descriptor.id)) continue;
    const header = descriptor.category.trim() === '' ? 'Прочее' : descriptor.category;
    const group = groups.find((item) => item.header === header);
    if (group) {
      group.items.push(descriptor);
      continue;
    }
    groups.push({ header, items: [descriptor] });
  }
  return groups;
}
