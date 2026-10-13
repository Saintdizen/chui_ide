/**
 * Разбор ответа `textDocument/linkedEditingRange`: участки текста, которые надо править
 * вместе.
 *
 * Смысл запроса виден на парных тегах HTML/XML: открывающий и закрывающий тег носят одно
 * имя, и, меняя его в одном месте, ждёшь, что поменяется и в другом. Сервер отвечает
 * списком диапазонов, которые стоит держать синхронными; первый из них обычно тот, где
 * стоит каретка. Кроме диапазонов сервер может прислать `wordPattern` — образ слова
 * участка; нам он не нужен: мы просто повторяем правку, что бы в ней ни было набрано.
 *
 * Модуль чистый: ни сети, ни DOM. Диапазоны переводим в 1-based — так их видит редактор
 * (см. `SquigglyDecoration`, `LinkDecoration`), а второй перевод в другом месте развёл бы их.
 */

/** Участок, связанный с другими: строка и столбцы (1-based), как их видит редактор. */
export interface LinkedRange {
  /** Строка (1-based). */
  readonly line: number;
  /** Столбец начала (1-based, включительно). */
  readonly startColumn: number;
  /** Столбец конца (1-based, исключительно). */
  readonly endColumn: number;
}

/**
 * Связанные участки из ответа сервера. Битые и одно-участковые записи пропускаем: связь
 * нужна минимум из двух мест, иначе синхронизировать не с чем. Многострочные диапазоны
 * не берём — имена тегов однострочны, а наш слой подсветки рисует участок в строке.
 */
export function toLinkedRanges(raw: unknown): LinkedRange[] {
  if (!raw || typeof raw !== 'object') return [];
  const ranges = (raw as { ranges?: unknown }).ranges;
  if (!Array.isArray(ranges)) return [];

  const merged = new Map<string, LinkedRange>();
  for (const item of ranges) {
    const range = toRange(item);
    if (!range) continue;
    merged.set(`${range.line}:${range.startColumn}:${range.endColumn}`, range);
  }
  const list = [...merged.values()];
  return list.length >= 2 ? list : [];
}

function toRange(raw: unknown): LinkedRange | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as {
    start?: { line?: unknown; character?: unknown };
    end?: { line?: unknown; character?: unknown };
  };
  const start = value.start;
  const end = value.end;
  if (typeof start?.line !== 'number' || typeof start.character !== 'number') return null;
  if (typeof end?.line !== 'number' || typeof end.character !== 'number') return null;
  // Перенос строки внутри участка не поддерживаем: подсветка рисует его в одной строке.
  if (end.line !== start.line) return null;
  const startColumn = start.character + 1;
  const endColumn = end.character + 1;
  if (endColumn <= startColumn) return null;
  return { line: start.line + 1, startColumn, endColumn };
}
