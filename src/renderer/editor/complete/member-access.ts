/**
 * Доступ к члену: `order.` → подсказывать надо членов `order`, а не слова файла.
 *
 * Это правило, которое человек замечает сразу: набрав точку, он ждёт имён, которые
 * принадлежат объекту, — полей и методов, — а не всех слов документа вперемешку с
 * ключевыми словами языка. Здесь живёт ровно распознавание «мы после точки и вот
 * чей это объект»; что именно предложить, решают вызывающие:
 *
 *   • языковой сервер — он единственный знает члены по-настоящему (`this.` в
 *     TypeScript, `self.` в Python, статические члены класса и типы переменных);
 *   • разбор файла — запасной путь на случай, когда сервера нет: свои члены `this`
 *     и `self` видны прямо в тексте (`this.#dialog`, `self.count`).
 *
 * Модуль чистый: строка и столбец на входе, ничего не рисует и никуда не ходит.
 * Поэтому он проверяется тестами без окна, как и остальные правила подсказок.
 */

/** Знак имени: буквы, цифры, подчёркивание, `$`. Тот же набор, что у префикса слова. */
const IDENT_CHAR = /[\p{L}\p{Nl}\p{Nd}\p{Pc}_$]/u;

/** Знак, который ещё может быть частью ЧЛЕНА: у закрытых полей имя начинается с `#`. */
const MEMBER_CHAR = /[\p{L}\p{Nl}\p{Nd}\p{Pc}_$#]/u;

/** Имена, которые в языке означают «текущий объект». */
const SELF_NAMES: ReadonlySet<string> = new Set(['this', 'self', 'cls']);

/** Что распозналось: доступ к члену и набранное его начало. */
export interface MemberAccess {
  /** Имя объекта перед точкой: `this`, `order`, `Styles`. */
  readonly receiver: string;
  /** Что уже набрано после точки (`#di` в `this.#di`); пусто — набрали только точку. */
  readonly prefix: string;
  /** Сколько знаков заменит вставка: длина `prefix`. */
  readonly replaces: number;
}

/**
 * Доступ к члену под курсором. `column` — сколько знаков строки перед курсором.
 *
 * `null` в случаях, когда подсказывать «членов» не по чему: курсор не после точки,
 * объект не назван (`foo().` — у выражения имени нет) или точка стоит у числа
 * (`1.` — это дробная часть, а не доступ к члену).
 */
export function memberAccessAt(line: string, column: number): MemberAccess | null {
  const at = Math.max(0, Math.min(column, line.length));

  // Набранное начало члена: `#` входит сюда же — закрытые поля так и начинаются.
  let start = at;
  while (start > 0 && isMemberChar(line[start - 1])) start -= 1;
  const prefix = line.slice(start, at);

  if (start === 0) return null;
  if (line[start - 1] !== '.') return null;
  // Перед самой точкой должна стоять не точка: `...` — это развёртка, а не доступ.
  const nameEnd = start - 1;
  if (nameEnd === 0 || line[nameEnd - 1] === '.') return null;

  let nameStart = nameEnd;
  while (nameStart > 0 && isIdentChar(line[nameStart - 1])) nameStart -= 1;
  const receiver = line.slice(nameStart, nameEnd);
  // Имени нет — выражение вроде `(await load()).`: члены назвать нечем, а цепочка
  // `a.b().` приходит сюда же. Тогда честнее обычные слова, чем пустота.
  if (receiver.length === 0) return null;
  // `1.` и `2.5` — дробная часть числа, а не доступ к члену.
  if (/^\p{Nd}+$/u.test(receiver)) return null;

  return { receiver, prefix, replaces: prefix.length };
}

/** Текущий объект ли это (`this` в JS/Java/C#, `self`/`cls` в Python). */
export function isSelfReceiver(receiver: string): boolean {
  return SELF_NAMES.has(receiver);
}

/** Член объекта: как объявлен и как зовётся. */
export interface MemberEntry {
  readonly name: string;
  readonly kind: 'field' | 'method';
}

/**
 * Члены текущего объекта прямо из текста файла. Запасной путь, а не замена серверу:
 * типов здесь не видно, поэтому работают только `this`/`self` (свой класс) — зато
 * работают и без языкового сервера, и сразу, без ожидания ответа.
 *
 * Собираем с двух сторон и это важно: объявления (`#dialog =`, `def run(self)`) и
 * ИСПОЛЬЗОВАНИЯ (`this.#dialog`, `self.count`). Одного объявления мало — поле часто
 * заводится присваиванием в конструкторе; а одних использований мало — метод, который
 * ещё не вызвали, иначе в подсказку не попадёт.
 */
export function selfMembers(text: string): MemberEntry[] {
  const found = new Map<string, MemberEntry>();
  const remember = (name: string, kind: MemberEntry['kind']): void => {
    if (!name || RESERVED.has(name) || found.has(name)) return;
    found.set(name, { name, kind });
  };

  for (const line of text.split('\n')) {
    // Объявления методов: `def run(self)`, `async def run(self)`, `run() {`, `#run() {`.
    const method = METHOD_DECL.exec(line);
    if (method?.[1]) remember(method[1], 'method');

    // Поля: `this.count =`, `self.count =`, `#count = 0`, `static count = 0`.
    for (const match of line.matchAll(FIELD_DECL)) if (match[1]) remember(match[1], 'field');

    // Использования: `this.#dialog`, `self.count` — то, чего не нашлось в объявлениях.
    for (const match of line.matchAll(SELF_USE)) if (match[1]) remember(match[1], 'field');
  }

  return [...found.values()];
}

/** Имя словами (буквы и цифры) — для разбора строк файла. */
const IDENT = String.raw`[\p{L}\p{Nl}\p{Nd}\p{Pc}_$][\p{L}\p{Nl}\p{Nd}\p{Pc}_$]*`;
/** Имя члена: у закрытого поля впереди `#`. */
const MEMBER = `#?${IDENT}`;

/** Объявление метода: `def run(self)`, `run() {`, `async run() {`, `get size() {`. */
const METHOD_DECL = new RegExp(
  String.raw`^\s*(?:async\s+)?(?:static\s+|get\s+|set\s+)*(?:def\s+)?(${IDENT})\s*\(`,
  'u',
);
/** Объявление поля: `this.count =`, `#count = 0`, `static count = 0`. */
const FIELD_DECL = new RegExp(String.raw`(?:^|[^.\w])(?:this|self|cls)?\.?(${MEMBER})\s*[:=]`, 'gu');
/** Использование члена текущего объекта: `this.#dialog`, `self.count`. */
const SELF_USE = new RegExp(String.raw`\b(?:this|self|cls)\s*\.\s*(${MEMBER})`, 'gu');

/**
 * Слова, которые синтаксис ставит рядом с именем, и за члены они не считаются:
 * иначе в подсказке после `this.` появились бы `if`, `return` и прочая требуха.
 */
const RESERVED: ReadonlySet<string> = new Set([
  'if',
  'for',
  'while',
  'return',
  'else',
  'elif',
  'catch',
  'switch',
  'case',
  'super',
  'this',
  'self',
  'cls',
  'new',
  'typeof',
  'const',
  'let',
  'var',
  'function',
  'def',
  'class',
  'await',
  'yield',
  'static',
  'async',
  'get',
  'set',
  'import',
  'from',
  'export',
  'default',
]);

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && ch.length > 0 && IDENT_CHAR.test(ch);
}

function isMemberChar(ch: string | undefined): boolean {
  return ch !== undefined && ch.length > 0 && MEMBER_CHAR.test(ch);
}
