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

/**
 * Члены НАЗВАННОГО класса прямо из текста файла.
 *
 * Запасной путь, который закрывает то, чего не умеет разбор по `self`: набрав
 * `self.Elements.ba`, человек ждёт членов класса `Elements` (вложенный класс, поле,
 * фабрика), а не только своих. Собираем объявления внутри класса с учётом отступа:
 * присваивания (`back_to_old_design = Element(…)`) — поля, `def`/`name() {` — методы,
 * вложенный `class` — тоже поле. Тело методов пропускаем по отступу: строки глубже
 * первого члена — это уже код метода, а не члены класса.
 *
 * Разбор по отступу работает и для Python, и для JS/TS (в них члены класса тоже
 * сдвинуты вправо), поэтому отдельная грамматика на каждый язык не нужна.
 */
export function classMembers(text: string, className: string): MemberEntry[] {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const header = CLASS_DECL.exec(lines[index] ?? '');
    if (!header || header[2] !== className) continue;
    const baseIndent = header[1]?.length ?? 0;
    const found = new Map<string, MemberEntry>();
    const remember = (name: string, kind: MemberEntry['kind']): void => {
      if (!name || RESERVED.has(name) || found.has(name)) return;
      found.set(name, { name, kind });
    };

    let bodyIndent: number | null = null;
    for (let at = index + 1; at < lines.length; at += 1) {
      const line = lines[at] ?? '';
      if (!line.trim()) continue;
      const indent = leadingSpaces(line);
      // Отступ вернулся на уровень класса или выше — объявление кончилось.
      if (indent <= baseIndent) break;
      // Первый член задаёт отступ тела: всё глубже — это уже код метода.
      if (bodyIndent === null) bodyIndent = indent;
      if (indent > bodyIndent) continue;

      const method = METHOD_DECL.exec(line);
      if (method?.[1]) {
        remember(method[1], 'method');
        continue;
      }
      const nested = CLASS_DECL.exec(line);
      if (nested?.[2]) {
        remember(nested[2], 'field');
        continue;
      }
      const field = FIELD_LINE.exec(line);
      if (field?.[2]) remember(field[2], 'field');
    }
    return [...found.values()];
  }
  return [];
}

/**
 * Имя ТИПА приёмника по тексту файла: аннотация (`browser: BaseWebDriver`) или
 * присваивание экземпляра (`self.browser = BaseWebDriver(...)`).
 *
 * Это ровно то, чего не хватало МНОГОУРОВНЕВОМУ вложению: в `self.browser.driver.`
 * приёмник `browser` — ни `self`, ни имя класса, и по одному имени разобрать его было
 * нечем. Тип берём из объявления, а аннотацию ставим выше присваивания: она точнее.
 * `null` — тип в тексте не назван (тогда остаётся ответ языкового сервера).
 */
export function receiverType(text: string, receiver: string): string | null {
  const name = escapeRegExp(receiver);
  // Владелец — `self.`/`this.`/`cls.` или ничего: `browser: BaseWebDriver` — параметр.
  const head = String.raw`(?:^|[^\w.$])(?:self|this|cls)?\.?${name}`;
  const patterns = [
    new RegExp(String.raw`${head}\s*:\s*['"]?(${IDENT})`, 'mu'),
    new RegExp(String.raw`${head}\s*=\s*(?:new\s+)?(${IDENT})\s*\(`, 'mu'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Члены приёмника из текста файла. `self`/`this`/`cls` — члены текущего объекта
 * (`selfMembers`). Имя класса — его члены (`classMembers`). Поле или переменная
 * (`browser`, `driver`) — члены ТИПА, который ей присвоен или приписан аннотацией.
 */
export function membersOf(text: string, receiver: string): MemberEntry[] {
  if (isSelfReceiver(receiver)) return selfMembers(text);
  const named = classMembers(text, receiver);
  if (named.length > 0) return named;
  const type = receiverType(text, receiver);
  return type ? classMembers(text, type) : [];
}

/** Экранирование имени для вставки в регулярное выражение. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Сколько пробелов от начала строки до первого знака (`\t` считаем за два). */
function leadingSpaces(line: string): number {
  let count = 0;
  for (const ch of line) {
    if (ch === ' ') count += 1;
    else if (ch === '\t') count += 2;
    else break;
  }
  return count;
}

/** Имя словами (буквы и цифры) — для разбора строк файла. */
const IDENT = String.raw`[\p{L}\p{Nl}\p{Nd}\p{Pc}_$][\p{L}\p{Nl}\p{Nd}\p{Pc}_$]*`;
/** Объявление класса: `class Elements:` (Python) или `class Elements {` (JS/TS). */
const CLASS_DECL = new RegExp(String.raw`^(\s*)class\s+(${IDENT})`, 'u');
/** Присваивание на уровне класса: `back_to_old_design = …` или `x: int = …`. */
const FIELD_LINE = new RegExp(String.raw`^(\s*)(${IDENT})\s*(?::[^=]*)?=`, 'u');
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
