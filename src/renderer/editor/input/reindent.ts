/**
 * Выравнивание вставленного текста по отступу места вставки.
 *
 * Голый перенос из буфера оставляет отступы такими, какими они были в чужом файле:
 * скопировали блок из функции на глубине 3 — он лёг на глубине 3 и там, где ждали
 * глубину 1. Здесь отступ пересчитывается: у блока снимается ЕГО СОБСТВЕННЫЙ общий
 * отступ (наименьший по непустым строкам), а вместо него подставляется отступ строки,
 * в которую вставляем. Относительная вложенность блока сохраняется — она и есть смысл
 * текста, — а «нулевая точка» отступа переезжает на место вставки.
 *
 * Отступы сравниваются в КОЛОНКАХ, а не по числу знаков: табуляция занимает не один
 * столбец, а прыжок к следующему кратному `tabSize`. Поэтому блок, набранный табами и
 * пробелами, выравнивается так же, как выглядел. Остаток отступа выводится ПРОБЕЛАМИ:
 * табуляция после чужого `baseIndent` отсчитывалась бы от другого места строки и
 * сдвинула бы текст — а редактор и сам вставляет на Tab пробелы, так что это его же
 * соглашение.
 *
 * Модуль чистый: ни контроллера, ни DOM — строка на входе, строка на выходе.
 */

export interface ReindentOptions {
  /** Отступ строки, в которую ложится текст (её ведущие табы и пробелы). */
  readonly baseIndent: string;
  /** Ширина табуляции: без неё отступы, набранные по-разному, не сравнить. */
  readonly tabSize: number;
  /**
   * Ставить ли отступ и ПЕРВОЙ строке. Каретка в ведущих пробелах — да: блок начинается
   * с отступа строки. Каретка посреди текста — нет: первая строка его продолжает, и
   * отступ встал бы в середину строки.
   */
  readonly shiftFirstLine?: boolean;
}

/**
 * Пересчитать отступы вставленного текста. Однострочный текст возвращается как есть:
 * своего отступа у него нет, а трогать середину строки нельзя.
 */
export function reindentPasted(text: string, options: ReindentOptions): string {
  // Переносы строк приводим к тому виду, что и в документе: буфер редактора — с `\n`.
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!normalized.includes('\n')) return normalized;

  const lines = normalized.split('\n');
  const indents = lines.filter((line) => !isBlank(line)).map((line) => indentWidth(line, options.tabSize));
  // Одни пустые строки — выравнивать нечего.
  if (indents.length === 0) return normalized;

  const common = Math.min(...indents);
  const shiftFirst = options.shiftFirstLine !== false;

  return lines
    .map((line, index) => {
      // Пустая строка остаётся пустой: хвостовые пробелы в ней ничего не значат, а в
      // diff потом мешают. Это не потеря отступа — терять там нечего.
      if (isBlank(line)) return '';
      // Каретка посреди строки: первая строка вставки — продолжение текущей, её
      // собственный отступ трогать нельзя.
      if (index === 0 && !shiftFirst) return line;
      const remainder = Math.max(0, indentWidth(line, options.tabSize) - common);
      return `${options.baseIndent}${' '.repeat(remainder)}${line.trimStart()}`;
    })
    .join('\n');
}

/** Пустая ли строка: только пробелы, табы или вовсе ничего. */
function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** Ведущие табы и пробелы строки. */
function leadingWhitespace(line: string): string {
  return /^[\t ]*/.exec(line)?.[0] ?? '';
}

/** Ширина отступа строки в колонках. Табуляция — прыжок к следующему кратному `tabSize`. */
export function indentWidth(line: string, tabSize: number): number {
  const size = Math.max(1, Math.floor(tabSize));
  let columns = 0;
  for (const char of leadingWhitespace(line)) {
    columns += char === '\t' ? size - (columns % size) : 1;
  }
  return columns;
}
