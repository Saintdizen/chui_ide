/**
 * Разбор файла `.env`: переменные окружения проекта.
 *
 * Здесь только текст — ни файловой системы, ни процессов. Читает `.env` main
 * (там путь к проекту), а переменные уезжают туда, где запускается код: терминал,
 * тесты, установка пакетов и языковой сервер. Так все они видят одно окружение.
 *
 * Формат намеренно простой, как у dotenv: `КЛЮЧ=значение`, строки с `#` —
 * комментарии. Поддерживаем `export`, кавычки и многострочные значения — этого
 * хватает почти всем проектам, а полноценный парсер тянул бы зависимость.
 */

/** Одна переменная из файла: значение уже без кавычек и экранирования. */
export interface EnvEntry {
  key: string;
  value: string;
  /** Строка файла (1-based): по ней видно, где переменную потеряли. */
  line: number;
}

/** Имя переменной: буквы, цифры и `_`, не начинаясь с цифры. */
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Все переменные файла. Порядок сохраняем: при повторе ключа побеждает последний —
 * так же, как это делает dotenv и как ожидает человек, читающий файл сверху вниз.
 */
export function parseEnvEntries(text: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!KEY.test(key)) continue;

    let raw = withoutExport.slice(eq + 1).trim();
    // Многострочное значение в двойных кавычках: собираем до закрывающей кавычки.
    if (raw.startsWith('"') && !closesQuote(raw)) {
      let buffer = raw;
      while (index + 1 < lines.length) {
        index += 1;
        buffer += `\n${lines[index]}`;
        if (closesQuote(buffer)) break;
      }
      raw = buffer;
    }

    entries.push({ key, value: unquote(raw), line: index + 1 });
  }

  return entries;
}

/** Переменные как объект: повтор ключа перекрывает предыдущее значение. */
export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of parseEnvEntries(text)) result[entry.key] = entry.value;
  return result;
}

/** Значение начинается с `"` и уже содержит закрывающую кавычку. */
function closesQuote(value: string): boolean {
  if (!value.startsWith('"')) return true;
  // Ищем закрывающую кавычку, пропуская экранированные `\"`.
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === '\\') {
      index += 1;
      continue;
    }
    if (value[index] === '"') return true;
  }
  return false;
}

/**
 * Снять кавычки и раскрыть экранирование. Без кавычек значение берётся как есть,
 * но хвостовой комментарий (`PORT=8080 # dev`) отрезается — иначе он попадёт в значение.
 */
function unquote(value: string): string {
  if (value.startsWith('"')) {
    const withoutLeading = value.slice(1);
    const end = lastUnescapedQuote(withoutLeading);
    const body = end < 0 ? withoutLeading : withoutLeading.slice(0, end);
    return body.replace(/\\(["\\nrt])/g, (_match, char: string) => {
      if (char === 'n') return '\n';
      if (char === 'r') return '\r';
      if (char === 't') return '\t';
      return char;
    });
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end < 0 ? value.slice(1) : value.slice(1, end);
  }
  const hash = value.indexOf(' #');
  return (hash < 0 ? value : value.slice(0, hash)).trim();
}

/** Позиция последней неэкранированной кавычки в строке. */
function lastUnescapedQuote(value: string): number {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (value[index] !== '"') continue;
    let escapes = 0;
    for (let back = index - 1; back >= 0 && value[back] === '\\'; back -= 1) escapes += 1;
    if (escapes % 2 === 0) return index;
  }
  return -1;
}
