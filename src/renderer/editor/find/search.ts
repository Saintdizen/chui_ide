import { errorText } from '../../core/file-errors';

/**
 * Поиск по файлу: где встречается то, что человек ищет.
 *
 * Отдельным чистым модулем, а не внутри виджета: поиск спрашивают три места (панель
 * поиска, переход к следующему совпадению, замена всех), и все три должны понимать
 * запрос ОДИНАКОВО. Разъехавшийся поиск — это когда панель говорит «12 совпадений»,
 * а замена меняет 8.
 *
 * Ищем построчно, хотя можно было бы взять текст целиком. Причины две: не собирать
 * весь файл в строку на каждый нажатый символ (на файле в сто тысяч строк это заметно),
 * и совпадать с поведением редакторов — там поиск тоже не перешагивает границу строки
 * (иначе `foo bar` нашёлся бы через перевод строки, чего никто не ждёт).
 *
 * Разбор запроса живёт здесь же и отдельной функцией (`lineMatches`): по ней работают и
 * подсветка совпадений, и замена. Так «сколько нашлось» и «сколько заменено» — это один
 * и тот же разбор, а не два похожих.
 *
 * Запрос бывает трёх видов: обычная подстрока (с учётом регистра или без), слово целиком
 * и регулярка. Регулярка может быть недописанной (`(` — человек ещё печатает): это не
 * повод падать, поэтому ошибка разбора возвращается данными, а не бросается — панель
 * покажет её под полем ввода и останется рабочей.
 */

/** Что человек настроил в панели поиска. */
export interface FindOptions {
  /** Учитывать регистр букв. */
  readonly caseSensitive?: boolean;
  /** Искать слово целиком: `cat` не должен находиться внутри `category`. */
  readonly wholeWord?: boolean;
  /** Считать запрос регулярным выражением. */
  readonly regex?: boolean;
  /**
   * Искать только в выделенном. Второй частью идёт диапазон (`FindRange`):
   * флаг говорит ПОЧЕМУ, диапазон — ГДЕ. Вместе они и дают «в выделении».
   */
  readonly inSelection?: boolean;
}

/**
 * Участок документа, в котором ищем — смещения в UTF-16, как везде здесь.
 *
 * Нужен для поиска в выделении. Диапазон, а не готовый текст: поиск построчный,
 * и если бы мы складывали выделение в строку, смещения совпадений пришлось бы
 * пересчитывать назад — а с ними работают и подсветка, и замена.
 */
export interface FindRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Границы выделения как диапазон поиска — или `null`, если выделения нет.
 *
 * Пустое выделение (просто курсор) — не область поиска: искать в нуле символов
 * значит не найти ничего и объяснить это «не найдено», а не «вы ничего не
 * выделили». Врать счётчиком хуже, чем не включать режим.
 */
export function rangeOfSelection(selection: { start: number; end: number }): FindRange | null {
  if (selection.end <= selection.start) return null;
  return { start: selection.start, end: selection.end };
}

/** Найденное совпадение: место в документе и номер строки для показа. */
export interface FindMatch {
  /** Смещение начала в документе (UTF-16). */
  readonly start: number;
  /** Смещение конца (не включается). */
  readonly end: number;
  /** Номер строки с единицы — как его видит человек. */
  readonly line: number;
  /**
   * Группы регэкспа (1-я, 2-я, …) и текст совпадения. Пусто у обычного поиска:
   * без `()` группировать нечего. Нужны панели для счёта по группам — по ним
   * видно, какая часть шаблона дала столько совпадений.
   */
  readonly groups?: readonly (string | undefined)[];
  readonly text?: string;
}

export interface FindResult {
  readonly matches: FindMatch[];
  /** Текст ошибки разбора регулярки. `null` — запрос разобран. */
  readonly error: string | null;
  /** Уперлись ли в предел числа совпадений (см. `MAX_MATCHES`). */
  readonly truncated: boolean;
}

/** Совпадение внутри одной строки: смещения от её начала и захваченные группы. */
export interface LineMatch {
  readonly start: number;
  readonly end: number;
  /** Группы регулярки: `groups[0]` — первая. Пусто, если групп нет или режим не регулярка. */
  readonly groups: readonly string[];
}

/**
 * Предел числа совпадений. Файл может быть устроен так, что совпадает каждая буква
 * (запрос `e` или регулярка `.`), и тогда список вырастет до размера файла — впустую:
 * на экране всё равно не видно больше, чем влезает в панель счётчика. На этом пределе
 * поиск останавливается и говорит об этом честно (`truncated`).
 */
export const MAX_MATCHES = 20000;

/** Пустой результат — общий, чтобы не создавать объект на каждый пустой запрос. */
const EMPTY: FindResult = { matches: [], error: null, truncated: false };

/** Слово — это буква, цифра или подчёркивание: по ним и проверяются границы. */
const WORD_CHAR = /[\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Pc}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && ch.length > 0 && WORD_CHAR.test(ch);
}

/**
 * Совпадение стоит на границе слова, если слева и справа от него нет буквы или цифры.
 * Проверяем по тексту СТРОКИ: её край — тоже граница, слово не перетекает на соседнюю
 * строку.
 */
function atWordBoundary(text: string, start: number, end: number): boolean {
  return !isWordChar(text[start - 1]) && !isWordChar(text[end]);
}

/** Разобранный запрос: либо регулярка, либо подстрока. */
export interface CompiledQuery {
  /** Регулярка в режиме регулярки; иначе `null` и работаем по подстроке. */
  readonly pattern: RegExp | null;
  /** Подстрока для поиска — уже с нужным регистром. */
  readonly needle: string;
  /** Учитывать ли регистр: нужно при поиске подстроки. */
  readonly caseSensitive: boolean;
}

/**
 * Разобрать запрос. `null` — запрос пуст или регулярка не разобралась; причину в
 * последнем случае достаёт `findMatches` (см. `regexError`).
 */
export function compileQuery(query: string, options: FindOptions = {}): CompiledQuery | null {
  if (query.length === 0) return null;
  const caseSensitive = options.caseSensitive === true;
  if (options.regex) {
    try {
      return { pattern: new RegExp(query, `${caseSensitive ? '' : 'i'}gu`), needle: query, caseSensitive };
    } catch {
      return null;
    }
  }
  return { pattern: null, needle: caseSensitive ? query : query.toLowerCase(), caseSensitive };
}

/**
 * Все совпадения в одной строке. Смещения — от начала строки.
 *
 * Пустые совпадения регулярки (`a*` находит пустоту) пропускаем: нулевой длины
 * совпадение нельзя ни выделить, ни заменить, а поиск по нему не двигается вперёд —
 * без этой проверки цикл был бы бесконечным.
 */
export function lineMatches(text: string, compiled: CompiledQuery, options: FindOptions = {}): LineMatch[] {
  const out: LineMatch[] = [];
  const wholeWord = options.wholeWord === true;

  if (compiled.pattern) {
    const pattern = compiled.pattern;
    pattern.lastIndex = 0;
    let found = pattern.exec(text);
    while (found) {
      const value = found[0];
      if (value.length > 0 && (!wholeWord || atWordBoundary(text, found.index, found.index + value.length))) {
        out.push({ start: found.index, end: found.index + value.length, groups: found.slice(1) });
      }
      // Двигаем поиск вручную: при пустом совпадении `lastIndex` сам не сдвинется.
      pattern.lastIndex = found.index + (value.length === 0 ? 1 : value.length);
      found = pattern.exec(text);
    }
    return out;
  }

  const haystack = compiled.caseSensitive ? text : text.toLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(compiled.needle, from);
    if (at < 0) break;
    const end = at + compiled.needle.length;
    if (!wholeWord || atWordBoundary(text, at, end)) out.push({ start: at, end, groups: [] });
    // С конца совпадения: перекрывающиеся не нужны ни панели, ни замене.
    from = end > at ? end : at + 1;
  }
  return out;
}

/**
 * Найти совпадения во всех строках документа.
 *
 * `getLine` и `lineCount` вместо готового текста: вызывающий отдаёт строки своего
 * документа, и поиску не нужно знать, откуда они берутся — модель это или обычный
 * массив в тесте.
 */
export function findMatches(
  getLine: (line0: number) => string,
  lineCount: number,
  query: string,
  options: FindOptions = {},
  /** Границы поиска в смещениях документа. Не заданы — ищем по всему файлу. */
  range?: FindRange,
): FindResult {
  if (query.length === 0) return EMPTY;
  const compiled = compileQuery(query, options);
  if (!compiled) {
    return { matches: [], error: regexError(query, options), truncated: false };
  }

  // Границы — в смещениях документа, а ищем построчно. Граница, попавшая в
  // середину строки, отрезает эту строку: иначе `ab` в `xabcy` нашлось бы по
  // `abc`, а заменять его было бы нечем — оно же вне выделения.
  const from = range ? Math.max(0, Math.min(range.start, range.end)) : 0;
  const to = range ? Math.max(range.start, range.end) : Number.POSITIVE_INFINITY;

  const matches: FindMatch[] = [];
  let offset = 0;
  for (let line0 = 0; line0 < lineCount; line0 += 1) {
    const text = getLine(line0);
    const lineEnd = offset + text.length;
    // Строка кончилась раньше начала выделения — пропускаем, не разбирая.
    if (lineEnd < from) {
      offset += text.length + 1;
      continue;
    }
    // Строка началась позже конца выделения — дальше искать некуда:
    // смещения только растут.
    if (offset > to) break;

    for (const found of lineMatches(text, compiled, options)) {
      const start = offset + found.start;
      const end = offset + found.end;
      // Совпадение берём, только если оно ЦЕЛИКОМ внутри границ.
      if (start < from || end > to) continue;
      // Группы нужны счётчику: «13 совпадений, из них 9 с группой 1» — иначе
      // по виду замены нельзя понять, почему она дала столько строк.
      const groups = found.groups ?? [];
      matches.push({
        start,
        end,
        line: line0 + 1,
        ...(groups.length > 0 ? { groups, text: text.slice(found.start, found.end) } : {}),
      });
      if (matches.length >= MAX_MATCHES) return { matches, error: null, truncated: true };
    }
    // `lineText` не отдаёт перевод строки, поэтому прибавляем один знак — им и учтён.
    offset += text.length + 1;
  }

  return { matches, error: null, truncated: false };
}

/** Причина, по которой регулярка не разобралась — её и показываем под полем ввода. */
function regexError(query: string, options: FindOptions): string {
  try {
    new RegExp(query, `${options.caseSensitive ? '' : 'i'}u`);
    return 'Регулярное выражение не разобрано';
  } catch (error) {
    return errorText(error);
  }
}

/**
 * Развернуть шаблон замены. В режиме регулярки работают ссылки на группы: `$1` —
 * первая группа, `$&` — всё совпадение, `$$` — знак доллара. В обычном режиме `$1`
 * остаётся текстом: человек ищет подстроку, а не выражение, и групп у неё нет.
 */
export function expandReplacement(match: LineMatch, matchedText: string, replacement: string, regex: boolean): string {
  if (!regex) return replacement;
  return replacement.replace(/\$(\$|&|\d{1,2})/g, (_whole, group: string) => {
    if (group === '$') return '$';
    if (group === '&') return matchedText;
    const index = Number(group);
    return index >= 1 && index <= match.groups.length ? (match.groups[index - 1] ?? '') : '';
  });
}

/**
 * Совпадение, содержащее смещение, или ближайшее к нему справа: по нему панель
 * показывает «текущее из N», а переход ищет следующее.
 */
export function matchIndexAt(matches: readonly FindMatch[], offset: number): number {
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    if (offset >= match.start && offset <= match.end) return index;
  }
  for (let index = 0; index < matches.length; index += 1) {
    if (matches[index]!.start >= offset) return index;
  }
  return matches.length > 0 ? matches.length - 1 : -1;
}
