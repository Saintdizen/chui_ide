/**
 * Проверка орфографии: разбор слов и словарь.
 *
 * Здесь только чистая часть — нарезать текст на слова и сказать, знает ли их
 * словарь. Ни окна, ни файлов, ни языкового сервера: проверка работает поверх
 * обычного текста, поэтому её видно в тестах без окна, а в приложении она получает
 * строки документа и словарь-множество.
 *
 * Что считаем словом. Последовательность букв (в любой раскладке) с возможными
 * внутренними апострофами: `don't` — одно слово, а не `don` и `t`. Дефис словом не
 * считаем: `well-known` — это два слова, и каждое проверяется отдельно (так вернее —
 * дефисное сложное слово может не быть в словаре, а его части есть).
 *
 * Словарь — множество. Формы слова (множественное число, прошедшее время) в словарях
 * лежат не всегда: словарь hunspell хранит основы и правила словоизменения в отдельном
 * файле. Полный разбор правил было бы заводить отдельно, а выгода мала, поэтому
 * проверка пробует и простые основы: снять `-s`, `-ing`, `-ed`, `-ly` и удвоение
 * согласной перед ними. Это покрывает обычные случаи и не стоит ничего, когда слово
 * нашлось сразу.
 */

/** Слово с границами внутри строки: смещения 0-based, конец исключительно. */
export interface WordSpan {
  readonly word: string;
  readonly start: number;
  readonly end: number;
}

/** Найденная ошибка: место слова в строке. Столбцы 1-based, конец исключительно. */
export interface SpellProblem {
  /** Строка с единицы. */
  readonly line: number;
  /** Столбец начала с единицы. */
  readonly startColumn: number;
  /** Столбец конца с единицы, исключительно. */
  readonly endColumn: number;
  /** Само слово — по нему предлагаем замену и пополняем словарь. */
  readonly word: string;
}

/** Участок строки, внутри которого проверять слова (0-based, конец исключительно). */
export interface CharRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Нарезать текст на слова. Регулярное выражение собираем на каждом вызове: общий на
 * модуль `/g`-объект хранит `lastIndex` и путается между вызовами.
 */
export function wordSpans(text: string): WordSpan[] {
  const spans: WordSpan[] = [];
  const pattern = /\p{L}+(?:['’]\p{L}+)*/gu;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    spans.push({ word: match[0], start, end: start + match[0].length });
  }
  return spans;
}

/** Гласные, по которым отличаем слово от сокращения (`rgb`, `src`, `stmt`). */
const VOWELS = /[aeiouyаеёиоуыэюя]/i;

/**
 * Стоит ли проверять это слово. Отсеиваем то, что почти наверняка код, а не проза:
 *   • однобуквенные (`a`, `x`, `i`) — их слишком много среди имён и индексов;
 *   • со заглавной не в начале (`parseUrl`, `HTML`) — верблюжий регистр и аббревиатуры;
 *   • без единой гласной (`rgb`, `src`) — так пишут сокращения, а не слова.
 * Проверяем остальное — так словарь почти не трогает имена в коде и не шумит.
 */
export function isCheckableWord(word: string): boolean {
  if (word.length < 2) return false;
  if (/\p{Lu}/u.test(word.slice(1))) return false;
  if (!VOWELS.test(word)) return false;
  return true;
}

/** Привести слово словаря к тому виду, в котором его сравниваем. `null` — не слово. */
export function normalizeDictionaryWord(word: string): string | null {
  const value = word.trim().toLowerCase();
  if (!value || !/^\p{L}+(?:['’-]\p{L}+)*$/u.test(value)) return null;
  return value.replace(/[’]/g, "'");
}

/**
 * Возможные основы слова: снятые окончания множественного числа, прошедшего времени
 * и наречия. Возвращаем только строки, отличные от самого слова, — проверяющему
 * остаётся просто заглянуть каждой в словарь.
 */
export function baseForms(word: string): string[] {
  const forms: string[] = [];
  const add = (candidate: string): void => {
    if (candidate.length >= 2 && candidate !== word && !forms.includes(candidate)) forms.push(candidate);
  };

  // Притяжательное и сокращение: `code's`, `don't`.
  if (word.endsWith("'s")) add(word.slice(0, -2));
  if (word.endsWith("s'")) add(word.slice(0, -1));

  // Множественное число и третье лицо.
  if (word.endsWith('ies') && word.length > 4) add(`${word.slice(0, -3)}y`);
  if (word.endsWith('ves') && word.length > 4) {
    add(`${word.slice(0, -3)}f`);
    add(`${word.slice(0, -3)}fe`);
  }
  if (word.endsWith('es')) {
    add(word.slice(0, -2));
    add(word.slice(0, -1));
  } else if (word.endsWith('s')) {
    add(word.slice(0, -1));
  }

  // Прошедшее время: `loved`, `stopped`, `tried`.
  if (word.endsWith('ied') && word.length > 4) add(`${word.slice(0, -3)}y`);
  if (word.endsWith('ed')) {
    add(word.slice(0, -2));
    add(word.slice(0, -1));
    add(undouble(word.slice(0, -2)));
  }

  // Деепричастие: `running`, `making`.
  if (word.endsWith('ing') && word.length > 4) {
    const stem = word.slice(0, -3);
    add(stem);
    add(`${stem}e`);
    add(undouble(stem));
  }

  // Наречие: `quickly`, `truly`.
  if (word.endsWith('ly') && word.length > 4) {
    const stem = word.slice(0, -2);
    add(stem);
    add(`${stem}e`);
  }

  // Сравнительная и превосходная степень: `bigger`, `biggest`.
  if (word.endsWith('est') && word.length > 5) add(undouble(word.slice(0, -3)));
  if (word.endsWith('er') && word.length > 4) add(undouble(word.slice(0, -2)));

  return forms;
}

/** Снять удвоенную согласную на конце основы: `runn` → `run`. */
function undouble(stem: string): string {
  const length = stem.length;
  if (length >= 2 && stem[length - 1] === stem[length - 2]) return stem.slice(0, -1);
  return stem;
}

/**
 * Словарь слов. Хранит основы и умеет проверить слово и его простые формы. `add`
 * нужен словарю человека: он пополняется словами, о которых знает только он.
 */
export class SpellDictionary {
  private readonly words = new Set<string>();

  constructor(words: Iterable<string> = []) {
    for (const word of words) this.add(word);
  }

  /** Сколько слов знает словарь. Пустой словарь — проверять нечего. */
  get size(): number {
    return this.words.size;
  }

  add(word: string): void {
    const normalized = normalizeDictionaryWord(word);
    if (normalized) this.words.add(normalized);
  }

  has(word: string): boolean {
    const normalized = normalizeDictionaryWord(word);
    if (!normalized) return true; // не слово — не ошибка
    if (this.words.has(normalized)) return true;
    for (const base of baseForms(normalized)) {
      if (this.words.has(base)) return true;
    }
    return false;
  }
}

/**
 * Ошибки в строке. `knows` — проверка слова словарём (может быть составной: словарь
 * системы, слова человека, пропущенные на сеанс). `ranges` сужают проверку: слова
 * берём только внутри этих участков (комментарии, строки) — так имена в коде не шумят.
 */
/**
 * Слова человека из настроек: непустые строки без дублей (регистр не важен).
 * Правит их человек в файле настроек, поэтому список проверяем, а не берём как есть.
 */
export function normalizeSpellWords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const words: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const word = item.trim();
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  return words;
}

export function spellProblemsInLine(
  line: number,
  text: string,
  knows: (word: string) => boolean,
  ranges?: readonly CharRange[],
): SpellProblem[] {
  const problems: SpellProblem[] = [];
  for (const span of wordSpans(text)) {
    if (!isCheckableWord(span.word)) continue;
    if (ranges && !ranges.some((range) => span.start >= range.start && span.end <= range.end)) continue;
    if (knows(span.word)) continue;
    problems.push({ line, startColumn: span.start + 1, endColumn: span.end + 1, word: span.word });
  }
  return problems;
}
