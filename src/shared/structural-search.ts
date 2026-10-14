/**
 * Поиск и замена по СТРУКТУРЕ кода.
 *
 * Обычный поиск ищет буквальный текст: `foo(a, b)` не найдёт `foo( a,\n\tb )`. Здесь
 * образец задаётся не текстом, а строением: шаблон `foo($x, $y)` находит ВЫЗОВ `foo` с
 * двумя любыми доводами, как бы те ни были записаны в исходнике. Точками подстановки
 * (`$имя`) помечают то, что в каждом совпадении своё, а в замене эти куски переносятся
 * (`bar($x, $y)`) — так «заменить одну форму на другую» делается одной командой.
 *
 * Своего разбора дерева тут нет и не нужно: структура у нас — это ПОСЛЕДОВАТЕЛЬНОСТЬ
 * кусков (лексем), где пробелы и переводы строк ничего не значат, а скобки, кавычки и
 * комментарии — цельные куски. Этого хватает на присваивания, вызовы, объявления и
 * блоки; полный синтаксис (типы, области видимости) разбирает языковой сервер, и
 * подменять его мы не пытаемся.
 *
 * Почему модуль чистый: правила «что считается куском», «как читается шаблон» и «что
 * с чем совпало» — это то, что нужно проверять юнит-тестами без окна и без файлов.
 * Окно только собирает шаблон и рисует найденное.
 *
 * Синтаксис шаблона:
 *   `$имя`    — ЛЮБОЙ один кусок (идентификатор, число, строка, знак);
 *   `$имя...` — ЛЮБАЯ последовательность кусков (может быть и пустой); скобки внутри
 *               остаются парными, поэтому «хвост» не вылезет из своей пары;
 *   `$$`      — буквальный знак `$`.
 * В замене `$имя` подставляется на место пойманного куска, `$$` даёт `$`.
 */

/** Из чего состоит код: имя, число, строка в кавычках, комментарий или знак. */
export type TokenKind = 'ident' | 'number' | 'string' | 'comment' | 'punct';

export interface CodeToken {
  kind: TokenKind;
  /** Текст куска как он записан в исходнике (строка — вместе с кавычками). */
  text: string;
  /** Начало в тексте (смещение в знаках). */
  start: number;
  /** Конец в тексте, не включая. */
  end: number;
}

/** Кусок образца: либо точный (совпадает буквально), либо точка подстановки. */
export type TemplateItem =
  | { type: 'token'; token: { kind: TokenKind; text: string } }
  | { type: 'meta'; name: string }
  | { type: 'seq'; name: string };

export interface StructuralTemplate {
  items: TemplateItem[];
  /** Что не так с образцом; `null` — всё в порядке. */
  error: string | null;
}

/** Одно найденное место: границы, текст и что поймали точки подстановки. */
export interface StructuralMatch {
  start: number;
  end: number;
  text: string;
  /** Значения `$имя`: у одиночного — его текст, у последовательности — как записано. */
  captures: Record<string, string>;
}

/** Как читать текст: считать ли `#` началом комментария. */
export interface TokenizeOptions {
  /** `false` — `#` это не комментарий (CSS-цвет, заголовок markdown). По умолчанию — да. */
  hashComments?: boolean;
}

// ── разбор на куски ──────────────────────────────────────────────────────────

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** Первый знак имени: латиница, `_`, `$` или любой не-ASCII (кириллица в именах). */
function isIdentStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36 || code > 127;
}

/** Продолжение имени: то же плюс цифры. */
function isIdentPart(code: number): boolean {
  return isIdentStart(code) || isDigit(code);
}

/** Считать число: десятичное, шестнадцатеричное, с точкой и порядком. */
function readNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  const hex = text.charCodeAt(i) === 48 && ['x', 'X', 'b', 'o'].includes(text[i + 1] ?? '');
  if (hex) {
    i += 2;
    while (i < n && isIdentPart(text.charCodeAt(i))) i += 1;
    return i;
  }
  while (i < n && (isDigit(text.charCodeAt(i)) || text[i] === '_')) i += 1;
  if (text[i] === '.' && isDigit(text.charCodeAt(i + 1))) {
    i += 1;
    while (i < n && (isDigit(text.charCodeAt(i)) || text[i] === '_')) i += 1;
  }
  if (text[i] === 'e' || text[i] === 'E') {
    const save = i;
    i += 1;
    if (text[i] === '+' || text[i] === '-') i += 1;
    if (isDigit(text.charCodeAt(i))) while (i < n && isDigit(text.charCodeAt(i))) i += 1;
    else i = save;
  }
  return i;
}

/** Считать строку в кавычках как один кусок: содержимое рвать нельзя. */
function readString(text: string, from: number): number {
  const quote = text.charCodeAt(from);
  const n = text.length;
  let i = from + 1;
  while (i < n) {
    const code = text.charCodeAt(i);
    if (code === 92 /* \ */) {
      i += 2;
      continue;
    }
    i += 1;
    if (code === quote) break;
  }
  return i;
}

/**
 * Разложить текст на куски. Пробелы выбрасываются (в структуре они не значат ничего),
 * а строка, комментарий и число берутся целиком — иначе `"a b"` разъехалось бы на три
 * куска и совпало с чем угодно.
 */
export function tokenizeCode(text: string, options: TokenizeOptions = {}): CodeToken[] {
  const hashComments = options.hashComments !== false;
  const tokens: CodeToken[] = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const code = text.charCodeAt(i);
    if (isSpace(code)) {
      i += 1;
      continue;
    }
    // Строчный комментарий `//` и блочный `/* … */`.
    if (code === 47 && text.charCodeAt(i + 1) === 47) {
      const start = i;
      while (i < n && text.charCodeAt(i) !== 10) i += 1;
      tokens.push({ kind: 'comment', text: text.slice(start, i), start, end: i });
      continue;
    }
    if (code === 47 && text.charCodeAt(i + 1) === 42) {
      const start = i;
      i += 2;
      while (i < n && !(text.charCodeAt(i) === 42 && text.charCodeAt(i + 1) === 47)) i += 1;
      i = Math.min(n, i + 2);
      tokens.push({ kind: 'comment', text: text.slice(start, i), start, end: i });
      continue;
    }
    // `#` — комментарий Python, shell, конфигов.
    if (code === 35 && hashComments) {
      const start = i;
      while (i < n && text.charCodeAt(i) !== 10) i += 1;
      tokens.push({ kind: 'comment', text: text.slice(start, i), start, end: i });
      continue;
    }
    if (code === 39 || code === 34 || code === 96) {
      const start = i;
      i = readString(text, i);
      tokens.push({ kind: 'string', text: text.slice(start, i), start, end: i });
      continue;
    }
    if (isDigit(code)) {
      const start = i;
      i = readNumber(text, i);
      tokens.push({ kind: 'number', text: text.slice(start, i), start, end: i });
      continue;
    }
    if (isIdentStart(code)) {
      const start = i;
      i += 1;
      while (i < n && isIdentPart(text.charCodeAt(i))) i += 1;
      tokens.push({ kind: 'ident', text: text.slice(start, i), start, end: i });
      continue;
    }
    tokens.push({ kind: 'punct', text: text[i] ?? '', start: i, end: i + 1 });
    i += 1;
  }

  return tokens;
}

// ── разбор образца ───────────────────────────────────────────────────────────

/**
 * Прочитать образец в куски и точки подстановки. Комментарии в образце выбрасываются:
 * в структуре они не участвуют, и держать их значило бы искать вместе с ними.
 */
export function parseTemplate(source: string): StructuralTemplate {
  const items: TemplateItem[] = [];
  const n = source.length;
  let i = 0;

  const push = (kind: TokenKind, text: string): void => {
    items.push({ type: 'token', token: { kind, text } });
  };

  while (i < n) {
    const code = source.charCodeAt(i);
    if (isSpace(code)) {
      i += 1;
      continue;
    }
    if (code === 47 && source.charCodeAt(i + 1) === 47) {
      while (i < n && source.charCodeAt(i) !== 10) i += 1;
      continue;
    }
    if (code === 47 && source.charCodeAt(i + 1) === 42) {
      i += 2;
      while (i < n && !(source.charCodeAt(i) === 42 && source.charCodeAt(i + 1) === 47)) i += 1;
      i = Math.min(n, i + 2);
      continue;
    }
    if (code === 35) {
      while (i < n && source.charCodeAt(i) !== 10) i += 1;
      continue;
    }
    if (code === 36 /* $ */) {
      // `$$` — буквальный знак доллара.
      if (source.charCodeAt(i + 1) === 36) {
        push('punct', '$');
        i += 2;
        continue;
      }
      let j = i + 1;
      while (j < n && isIdentPart(source.charCodeAt(j))) j += 1;
      const name = source.slice(i + 1, j);
      if (name === '') {
        push('punct', '$');
        i += 1;
        continue;
      }
      if (source.startsWith('...', j)) {
        items.push({ type: 'seq', name });
        i = j + 3;
        continue;
      }
      items.push({ type: 'meta', name });
      i = j;
      continue;
    }
    if (code === 39 || code === 34 || code === 96) {
      const end = readString(source, i);
      push('string', source.slice(i, end));
      i = end;
      continue;
    }
    if (isDigit(code)) {
      const end = readNumber(source, i);
      push('number', source.slice(i, end));
      i = end;
      continue;
    }
    if (isIdentStart(code)) {
      const start = i;
      i += 1;
      while (i < n && isIdentPart(source.charCodeAt(i))) i += 1;
      push('ident', source.slice(start, i));
      continue;
    }
    push('punct', source[i] ?? '');
    i += 1;
  }

  return { items, error: items.length === 0 ? 'Образец пуст.' : null };
}

/** Образец из готового текста: знаки `$` в нём — буквальные, а не точки подстановки. */
export function literalTemplate(text: string): string {
  return text.replace(/\$/g, '$$$$');
}

// ── сопоставление ────────────────────────────────────────────────────────────

/** Все скобки в срезе кусков парны? Тогда «последовательность» не вылезет из своей пары. */
function balanced(tokens: readonly CodeToken[], from: number, to: number): boolean {
  let depth = 0;
  for (let i = from; i < to; i += 1) {
    const text = tokens[i]?.text;
    if (text === '(' || text === '[' || text === '{') depth += 1;
    else if (text === ')' || text === ']' || text === '}') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

interface MatchState {
  tokenIndex: number;
  captures: Record<string, string>;
}

/**
 * Совпал ли образец с текстом, начиная с куска `from`. Возвращает, где совпадение
 * кончилось, и что поймали подстановки; `null` — не совпало.
 *
 * Последовательность `$имя...` подбирается сначала КОРОТКОЙ (жадно-лениво): так
 * `foo($a...)` на `foo(a, b)` даёт `a, b` целиком, а не «нуль кусков и остаток не сошёлся».
 * Срез берётся по смещениям кусков, поэтому пробелы и переводы строк внутри сохраняются
 * ровно такими, какими были в исходнике.
 */
function matchFrom(
  items: readonly TemplateItem[],
  itemIndex: number,
  tokens: readonly CodeToken[],
  from: number,
  captures: Record<string, string>,
  text: string,
): MatchState | null {
  if (itemIndex === items.length) return { tokenIndex: from, captures };

  const item = items[itemIndex]!;
  if (item.type === 'token') {
    const token = tokens[from];
    if (!token) return null;
    if (token.kind !== item.token.kind || token.text !== item.token.text) return null;
    return matchFrom(items, itemIndex + 1, tokens, from + 1, captures, text);
  }

  if (item.type === 'meta') {
    const token = tokens[from];
    if (!token) return null;
    return matchFrom(items, itemIndex + 1, tokens, from + 1, { ...captures, [item.name]: token.text }, text);
  }

  // Последовательность: перебираем длины от нуля вверх, режем только по парным скобкам.
  for (let end = from; end <= tokens.length; end += 1) {
    if (!balanced(tokens, from, end)) continue;
    const first = tokens[from];
    const last = tokens[end - 1];
    const captured = end > from && first && last ? text.slice(first.start, last.end) : '';
    const next = matchFrom(items, itemIndex + 1, tokens, end, { ...captures, [item.name]: captured }, text);
    if (next) return next;
  }
  return null;
}

/**
 * Все совпадения образца в тексте. Совпадения не перекрываются: найдя одно, идём дальше
 * за его концом. Комментарии в сопоставлении не участвуют — они не структура.
 */
export function structuralFind(
  text: string,
  template: StructuralTemplate,
  options: TokenizeOptions = {},
): StructuralMatch[] {
  if (template.error || template.items.length === 0) return [];

  const tokens = tokenizeCode(text, options).filter((token) => token.kind !== 'comment');
  const matches: StructuralMatch[] = [];

  let i = 0;
  while (i < tokens.length) {
    const state = matchFrom(template.items, 0, tokens, i, {}, text);
    if (state && state.tokenIndex > i) {
      const first = tokens[i]!;
      const last = tokens[state.tokenIndex - 1]!;
      matches.push({
        start: first.start,
        end: last.end,
        text: text.slice(first.start, last.end),
        captures: state.captures,
      });
      i = state.tokenIndex;
    } else {
      i += 1;
    }
  }

  return matches;
}

/** Подставить пойманные куски в текст замены: `$имя` → кусок, `$$` → `$`. */
export function expandStructural(replacement: string, captures: Record<string, string>): string {
  let out = '';
  let i = 0;
  const n = replacement.length;
  while (i < n) {
    const char = replacement[i]!;
    if (char !== '$') {
      out += char;
      i += 1;
      continue;
    }
    if (replacement[i + 1] === '$') {
      out += '$';
      i += 2;
      continue;
    }
    let j = i + 1;
    while (j < n && isIdentPart(replacement.charCodeAt(j))) j += 1;
    const name = replacement.slice(i + 1, j);
    if (name !== '' && Object.hasOwn(captures, name)) {
      out += captures[name];
      i = j;
      continue;
    }
    // Неизвестное имя оставляем как есть: молча стереть его значило бы испортить текст.
    out += char;
    i += 1;
  }
  return out;
}

export interface StructuralReplaceResult {
  text: string;
  count: number;
  matches: StructuralMatch[];
}

/** Заменить все совпадения образца. `count` — сколько заменено. */
export function structuralReplace(
  text: string,
  template: StructuralTemplate,
  replacement: string,
  options: TokenizeOptions = {},
): StructuralReplaceResult {
  const matches = structuralFind(text, template, options);
  if (matches.length === 0) return { text, count: 0, matches };

  let out = '';
  let cursor = 0;
  for (const match of matches) {
    out += text.slice(cursor, match.start);
    out += expandStructural(replacement, match.captures);
    cursor = match.end;
  }
  out += text.slice(cursor);
  return { text: out, count: matches.length, matches };
}

/** Правка ОДНОГО участка — от первого совпадения до последнего. */
export interface StructuralEdit {
  start: number;
  end: number;
  removed: string;
  inserted: string;
  count: number;
}

/**
 * Та же замена, но собранная ОДНОЙ правкой на диапазон от первого совпадения до
 * последнего. Так её видит история правок редактора: шаг применяется и отменяется по
 * одной записи, а набор из десятка правок со съехавшими смещениями туда не годится.
 */
export function structuralReplaceEdit(
  text: string,
  template: StructuralTemplate,
  replacement: string,
  options: TokenizeOptions = {},
): StructuralEdit | null {
  const matches = structuralFind(text, template, options);
  if (matches.length === 0) return null;

  const start = matches[0]!.start;
  const end = matches[matches.length - 1]!.end;
  let inserted = '';
  let cursor = start;
  for (const match of matches) {
    inserted += text.slice(cursor, match.start);
    inserted += expandStructural(replacement, match.captures);
    cursor = match.end;
  }
  inserted += text.slice(cursor, end);

  return { start, end, removed: text.slice(start, end), inserted, count: matches.length };
}
