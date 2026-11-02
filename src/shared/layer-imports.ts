export interface FoundImport {
  /** Спецификатор как он написан: `./edits`, `node:fs`, `electron`. */
  specifier: string;
  /** Смещение спецификатора в исходном тексте (для сообщения об ошибке). */
  offset: number;
}

/**
 * Ключевое слово и всё до открывающей кавычки включительно. Альтернативы одной длины,
 * чтобы `match[0]` всегда заканчивался ровно на кавычке:
 *   `import`  + пробелы + кавычка       — обычный импорт и реэкспорт с `from`
 *   `import(` + пробелы + кавычка       — динамический импорт
 * `export … from 'x'` попадает в первую альтернативу по слову `from`.
 */
const IMPORT_KEYWORD = /(?:\bimport\s+['"]|\bfrom\s+['"]|\bimport\s*\(\s*['"])/g;

export function findImports(source: string): FoundImport[] {
  const found: FoundImport[] = [];
  const mask = maskCode(source);
  for (const match of mask.matchAll(IMPORT_KEYWORD)) {
    // `match[0]` заканчивается на открывающей кавычке — она и есть начало литерала.
    const quoted = readStringLiteral(source, (match.index ?? 0) + match[0].length - 1);
    if (quoted !== null) found.push(quoted);
  }
  return found;
}

/**
 * Текст той же длины, где строки и комментарии заменены пробелами (переводы строк
 * сохраняются — иначе смещения разъедутся по строкам).
 *
 * Зачем: слово `import` встречается и в комментариях, и внутри литералов; без маски
 * примеры из пояснений считались бы настоящими импортами. Смещения в маске и в
 * исходнике совпадают, поэтому путь дописывается из исходника.
 */
function maskCode(source: string): string {
  const out: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source.charAt(index);
    const next = source.charAt(index + 1);
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      out.push(blank(source.slice(index, stop)));
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out.push(blank(source.slice(index, stop)));
      index = stop;
      continue;
    }
    // Обратные кавычки не трогаем: шаблон с подстановкой может содержать настоящий
    // код, а статичные части в импорт всё равно не попадают.
    if (char === "'" || char === '"') {
      const end = findStringEnd(source, index, char);
      out.push(char + blank(source.slice(index + 1, end)) + (end < source.length ? char : ''));
      index = end + 1;
      continue;
    }
    out.push(char);
    index += 1;
  }
  return ''.concat(...out);
}

/** Пробелы вместо символов, переводы строк на месте. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * Смещение закрывающей кавычки литерала, начавшегося на `start`. Учитывает `\\`:
 * кавычка после слеша — часть текста, а не конец строки.
 */
function findStringEnd(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source.charAt(index);
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) return index;
    index += 1;
  }
  return source.length;
}

/**
 * Литерал, начинающийся на кавычке в `start`: его содержимое и смещение.
 * `null` — кавычка незакрыта (обрезанный файл) или это не литерал.
 */
function readStringLiteral(source: string, start: number): FoundImport | null {
  const quote = source.charAt(start);
  if (quote !== "'" && quote !== '"') return null;
  const end = findStringEnd(source, start, quote);
  if (end >= source.length) return null;
  return { specifier: source.slice(start + 1, end), offset: start + 1 };
}
