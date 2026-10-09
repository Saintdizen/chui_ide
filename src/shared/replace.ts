/**
 * Поиск с заменой по тексту файла. Чистая логика без диска и DOM: её проверяют
 * юнит-тесты, а main применяет к файлам проекта, найденным обходом.
 */

export interface ReplaceOptions {
  /** `query` — регулярное выражение (иначе ищем буквальную строку). */
  isRegex?: boolean;
  caseSensitive?: boolean;
}

export interface ReplaceTextResult {
  text: string;
  count: number;
}

/** Экранирование спецсимволов регулярки: буквальный запрос не должен «взрываться». */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Заменяет все вхождения `query` на `replacement`.
 *
 * Литеральная замена трактуется буквально: `$` в замене не превращается в
 * ссылку на группу — иначе «цена: $5» ломала бы результат. При работе с
 * регуляркой ссылки (`$1`) остаются рабочими: это ожидаемое поведение.
 */
export function replaceAll(
  text: string,
  query: string,
  replacement: string,
  options: ReplaceOptions = {},
): ReplaceTextResult {
  if (!query) return { text, count: 0 };

  const flags = options.caseSensitive ? 'g' : 'gi';
  const source = options.isRegex ? query : escapeRegExp(query);

  let pattern: RegExp;
  try {
    pattern = new RegExp(source, flags);
  } catch {
    // Некорректная регулярка — это ошибка ввода, а не повод портить файл.
    return { text, count: 0 };
  }

  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) return { text, count: 0 };

  const next = options.isRegex
    ? text.replace(pattern, replacement)
    : text.replace(pattern, replacement.replace(/\$/g, '$$$$'));

  return { text: next, count: matches.length };
}
