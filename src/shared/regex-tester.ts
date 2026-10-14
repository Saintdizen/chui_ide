/**
 * Отладчик регулярных выражений: чистая логика без DOM и диска.
 *
 * Отвечает на три вопроса, которые задают такому инструменту:
 *  1) собирается ли шаблон с выбранными флагами и почему нет, если не собрался;
 *  2) что он находит в тексте — совпадения по порядку, с группами и их местами;
 *  3) что даст замена (включая `$1`, `$<имя>`, `$&`).
 *
 * Всё это чистые функции: окно только собирает поля и рисует ответ, а юнит-тесты
 * проверяют разбор без окна. Свой разборчик намеренно НЕ пишем — считаем тем же
 * движком (`RegExp`), что и рантайм: отладчик должен показывать настоящее поведение,
 * а не похожее.
 */

/** Флаг, который принимает `new RegExp`: те же буквы, что в литерале `/…/gi`. */
export type RegexFlagChar = 'g' | 'i' | 'm' | 's' | 'u' | 'y';

/**
 * Порядок букв — как в литерале JS. Индексный флаг `d` не показываем: позиции групп
 * отладчику нужны всегда, и он добавляет его сам (см. `compile`).
 */
export const REGEX_FLAG_ORDER: readonly RegexFlagChar[] = ['g', 'i', 'm', 's', 'u', 'y'];

export interface RegexFlagInfo {
  char: RegexFlagChar;
  /** Имя в интерфейсе — короткое, в строку чипов. */
  label: string;
  /** Что флаг меняет в поиске: подсказка на наведении. */
  hint: string;
}

export const REGEX_FLAG_INFO: Record<RegexFlagChar, RegexFlagInfo> = {
  g: { char: 'g', label: 'все', hint: 'Искать все совпадения, а не только первое' },
  i: { char: 'i', label: 'регистр', hint: 'Не различать регистр букв' },
  m: { char: 'm', label: 'строки', hint: '^ и $ совпадают у границ строк, а не только текста' },
  s: { char: 's', label: 'точка+\\n', hint: 'Точка совпадает и с переводом строки' },
  u: { char: 'u', label: 'Unicode', hint: 'Полный режим Unicode: суррогатная пара — один знак' },
  y: { char: 'y', label: 'подряд', hint: 'Совпадения идут подряд от позиции поиска (липкий режим)' },
};

/** Набор флагов как объект: интерфейсу удобнее галочками, чем строкой. */
export type RegexFlagSet = Record<RegexFlagChar, boolean>;

/** Ни один флаг не включён. */
export function noFlags(): RegexFlagSet {
  return { g: false, i: false, m: false, s: false, u: false, y: false };
}

/** Значение по умолчанию: ищем ВСЕ совпадения — этого от отладчика и ждут. */
export function defaultFlags(): RegexFlagSet {
  return { ...noFlags(), g: true };
}

/** Чужой ли знак (любая буква вне нашего списка) — не флаг. */
export function isFlagChar(value: string): value is RegexFlagChar {
  return (REGEX_FLAG_ORDER as readonly string[]).includes(value);
}

/** Разобрать строку флагов (`"gi"`) в набор; чужие знаки отбрасываются. */
export function flagsFromString(spec: string): RegexFlagSet {
  const set = noFlags();
  for (const char of spec) {
    if (isFlagChar(char)) set[char] = true;
  }
  return set;
}

/** Собрать строку флагов в порядке литерала: повтор невозможен — это набор. */
export function flagsToString(flags: RegexFlagSet): string {
  return REGEX_FLAG_ORDER.filter((char) => flags[char]).join('');
}

/** Переключить один флаг, вернув новый набор (исходный не меняется). */
export function toggleFlag(flags: RegexFlagSet, char: RegexFlagChar): RegexFlagSet {
  return { ...flags, [char]: !flags[char] };
}

/** Одна группа совпадения: номер, имя (если есть), текст и место в тексте. */
export interface RegexGroup {
  /** 0 — всё совпадение целиком; далее — номер группы по порядку скобок. */
  number: number;
  /** Имя именованной группы (`(?<name>…)`), иначе `null`. */
  name: string | null;
  /** Текст группы; `undefined` — группа в этом совпадении не участвовала. */
  text: string | undefined;
  /** Начало в тексте (в знаках, не байтах). */
  start: number;
  /** Конец в тексте, не включая. */
  end: number;
}

export interface RegexMatch {
  /** Номер по порядку с единицы — так совпадения нумерует список. */
  order: number;
  start: number;
  end: number;
  text: string;
  /** Группы: `[0]` — всё совпадение, далее по номерам скобок. */
  groups: RegexGroup[];
}

export interface RegexRunResult {
  ok: boolean;
  matches: RegexMatch[];
  /** Совпадений больше предела — список обрезан. */
  truncated: boolean;
  /** Причина, если шаблон не собрался (`ok === false`). */
  error: string | null;
}

/** Предел совпадений: защита от катастрофического шаблона на большом тексте. */
export const MAX_MATCHES = 2000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Собрать регулярку для отладчика. К выбранным флагам всегда добавляем `d`:
 * по нему берём места групп, а на совпадения он не влияет.
 */
function compile(pattern: string, flags: RegexFlagSet): RegExp {
  return new RegExp(pattern, `${flagsToString(flags)}d`);
}

/**
 * Имена именованных групп по номерам скобок. В JS нет API для этого, поэтому
 * разбираем шаблон сами: считаем ЗАХВАТЫВАЮЩИЕ скобки по порядку, пропуская
 * экранированные знаки и содержимое классов `[...]`. Просмотры назад `(?<=` и
 * `(?<!` захватом не считаются — их узнаём по `=` или `!` после `<`.
 */
export function captureGroupNames(source: string): (string | null)[] {
  const names: (string | null)[] = [];
  let inClass = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
      continue;
    }
    if (char === '[') {
      inClass = true;
      continue;
    }
    if (char !== '(') continue;
    if (source[index + 1] !== '?') {
      names.push(null);
      continue;
    }
    // `(?:`, `(?=`, `(?!`, `(?#` — без захвата; нам интересны только `(?<name>`.
    if (source[index + 2] !== '<') continue;
    const look = source[index + 3];
    if (look === '=' || look === '!') continue;
    const close = source.indexOf('>', index + 3);
    if (close < 0) {
      names.push(null);
      continue;
    }
    names.push(source.slice(index + 3, close));
  }

  return names;
}

function toMatch(found: RegExpExecArray, names: readonly (string | null)[], order: number): RegexMatch {
  const indices = found.indices;
  const groups: RegexGroup[] = [];
  for (let index = 0; index < found.length; index += 1) {
    const span = indices?.[index];
    groups.push({
      number: index,
      name: index === 0 ? null : (names[index - 1] ?? null),
      text: found[index],
      start: span ? span[0] : found.index,
      end: span ? span[1] : found.index,
    });
  }
  return {
    order,
    start: found.index,
    end: found.index + (found[0]?.length ?? 0),
    text: found[0] ?? '',
    groups,
  };
}

/**
 * Найти совпадения. Без флага `g` движок возвращает первое — отладчик показывает то
 * же, что вернёт сам JS: так видно, чем флаг управляет.
 */
export function runRegex(pattern: string, flags: RegexFlagSet, text: string, limit = MAX_MATCHES): RegexRunResult {
  if (pattern === '') return { ok: true, matches: [], truncated: false, error: null };

  let regex: RegExp;
  try {
    regex = compile(pattern, flags);
  } catch (error) {
    return { ok: false, matches: [], truncated: false, error: errorMessage(error) };
  }

  const names = captureGroupNames(pattern);
  const matches: RegexMatch[] = [];

  if (!flags.g) {
    const found = regex.exec(text);
    if (found) matches.push(toMatch(found, names, 1));
    return { ok: true, matches, truncated: false, error: null };
  }

  let truncated = false;
  let found = regex.exec(text);
  while (found !== null) {
    matches.push(toMatch(found, names, matches.length + 1));
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
    // Пустое совпадение не двигает lastIndex — сдвигаем сами, иначе цикл встанет.
    if (found[0] === '') regex.lastIndex += 1;
    found = regex.exec(text);
  }

  return { ok: true, matches, truncated, error: null };
}

export interface RegexReplaceResult {
  ok: boolean;
  /** Текст после замены (при ошибке — исходный). */
  text: string;
  /** Сколько вхождений заменено. */
  count: number;
  error: string | null;
}

/**
 * Проверить замену: тем же шаблоном и с той же заменой, что уйдёт в `String.replace`.
 * Ссылки на группы (`$1`, `$<имя>`, `$&`) работают как обычно.
 */
export function replaceRegex(
  pattern: string,
  flags: RegexFlagSet,
  text: string,
  replacement: string,
  limit = MAX_MATCHES,
): RegexReplaceResult {
  if (pattern === '') return { ok: true, text, count: 0, error: null };

  let regex: RegExp;
  try {
    regex = compile(pattern, flags);
  } catch (error) {
    return { ok: false, text, count: 0, error: errorMessage(error) };
  }

  const count = runRegex(pattern, flags, text, limit).matches.length;
  return { ok: true, text: count === 0 ? text : text.replace(regex, replacement), count, error: null };
}
