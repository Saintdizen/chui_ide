/**
 * Символы проекта: разбор ответа `workspace/symbol`.
 *
 * Сервер подсказок умеет искать по всему проекту («перейти к символу»), и это
 * единственный способ найти класс или функцию, не зная файла. Разбор ответа —
 * правило, а не I/O, поэтому живёт здесь и проверяется без Electron.
 *
 * Про `file://` модуль не знает: превращение ссылки в путь делает main (у него
 * для этого есть утилиты Node). Сюда его передают функцией — так разбор остаётся
 * чистым, а тест обходится без файловой системы.
 *
 * LSP отдаёт `SymbolInformation` (плоский список) или `WorkspaceSymbol`
 * (3.17): у второго координаты необязательны, а имя — единственное, что есть
 * всегда. Всё это сводим к одной форме.
 */

/** Один символ проекта в нашей форме: путь + позиция + подпись. */
export interface ProjectSymbol {
  name: string;
  /** Вид символа словами: «класс», «функция». Нужен для показа рядом с именем. */
  kind: string;
  /** Где объявлен (класс или модуль), если сервер это сообщил. */
  container: string | null;
  /** Путь к файлу: получается из `file://`-ссылки ответа. */
  path: string;
  /** Строка (1-based). */
  line: number;
  /** Столбец (1-based). */
  column: number;
}

/** Виды символов LSP: номера из спецификации, по-русски — для показа человеку. */
const KIND_NAMES: Readonly<Record<number, string>> = {
  1: 'файл',
  2: 'модуль',
  3: 'пространство имён',
  4: 'пакет',
  5: 'класс',
  6: 'метод',
  7: 'свойство',
  8: 'поле',
  9: 'конструктор',
  10: 'перечисление',
  11: 'интерфейс',
  12: 'функция',
  13: 'переменная',
  14: 'константа',
  15: 'строка',
  16: 'число',
  17: 'логическое',
  18: 'массив',
  19: 'объект',
  20: 'ключ',
  21: 'null',
  22: 'элемент перечисления',
  23: 'структура',
  24: 'событие',
  25: 'оператор',
  26: 'параметр типа',
};

/**
 * Символы из ответа сервера. `toPath` превращает ссылку в путь; запись, для
 * которой это не удалось, пропускаем — открыть её всё равно нельзя.
 */
export function toProjectSymbols(raw: unknown, toPath: (uri: string) => string): ProjectSymbol[] {
  if (!Array.isArray(raw)) return [];

  const symbols: ProjectSymbol[] = [];
  for (const item of raw) {
    const symbol = toProjectSymbol(item, toPath);
    if (symbol) symbols.push(symbol);
  }
  return symbols;
}

function toProjectSymbol(raw: unknown, toPath: (uri: string) => string): ProjectSymbol | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { name?: unknown; kind?: unknown; containerName?: unknown; location?: unknown };
  if (typeof value.name !== 'string') return null;

  const location = value.location as
    | { uri?: unknown; range?: { start?: { line?: unknown; character?: unknown } } }
    | undefined;
  const uri = location?.uri;
  if (typeof uri !== 'string') return null;

  const path = safePath(uri, toPath);
  if (!path) return null;

  const start = location?.range?.start;
  return {
    name: value.name,
    kind: typeof value.kind === 'number' ? (KIND_NAMES[value.kind] ?? 'символ') : 'символ',
    container: typeof value.containerName === 'string' && value.containerName ? value.containerName : null,
    path,
    line: typeof start?.line === 'number' ? start.line + 1 : 1,
    column: typeof start?.character === 'number' ? start.character + 1 : 1,
  };
}

/** Путь из ссылки; битая ссылка — не повод падать, просто пропускаем символ. */
function safePath(uri: string, toPath: (uri: string) => string): string | null {
  try {
    return toPath(uri) || null;
  } catch {
    return null;
  }
}

/**
 * Оставить символы, подходящие под запрос, и убрать лишние повторы.
 *
 * Фильтр по подстроке без учёта регистра: сервер уже отсортировал по релевантности,
 * и переупорядочивать его выдачу значило бы спорить с ним. Повторы убираем —
 * один и тот же символ может прийти и как «объявление», и как «реализация».
 */
export function filterSymbols(symbols: readonly ProjectSymbol[], query: string, limit = 50): ProjectSymbol[] {
  const needle = query.trim().toLowerCase();
  const seen = new Set<string>();
  const result: ProjectSymbol[] = [];

  for (const symbol of symbols) {
    if (needle && !symbol.name.toLowerCase().includes(needle)) continue;
    const key = `${symbol.name}|${symbol.path}|${symbol.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(symbol);
    if (result.length >= limit) break;
  }

  return result;
}
