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

import { matchScore } from './fuzzy';

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
  /**
   * Откуда объявление — из проекта или из установленной зависимости. Не задано —
   * проект: так отвечает сервер, и так же выглядит всё, что было до карты.
   */
  origin?: 'project' | 'dependency';
  /** Пакет, из которого символ (`requests`, `express`). Не задано — код проекта. */
  package?: string | null;
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

/**
 * Что показывает панель структуры. Различать важно: `null` от сервера — это «взять
 * структуру неоткуда» (нет сервера для языка), а пустой список — «сервер ответил,
 * объявлений в файле нет». Сливать их в одно значило бы врать про причину.
 */
export type OutlineState = 'unavailable' | 'empty' | 'ready';

/** Состояние панели структуры по ответу сервера и разобранным символам. */
export function outlineState(raw: unknown, symbols: readonly FileSymbol[]): OutlineState {
  // `null` — прокси вернул «сервера нет»; `undefined` — та же беда, если ответ не пришёл.
  if (raw === null || raw === undefined) return 'unavailable';
  return countFileSymbols(symbols) > 0 ? 'ready' : 'empty';
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
function outlineLine(symbol: FileSymbol, depth: number, hidden = 0): string {
  const where = symbol.endLine > symbol.line ? `${symbol.line}–${symbol.endLine}` : String(symbol.line);
  // Свёрнутые ветки называем на строке родителя, а не отдельной строкой: так
  // модель знает, что глубже есть ещё, и одной строкой меньше платит за это.
  const rest = hidden > 0 ? ` · вложенных: ${hidden}` : '';
  return `${'  '.repeat(depth)}${where}: ${symbol.kind} ${symbol.name}${rest}`;
}

/**
 * Путь к символу от внешнего к внутреннему — крошки над редактором. Ищется самый
 * ГЛУБОКИЙ символ, накрывающий строку: в классе `A` метод `b` — две крошки, а не одна.
 *
 * Границы включающие: курсор на строке закрывающей скобки остаётся внутри символа —
 * так ведёт себя любой редактор, и иначе крошки мигали бы на границе. Символ без
 * конца (сервер не сообщил) занимает только свою строку: растягивать его на весь
 * оставшийся файл значило бы врать про вложенность.
 */
export function symbolPathAt(symbols: readonly FileSymbol[], line: number): FileSymbol[] {
  const path: FileSymbol[] = [];
  let level = symbols;
  for (;;) {
    const hit = level.find(
      (symbol) => symbol.line <= line && line <= (symbol.endLine > symbol.line ? symbol.endLine : symbol.line),
    );
    if (!hit) return path;
    path.push(hit);
    level = hit.children;
  }
}

/**
 * Сплющить дерево символов файла в плоский список для палитры. `container` —
 * хлебная тропа предков через ` › ` (`Класс › Метод`), чтобы видеть вложенность,
 * не раскрывая дерево. Колонка — 1: `FileSymbol` её не несёт, а переход идёт по строке.
 */
export function flattenFileSymbols(symbols: readonly FileSymbol[], path: string): ProjectSymbol[] {
  const out: ProjectSymbol[] = [];
  const walk = (level: readonly FileSymbol[], trail: string): void => {
    for (const symbol of level) {
      out.push({
        name: symbol.name,
        kind: symbol.kind,
        container: trail || null,
        path,
        line: symbol.line,
        column: 1,
      });
      if (symbol.children.length > 0) walk(symbol.children, trail ? `${trail} › ${symbol.name}` : symbol.name);
    }
  };
  walk(symbols, '');
  return out;
}

/** Предел строк вывода: скелет огромного файла не должен вытеснить беседу. */
const MAX_OUTLINE_LINES = 200;

/**
 * На сколько уровней вглубь печатаем объявления. Два — это «класс и его методы»:
 * глубже идут замыкания и вложенные классы, которые агенту без нужды. На файле
 * на 3 000 строк скелет без предела выдавал 200 строк по 30 символов совсем не
 * тех объявлений — дешевле назвать число вложенных и дать диапазон.
 */
const MAX_OUTLINE_DEPTH = 2;

/**
 * Скелет файла — то, чем агент узнаёт устройство файла, не читая его целиком:
 * объявления с номерами строк, без тел. Номера сразу годятся для `read`
 * с диапазоном, а строки кода агент запросит уже точечно.
 */
export function formatOutline(
  file: string,
  symbols: readonly FileSymbol[],
  options: { maxLines?: number; totalLines?: number; maxDepth?: number } = {},
): { summary: string; detail: string; total: number; lines: number } {
  const total = countFileSymbols(symbols);
  const name = baseName(file);
  const size = options.totalLines !== undefined ? ` из ${options.totalLines} строк` : '';

  if (total === 0) {
    return {
      summary: `${name}: объявлений нет`,
      detail:
        `Объявлений в ${file} не нашлось: файл без символов, не тот язык или языковой сервер ` +
        'его не разобрал. Смотри содержимое через search или read.',
      total: 0,
      lines: 0,
    };
  }

  const limit = options.maxLines ?? MAX_OUTLINE_LINES;
  const maxDepth = options.maxDepth ?? MAX_OUTLINE_DEPTH;
  const out: string[] = [];
  let shown = 0;
  let cut = false;

  const walk = (items: readonly FileSymbol[], depth: number): void => {
    for (const symbol of items) {
      if (out.length >= limit) {
        cut = true;
        return;
      }
      // Ветка глубже предела — вложенные не печатаем, а называем числом: так
      // видно, что там что-то есть, и видно, откуда его взять (диапазон строк).
      const deeper = depth + 1 >= maxDepth ? countFileSymbols(symbol.children) : 0;
      out.push(outlineLine(symbol, depth, deeper));
      shown += 1;
      if (deeper > 0) continue;
      walk(symbol.children, depth + 1);
    }
  };
  walk(symbols, 0);

  const header = `Скелет ${file}: ${declarations(total)}${size}`;
  const tail = cut
    ? `\n… показано ${shown} из ${total} — сузь задачу или смотри файл через search.`
    : `\nТела не показаны: нужные строки читай диапазоном (read с startLine и endLine).`;

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
 * Склеить два источника объявлений: ответ сервера и карту символов проекта.
 *
 * Первый важнее: сервер отвечает с учётом типов и точными позициями, и там, где он
 * ответил, спорить не с чем. Второй добавляет то, чего в ответе нет — и именно он
 * отвечает, когда сервера нет вовсе. Повторы (один символ из обоих источников)
 * отбрасываются: в списке он один.
 */
export function mergeSymbols(primary: readonly ProjectSymbol[], extra: readonly ProjectSymbol[]): ProjectSymbol[] {
  const seen = new Set(primary.map(symbolKey));
  const merged = [...primary];
  for (const symbol of extra) {
    const key = symbolKey(symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(symbol);
  }
  return merged;
}

/** По чему видно, что это тот же символ: имя, файл и строка. */
function symbolKey(symbol: ProjectSymbol): string {
  return `${symbol.name}|${symbol.path}|${symbol.line}`;
}

/**
 * Оставить символы, подходящие под запрос, и убрать лишние повторы.
 *
 * Поиск НЕЧЁТКИЙ: тот же `matchScore`, что у подсказок (`shared/fuzzy.ts`) — можно
 * набирать «горбы» (`gT` → `getTitle`). Совпавшие сортируем по оценке (лучший —
 * первым), повторы убираем: один символ приходит и как объявление, и как реализация.
 */
export function filterSymbols(symbols: readonly ProjectSymbol[], query: string, limit = 50): ProjectSymbol[] {
  const needle = query.trim();
  const seen = new Set<string>();
  const scored: { symbol: ProjectSymbol; score: number }[] = [];

  for (const symbol of symbols) {
    let score = 0;
    if (needle) {
      const match = matchScore(symbol.name, needle);
      if (!match) continue;
      score = match.score;
    }
    const key = `${symbol.name}|${symbol.path}|${symbol.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push({ symbol, score });
  }

  // Устойчивая сортировка: без запроса (все score=0) порядок сервера сохраняется.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((entry) => entry.symbol);
}
