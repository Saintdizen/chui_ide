/**
 * Приведение текста к тому виду, в котором его стоит писать на диск: обрезать
 * пробелы в концах строк и поставить перевод строки в конце файла.
 *
 * Обе правки выключены по умолчанию: это вмешательство в файл, которое человек
 * не просил явно. Включаются настройками — и тогда уж применяются молча, как в
 * других редакторах, иначе на каждое сохранение пришлось бы отвечать на вопрос.
 *
 * Живёт в `shared`, а не в renderer: это чистая функция над текстом, её стоит
 * закрепить тестом (`tests/save-edits.test.ts`).
 */

export interface SaveEditOptions {
  /** Убрать пробелы и табуляции в конце строк. */
  trimTrailingWhitespace: boolean;
  /** Дописать перевод строки в конце файла, если его нет. */
  insertFinalNewline: boolean;
}

/** Убрать хвостовые пробелы у каждой строки. Сам перевод строки не трогаем. */
function trimLineEnds(text: string): string {
  // Хвост последней строки (без перевода) тоже подрезаем — `$` в конце образца.
  return text.replace(/[ \t]+(?=\r?\n|$)/g, '');
}

/** Дописать `\n` в конце файла. Пустой файл и файл с переводом уже в порядке. */
function addFinalNewline(text: string): string {
  if (text === '' || text.endsWith('\n')) return text;
  return `${text}\n`;
}

/**
 * Текст для записи на диск. Порядок как в других редакторах: сначала подрезаем
 * хвосты, потом ставим завершающий перевод — иначе он попал бы под подрезку.
 */
export function applySaveEdits(text: string, options: SaveEditOptions): string {
  let result = text;
  if (options.trimTrailingWhitespace) result = trimLineEnds(result);
  if (options.insertFinalNewline) result = addFinalNewline(result);
  return result;
}
