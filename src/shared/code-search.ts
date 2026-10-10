/**
 * Поиск по коду: сопоставление запроса с символами проекта и с текстовыми
 * совпадениями.
 *
 * Отличие от `search` (обычный текстовый поиск) в том, что здесь запрос сначала
 * примеряется к **именам символов** — так находится место объявления, а не каждое
 * упоминание: «где определён `readFile`» вместо «все строки со словом readFile».
 * Имена символов приходят от языкового сервера (`workspace/symbol`), поэтому
 * разбор и ранжирование — чистые правила без I/O: их проверяют тестом.
 */

/** Совпадение имени с запросом. Меньше — точнее; `null` — имя не подходит. */
export const RANK_EXACT = 0;
export const RANK_PREFIX = 1;
export const RANK_WORDS = 2;
export const RANK_WORD_PREFIX = 3;
export const RANK_CONTAINS = 4;

/**
 * Разбить имя или запрос на слова: `readFile` → `read`, `file`; `HTTPServer` →
 * `http`, `server`. Без этого запрос «read file» не нашёл бы `readFile`, а
 * «http server» — `HTTPServer`: люди и модели пишут имя словами, а не как в коде.
 */
export function splitWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9\u0400-\u04FF]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * Насколько имя подходит под запрос. Проверки идут от точной к слабой: сперва
 * полное совпадение, потом начало имени, потом совпадение по словам, и лишь
 * затем вхождение подстроки — иначе `readFileContent` перебило бы `readFile`.
 */
export function rankSymbolName(name: string, query: string): number | null {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return null;

  const lower = name.toLowerCase();
  if (lower === trimmed) return RANK_EXACT;
  if (lower.startsWith(trimmed)) return RANK_PREFIX;

  const terms = trimmed.split(/\s+/).filter(Boolean);
  if (terms.length > 0) {
    const words = splitWords(name);
    if (terms.every((term) => words.some((word) => word === term))) return RANK_WORDS;
    if (terms.every((term) => words.some((word) => word.startsWith(term)))) return RANK_WORD_PREFIX;
  }

  // «read file» без пробелов — тот же `readFile`; сравнение по «спрессованному» имени.
  const compact = trimmed.replace(/\s+/g, '');
  if (compact.length > 0 && lower.includes(compact)) return RANK_CONTAINS;
  return null;
}

/** Символ в той форме, в какой его видит этот модуль. Совпадает с `ProjectSymbol`. */
export interface SearchSymbol {
  name: string;
  kind: string;
  container: string | null;
  path: string;
  line: number;
  column: number;
}

/**
 * Отобрать и упорядочить символы по запросу. Порядок: точность совпадения имени,
 * затем короткое имя (обычно более общее), затем путь и строка — так ответ не
 * переставляется от вызова к вызову.
 */
export function rankSymbols(symbols: readonly SearchSymbol[], query: string, limit: number): SearchSymbol[] {
  const scored: Array<{ rank: number; symbol: SearchSymbol }> = [];
  for (const symbol of symbols) {
    const rank = rankSymbolName(symbol.name, query);
    if (rank !== null) scored.push({ rank, symbol });
  }

  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.symbol.name.length - b.symbol.name.length ||
      a.symbol.path.localeCompare(b.symbol.path) ||
      a.symbol.line - b.symbol.line,
  );

  return scored.slice(0, Math.max(0, limit)).map((item) => item.symbol);
}

/** Текстовые совпадения, сведённые по файлу: сколько и где первое. */
export interface FileDigest {
  /** Путь как его показать (обычно относительный). */
  path: string;
  /** Сколько совпадений в файле. */
  count: number;
  /** Строка первого совпадения. */
  line: number;
  /** Текст первой совпавшей строки — по нему видно, то ли это место. */
  first: string;
}

/**
 * Свернуть построчные совпадения по файлам: у крупных запросов в одном файле
 * десятки строк, и модели полезнее знать «в файле их 12, первое на строке 336»,
 * чем получить те же 12 строк текста.
 */
export function digestHits(
  hits: ReadonlyArray<{ path: string; line: number; text: string }>,
  limit: number,
): FileDigest[] {
  const byPath = new Map<string, FileDigest>();
  for (const hit of hits) {
    const existing = byPath.get(hit.path);
    if (existing) {
      existing.count += 1;
      if (hit.line < existing.line) {
        existing.line = hit.line;
        existing.first = hit.text.trim();
      }
      continue;
    }
    byPath.set(hit.path, { path: hit.path, count: 1, line: hit.line, first: hit.text.trim() });
  }

  return [...byPath.values()]
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, Math.max(0, limit));
}

export interface CodeSearchResult {
  query: string;
  symbols: readonly SearchSymbol[];
  /** Сколько символов нашёл сервер до отбора по запросу и обрезки. */
  symbolTotal: number;
  files: readonly FileDigest[];
  /** Всего текстовых совпадений до свёртки по файлам. */
  hitTotal: number;
  scanned: number;
  truncated: boolean;
  /** Работает ли языковой сервер: без него ищем только текстом. */
  symbolsAvailable: boolean;
}

/** Строка символа: путь, строка, вид и имя — по ней сразу видно место объявления. */
export function formatSymbol(symbol: SearchSymbol): string {
  const where = symbol.container ? ` (в ${symbol.container})` : '';
  return `${symbol.path}:${symbol.line} — ${symbol.kind} ${symbol.name}${where}`;
}

/** Строка файла: сколько совпадений и где первое. */
export function formatFileDigest(file: FileDigest): string {
  const times = file.count === 1 ? '1 совпадение' : `совпадений: ${file.count}`;
  return `${file.path} — ${times}, первое на строке ${file.line}: ${file.first.slice(0, 120)}`;
}

/**
 * Ответ инструмента: две части — где объявлено и где встречается. Если символов
 * не нашлось, честно говорим об этом: иначе модель решит, что в проекте нет
 * такого имени, хотя символ мог быть лишь упомянут в тексте.
 */
export function formatCodeSearch(result: CodeSearchResult): { summary: string; detail: string } {
  const { symbols, files } = result;
  const parts: string[] = [];

  if (symbols.length > 0) {
    parts.push('Где объявлено:', ...symbols.map(formatSymbol));
  } else if (result.symbolsAvailable) {
    parts.push('Объявлений с таким именем не нашлось.');
  } else {
    parts.push('Языковой сервер не подключён: искал только по тексту.');
  }

  if (files.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push('Где встречается:', ...files.map(formatFileDigest));
  }

  if (result.truncated) parts.push('', 'Список обрезан — уточните запрос или сузьте папку.');

  const summary =
    symbols.length === 0 && files.length === 0
      ? `«${result.query}»: ничего не найдено`
      : `«${result.query}»: объявлений ${symbols.length}, файлов с совпадениями ${files.length}`;

  return { summary, detail: parts.join('\n') };
}
