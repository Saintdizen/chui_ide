/**
 * Разбор ответа `textDocument/semanticTokens`: точная подсветка от языкового сервера.
 *
 * Своя подсветка (`highlight/`) разбирает текст построчно и потому приблизительна: она не
 * знает, что за имя под ней — тип, переменная или функция. Сервер знает, потому что
 * разобрал программу целиком; его ответ и есть семантические токены. Мы накладываем их
 * ПОВЕРХ своей подсветки: где сервер высказался, его слово важнее.
 *
 * Формат ответа особый: не список участков, а плоский набор чисел, где каждый токен —
 * пятёрка, а позиция записана СДВИГОМ от предыдущего токена (так ответ короче). Первое
 * число пары — сдвиг по строкам, второе — столбец (при сдвиге на новую строку он берётся
 * как есть, иначе прибавляется к прежнему). Тип токена — индекс в легенде, которую сервер
 * объявил при initialize; модификаторы — битовая маска по её же списку.
 *
 * Модуль чистый: ни сети, ни DOM. Координаты переводим в 1-based — так их видит редактор
 * (см. `SquigglyDecoration`, `LinkedRange`), а второй перевод в другом месте развёл бы их.
 */

import type { TokenKey } from './theme-file';

/** Легенда сервера: списки имён типов и модификаторов. По ним читаются индексы в `data`. */
export interface SemanticLegend {
  readonly tokenTypes: readonly string[];
  readonly tokenModifiers: readonly string[];
}

/** Токен подсветки: участок строки и его роль. Столбцы с единицы, как их видит редактор. */
export interface SemanticToken {
  /** Строка (1-based). */
  readonly line: number;
  /** Столбец начала (1-based, включительно). */
  readonly startColumn: number;
  /** Столбец конца (1-based, исключительно). */
  readonly endColumn: number;
  /** Имя типа из легенды (`type`, `function`, `variable`…). */
  readonly type: string;
  /** Имена модификаторов из легенды (`readonly`, `static`…). Может быть пустым. */
  readonly modifiers: string[];
}

/**
 * Стандартный набор типов из спецификации LSP. Объявляем его серверу в `clientCapabilities`
 * и берём как запасной, если сервер своей легенды не прислал (тогда индексы читать не по чему,
 * и токены просто не разберутся — но не упадём).
 */
export const STANDARD_TOKEN_TYPES = [
  'namespace',
  'type',
  'class',
  'enum',
  'interface',
  'struct',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'event',
  'function',
  'method',
  'macro',
  'keyword',
  'modifier',
  'comment',
  'string',
  'number',
  'regexp',
  'operator',
  'decorator',
] as const;

/** Стандартные модификаторы из спецификации: используются как маска в ответе. */
export const STANDARD_TOKEN_MODIFIERS = [
  'declaration',
  'definition',
  'readonly',
  'static',
  'deprecated',
  'abstract',
  'async',
  'modification',
  'documentation',
  'defaultLibrary',
] as const;

/** Легенда-заглушка: стандартный набор. Нужна, когда сервер своей легенды не оставил. */
export const STANDARD_LEGEND: SemanticLegend = {
  tokenTypes: STANDARD_TOKEN_TYPES,
  tokenModifiers: STANDARD_TOKEN_MODIFIERS,
};

/**
 * Разобрать ответ `semanticTokens/full`. Принимаем и `{ data: [...] }`, и сам массив:
 * разные серверы отвечают по-разному. Битые ответы (не числа, не кратно пяти) пропускаем
 * целиком — частично разобранная подсветка хуже отсутствия.
 */
export function decodeSemanticTokens(raw: unknown, legend: SemanticLegend): SemanticToken[] {
  const data = Array.isArray(raw) ? raw : ((raw as { data?: unknown } | null)?.data ?? null);
  if (!Array.isArray(data) || data.length === 0) return [];
  if (data.length % 5 !== 0) return [];
  for (const value of data) if (typeof value !== 'number' || !Number.isFinite(value)) return [];

  const tokens: SemanticToken[] = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index < data.length; index += 5) {
    const deltaLine = data[index]!;
    const deltaStart = data[index + 1]!;
    const length = data[index + 2]!;
    const typeIndex = data[index + 3]!;
    const modifierMask = data[index + 4]!;
    if (deltaLine < 0 || deltaStart < 0 || length <= 0) return [];

    line += deltaLine;
    character = deltaLine === 0 ? character + deltaStart : deltaStart;

    const type = legend.tokenTypes[typeIndex];
    // Тип вне легенды — сервер сказал то, чего не объявлял; токен пропускаем.
    if (typeof type !== 'string') continue;

    tokens.push({
      line: line + 1,
      startColumn: character + 1,
      endColumn: character + length + 1,
      type,
      modifiers: modifiersOf(modifierMask, legend.tokenModifiers),
    });
  }
  return tokens;
}

/** Модификаторы из маски: бит `i` — включён ли `legend.tokenModifiers[i]`. */
function modifiersOf(mask: number, names: readonly string[]): string[] {
  const out: string[] = [];
  for (let bit = 0; bit < names.length; bit += 1) {
    if ((mask & (1 << bit)) !== 0) out.push(names[bit]!);
  }
  return out;
}

/**
 * Роль палитры для типа токена сервера. Своя таблица, а не наши имена типов подсветки:
 * сервер говорит на языке спецификации (`variable`, `enumMember`, `typeParameter`), а
 * палитра знает свои роли (`TokenKey`). Неизвестный тип — `null`: красить нечем, и
 * подсветка под ним остаётся от грамматики.
 */
const SEMANTIC_ROLES: Record<string, TokenKey | null> = {
  namespace: 'type',
  type: 'type',
  class: 'type',
  enum: 'type',
  interface: 'type',
  struct: 'type',
  typeParameter: 'type',
  parameter: 'identifier',
  variable: 'identifier',
  property: 'identifier',
  enumMember: 'identifier',
  event: 'identifier',
  function: 'function',
  method: 'function',
  macro: 'function',
  decorator: 'function',
  keyword: 'keyword',
  modifier: 'keyword',
  comment: 'comment',
  string: 'string',
  number: 'number',
  regexp: 'string',
  // Операторы и знаки препинания сервер тоже называет, но у нас они бесцветны: роль не даём.
  operator: null,
};

/** Роль палитры для типа токена сервера. `null` — красить не надо или тип неизвестен. */
export function semanticTokenRole(type: string): TokenKey | null {
  return SEMANTIC_ROLES[type] ?? null;
}
