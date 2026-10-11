/**
 * Локации LSP: определение и ссылки.
 *
 * Языковой сервер отвечает на `textDocument/definition` и `textDocument/references`
 * одним из двух видов: `Location` (`uri` + `range`) или его массивом. Здесь
 * приводим их к общей форме и собираем отчёт — правила, а не I/O, поэтому модуль
 * чистый и проверяется без Electron.
 *
 * Про `file://` он не знает: превращение ссылки в путь делает main (у него есть
 * утилиты Node), сюда его передают функцией — так разбор остаётся чистым.
 */

/** Место в коде: путь и позиция. Строка и столбец — 1-based, как их показывает IDE. */
export interface SymbolLocation {
  path: string;
  line: number;
  column: number;
}

/** Локации из ответа сервера. `toPath` превращает ссылку в путь; битые пропускаем. */
export function toLocations(raw: unknown, toPath: (uri: string) => string): SymbolLocation[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];

  const locations: SymbolLocation[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const value = item as { uri?: unknown; targetUri?: unknown; range?: unknown; targetSelectionRange?: unknown };
    // `LocationLink` (переход) вместо `Location`: путь и диапазон лежат в target*.
    const uri = value.uri ?? value.targetUri;
    const range = value.range ?? value.targetSelectionRange;
    if (typeof uri !== 'string') continue;

    const path = safePath(uri, toPath);
    const start = startOf(range);
    if (!path || !start) continue;
    locations.push({ path, line: start.line, column: start.column });
  }
  return locations;
}

/** Начало диапазона в 1-based виде; нет диапазона или он битый — null. */
function startOf(range: unknown): { line: number; column: number } | null {
  if (!range || typeof range !== 'object') return null;
  const start = (range as { start?: { line?: unknown; character?: unknown } }).start;
  if (typeof start?.line !== 'number') return null;
  return {
    line: start.line + 1,
    column: typeof start.character === 'number' ? start.character + 1 : 1,
  };
}

function safePath(uri: string, toPath: (uri: string) => string): string | null {
  try {
    return toPath(uri) || null;
  } catch {
    return null;
  }
}

/** Сколько мест показываем: дальше список вытеснит беседу, а не поможет. */
const MAX_LOCATIONS = 100;

/** Убрать повторы (сервер может вернуть одно место дважды) и упорядочить по файлу и позиции. */
export function uniqueLocations(locations: readonly SymbolLocation[]): SymbolLocation[] {
  const seen = new Set<string>();
  const result: SymbolLocation[] = [];
  for (const location of locations) {
    const key = `${location.path}:${location.line}:${location.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(location);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
}

/**
 * Отчёт по локациям: короткая строка для карточки и список для модели.
 * Пути отдаём относительными — агенту они ближе и короче абсолютных.
 * `subject` — о чём речь («определение X», «ссылки на X»).
 */
export function formatLocations(
  subject: string,
  locations: readonly SymbolLocation[],
  toRelative: (path: string) => string,
): { summary: string; detail: string } {
  const unique = uniqueLocations(locations);
  if (unique.length === 0) {
    return {
      summary: `${subject}: ничего не найдено`,
      detail: `Языковой сервер не нашёл мест для: ${subject}. Возможно, символ переопределён динамически или сервер его не видит.`,
    };
  }

  const files = new Set(unique.map((location) => location.path));
  const shown = unique.slice(0, MAX_LOCATIONS);
  const lines = shown.map((location) => `${toRelative(location.path)}:${location.line}:${location.column}`);
  if (unique.length > shown.length) lines.push(`… ещё мест: ${unique.length - shown.length}`);

  return {
    summary: `${subject}: мест ${unique.length} в ${files.size} ${inFiles(files.size)}`,
    detail: lines.join('\n'),
  };
}

/** «в 1 файле», «в 2 файлах» — предложный падеж, он же нужен в подписи отчёта. */
function inFiles(count: number): string {
  return count % 10 === 1 && count % 100 !== 11 ? 'файле' : 'файлах';
}
