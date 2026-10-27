/**
 * Разбор знаков: то, что нужно каждой грамматике.
 *
 * Грамматики различаются словами и правилами, но разбирают текст одинаково: имя —
 * это буква и дальше буквы с цифрами, число — цифры с точкой и степенью, строка — от
 * кавычки до такой же кавычки с учётом обратной косой черты. Свести это в один модуль
 * стоит не ради экономии строк: иначе каждая грамматика начнёт понимать «идентификатор»
 * по-своему, и подсветка разъедется между языками.
 *
 * Имена буквами считаем по Юникоду (`\p{L}`), а не только латиницей: в коде бывают
 * `функция`, `ñ`, иероглифы, и это тоже имена. Регулярки с флагами `u` держим
 * готовыми на уровне модуля — создавать их на каждый знак заметно дороже, чем
 * сравнивать коды.
 */

import type { Token } from './tokens';

/** Первый знак имени: буква, подчёркивание или `$` (последнее — для JS-подобных языков). */
const IDENT_START = /[\p{L}\p{Nl}_$]/u;

/** Продолжение имени: буквы, цифры, соединители и знаки письма. */
const IDENT_PART = /[\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}_$]/u;

/** Цифра — для начала числа. Шестнадцатеричные разряды проверяются отдельно. */
export function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

/** Может ли знак начать имя. */
export function isIdentStart(ch: string | undefined): boolean {
  return ch !== undefined && ch.length > 0 && IDENT_START.test(ch);
}

/** Может ли знак продолжить имя. */
export function isIdentPart(ch: string | undefined): boolean {
  return ch !== undefined && ch.length > 0 && IDENT_PART.test(ch);
}

/** Конец имени, которое начинается на `start`. */
export function scanIdentifier(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length && isIdentPart(text[index])) index += 1;
  return index;
}

/**
 * Конец числа. Поддержаны основания `0x`/`0b`/`0o`, разделители разрядов (`1_000`),
 * дробная часть и степень (`1.5e-3`), а также суффиксы (`10L`, `3.14f`). Знак числа
 * сюда не входит: `-1` — это минус и число, как их и красит любой редактор.
 */
export function scanNumber(text: string, start: number): number {
  let index = start;
  const base = text.slice(start, start + 2).toLowerCase();

  if (base === '0x' || base === '0b' || base === '0o') {
    index = start + 2;
    while (index < text.length && /[0-9a-fA-F_]/.test(text[index]!)) index += 1;
  } else {
    while (index < text.length && /[0-9_]/.test(text[index]!)) index += 1;
    // Дробная часть — только если после точки есть цифра, иначе это обращение к полю.
    if (text[index] === '.' && isDigit(text[index + 1] ?? '')) {
      index += 1;
      while (index < text.length && /[0-9_]/.test(text[index]!)) index += 1;
    }
    // Степень: `e` или `E`, необязательный знак и хотя бы одна цифра.
    const exponent = text[index];
    if (exponent === 'e' || exponent === 'E') {
      const sign = text[index + 1] === '+' || text[index + 1] === '-' ? 1 : 0;
      if (isDigit(text[index + 1 + sign])) {
        index += 1 + sign;
        while (index < text.length && isDigit(text[index]!)) index += 1;
      }
    }
  }

  // Суффиксы: `n` (BigInt), `L`/`U`/`UL` (C/Java), `f`/`d` (дробные), `i` (комплексные).
  while (index < text.length && /[nLlUuFfDdi]/.test(text[index]!)) index += 1;
  return index;
}

/** Что вышло из разбора строки: где она кончилась и закрылась ли. */
export interface ScannedString {
  readonly end: number;
  readonly closed: boolean;
}

/**
 * Конец строкового литерала, начинающегося кавычкой на `start`. Обратная косая черта
 * пропускает следующий знак — иначе `"a\"b"` кончилась бы на экранированной кавычке.
 * Незакрытая строка — обычное дело (человек печатает её прямо сейчас), поэтому это не
 * ошибка, а факт: возвращаем `closed: false`, и грамматика решает сама, тянется ли
 * такая строка на следующую строку (у шаблонов — да, у обычных кавычек — нет).
 */
export function scanQuoted(text: string, start: number, quote: string): ScannedString {
  let index = start + 1;
  while (index < text.length) {
    const ch = text[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === quote) return { end: index + 1, closed: true };
    index += 1;
  }
  return { end: text.length, closed: false };
}

/** Добавить токен, если он не пустой: пустых токенов в разметке быть не должно. */
export function push(tokens: Token[], start: number, end: number, type: string): void {
  if (end > start) tokens.push({ start, end, type });
}

/** Набор слов для быстрой проверки: массивы в конфигурациях, множества в работе. */
export function wordSet(words: readonly string[] | undefined): ReadonlySet<string> {
  return new Set(words ?? []);
}
