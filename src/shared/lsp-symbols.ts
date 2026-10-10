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

/* ── скелет одного файла ────────────────────────────────────────────────── */

/**
 * Символ внутри файла: имя, вид и строки. Вложенность сохраняем — метод внутри
 * класса читается иначе, чем функция на верхнем уровне.
 */
export interface FileSymbol {
  name: string;
  /** Вид словами: «класс», «метод», «функция». */
  kind: string;
  /** Строка начала (1-based). */
  line: number;
  /** Строка конца (1-based). Равна `line`, если сервер конца не сообщил. */
  endLine: number;
  children: FileSymbol[];
}

/** Символы одного файла — ответ `textDocument/documentSymbol`. */
export function toFileSymbols(raw: unknown): FileSymbol[] {
  if (!Array.isArray(raw)) return [];

  const symbols: FileSymbol[] = [];
  for (const item of raw) {
    const symbol = toFileSymbol(item);
    if (symbol) symbols.push(symbol);
  }
  return symbols;
}

/**
 * Один символ. Сервер отвечает двумя формами: `DocumentSymbol` (с вложенностью
 * и `range`) и `SymbolInformation` (плоский список с `location`). Понимаем обе —
 * какие-то серверы до сих пор отвечают старым способом.
 */
function toFileSymbol(raw: unknown): FileSymbol | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as {
    name?: unknown;
    kind?: unknown;
    range?: unknown;
    location?: unknown;
    children?: unknown;
  };
  if (typeof value.name !== 'string' || !value.name) return null;

  const range = (value.range ?? (value.location as { range?: unknown } | undefined)?.range) as
    | { start?: { line?: unknown }; end?: { line?: unknown } }
    | undefined;
  const start = lineIndex(range?.start?.line);
  if (start === null) return null;

  // Конец диапазона в LSP — исключающий, и он же нулевой: последняя занятая
  // строка в 1-based виде — это ровно `end.line`. Отсюда «+1 −1» и берётся.
  const end = lineIndex(range?.end?.line);
  const children: FileSymbol[] = [];
  if (Array.isArray(value.children)) {
    for (const child of value.children) {
      const symbol = toFileSymbol(child);
      if (symbol) children.push(symbol);
    }
  }

  return {
    name: value.name,
    kind: typeof value.kind === 'number' ? (KIND_NAMES[value.kind] ?? 'символ') : 'символ',
    line: start + 1,
    // Сервер не сообщил конец — считаем символ однострочным: обещать диапазон
    // наугад хуже, чем показать одну строку.
    endLine: end === null ? start + 1 : Math.max(start + 1, end),
    children,
  };
}

/**
 * Номер строки из ответа сервера как целое (0-based, как в LSP); мусор — `null`,
 * а не ноль. Отрицательное не бывает, но выдуманный файл из чужого ответа лучше
 * показать первой строкой, чем отрицательной.
 */
function lineIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

/** Сколько всего объявлений, включая вложенные. */
export function countFileSymbols(symbols: readonly FileSymbol[]): number {
  let total = 0;
  for (const symbol of symbols) total += 1 + countFileSymbols(symbol.children);
  return total;
}

/** «1 объявление», «2 объявления», «5 объявлений». */
function declarations(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} объявление`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} объявления`;
  return `${count} объявлений`;
}

/** Строка скелета: номера строк, вид и имя. Диапазон — только если он не одна строка. */
function outlineLine(symbol: FileSymbol, depth: number): string {
  const where = symbol.endLine > symbol.line ? `${symbol.line}–${symbol.endLine}` : String(symbol.line);
  return `${'  '.repeat(depth)}${where}: ${symbol.kind} ${symbol.name}`;
}

/** Предел строк вывода: скелет огромного файла не должен вытеснить беседу. */
const MAX_OUTLINE_LINES = 200;

/**
 * Скелет файла — то, чем агент узнаёт устройство файла, не читая его целиком:
 * объявления с номерами строк, без тел. Номера сразу годятся для `read_file`
 * с диапазоном, а строки кода агент запросит уже точечно.
 */
export function formatOutline(
  file: string,
  symbols: readonly FileSymbol[],
  options: { maxLines?: number; totalLines?: number } = {},
): { summary: string; detail: string; total: number; lines: number } {
  const total = countFileSymbols(symbols);
  const name = baseName(file);
  const size = options.totalLines !== undefined ? ` из ${options.totalLines} строк` : '';

  if (total === 0) {
    return {
      summary: `${name}: объявлений нет`,
      detail:
        `Объявлений в ${file} не нашлось: файл без символов, не тот язык или языковой сервер ` +
        'его не разобрал. Смотри содержимое через search или read_file.',
      total: 0,
      lines: 0,
    };
  }

  const limit = options.maxLines ?? MAX_OUTLINE_LINES;
  const out: string[] = [];
  let shown = 0;
  let cut = false;

  const walk = (items: readonly FileSymbol[], depth: number): void => {
    for (const symbol of items) {
      if (out.length >= limit) {
        cut = true;
        return;
      }
      out.push(outlineLine(symbol, depth));
      shown += 1;
      walk(symbol.children, depth + 1);
    }
  };
  walk(symbols, 0);

  const header = `Скелет ${file}: ${declarations(total)}${size}`;
  const tail = cut
    ? `\n… показано ${shown} из ${total} — сузь задачу или смотри файл через search.`
    : `\nТела не показаны: нужные строки читай диапазоном (read_file с startLine и endLine).`;

  return {
    summary: `${name}: ${declarations(total)}`,
    detail: [header, ...out, tail].join('\n'),
    total,
    lines: out.length,
  };
}

/** Имя файла без пути: скелет адресуется файлом, а путь целиком длинный. */
function baseName(target: string): string {
  const index = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
  return index < 0 ? target : target.slice(index + 1);
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
