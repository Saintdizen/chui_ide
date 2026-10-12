/**
 * Префикс под курсором: что человек уже набрал.
 *
 * Подсказки предлагаются не «вообще», а по набранному началу слова. Значит, нужно уметь
 * взять это начало: от курсора влево, пока идут знаки слова. Функция крошечная, но
 * ошибиться в ней легко и незаметно (`форм|ат` — это префикс «форм», а не «ат»), поэтому
 * она отдельная и с тестами.
 *
 * Префикс считается по СТРОКЕ: подсказки не перешагивают перевод строки, как и поиск.
 * Пустой префикс — курсор не в слове: тогда подсказки показываются только по вызову
 * (Ctrl+Space), а не сами.
 */

/** Знак, продолжающий слово: буквы, цифры, подчёркивание, `$`. */
const WORD_CHAR = /[\p{L}\p{Nl}\p{Nd}\p{Pc}_$]/u;

/** Префикс под курсором: начало слова, которое печатается. Пустая строка — его нет. */
export function prefixAt(text: string, column: number): string {
  const at = Math.max(0, Math.min(column, text.length));
  let start = at;
  while (start > 0) {
    const ch = text[start - 1];
    if (ch === undefined || ch.length === 0 || !WORD_CHAR.test(ch)) break;
    start -= 1;
  }
  return text.slice(start, at);
}

/** Начало префикса — смещение, с которого начнётся замена при вставке подсказки. */
export function prefixStart(text: string, column: number): number {
  const prefix = prefixAt(text, column);
  return Math.max(0, Math.min(column, text.length)) - prefix.length;
}

/** Есть ли смысл показывать подсказки: набран хотя бы один знак слова. */
export function hasPrefix(text: string, column: number): boolean {
  return prefixAt(text, column).length > 0;
}
