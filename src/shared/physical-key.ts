/**
 * Клавиша по её ФИЗИЧЕСКОМУ положению — независимо от раскладки.
 *
 * `KeyboardEvent.key` зависит от раскладки: при русской `Ctrl+S` даёт `key === 'ы'`,
 * и сочетание «Ctrl+S» перестаёт совпадать со своим именем. `KeyboardEvent.code`
 * раскладку не знает вовсе: та же физическая клавиша всегда `KeyS`, `Digit1`,
 * `Slash`. Поэтому сочетания собираются по `code`, а сам символ для ВВОДА текста
 * берётся из `key` — иначе набор по-русски превращался бы в латиницу.
 *
 * Модуль чистый (строка → строка), поэтому проверяется без окна: поддельное событие
 * с русским `key` и латинским `code` — ровно то, что приходит от системы.
 */

/** Буква, цифра и знак препинания по `code`: то, что годится для имени сочетания. */
const PUNCTUATION: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  // На некоторых клавиатурах рядом с левым Shift стоит ещё один «обратный слэш».
  IntlBackslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: ' ',
};

/**
 * Имя клавиши по `code` или `null`, если клавиша не из «печатных» (`F5`, `Escape`,
 * `ArrowLeft` и прочие служебные — их `key` от раскладки не зависит).
 */
export function physicalKeyName(code: string | undefined | null): string | null {
  if (!code) return null;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!;
  // Numpad считаем той же цифрой: человек нажимает «1», а не «Numpad1».
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1]!;
  return PUNCTUATION[code] ?? null;
}

/**
 * Имя клавиши для сочетания: физическое, если оно есть, иначе `key`.
 *
 * Нужно ровно для сопоставления сочетаний. Символ для ввода текста берётся из
 * `event.key` — раскладка нужна именно там.
 */
export function shortcutKey(event: { readonly key: string; readonly code?: string }): string {
  const physical = physicalKeyName(event.code);
  if (physical !== null) return physical.length === 1 ? physical.toUpperCase() : physical;
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}
