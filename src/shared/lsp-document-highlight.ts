/**
 * Разбор ответа `textDocument/documentHighlight`: где в файле ещё встречается символ.
 *
 * Зачем это нужно, если своя подсветка вхождений уже есть (`view/context-highlight.ts`):
 * своя ищет слово ЦЕЛИКОМ ПО ТЕКСТУ и потому подсвечивает одноимённые поля разных
 * классов, параметр из другой функции и ключ объекта — всё, где совпало написание.
 * Сервер знает области видимости и типы, поэтому отличает `this.value` в соседнем
 * методе от локального `value`.
 *
 * Разбор чистый: ни сети, ни DOM. Поэтому виден в тестах и удобен там же, где
 * остальные `shared/lsp-*.ts`.
 */

/**
 * Что нашлось: место и КАК оно относится к символу под курсором.
 *
 * Написание — от сервера (LSP: 1 — текст, 2 — чтение, 3 — запись). Это единственное,
 * что даёт сервер и не даёт текстовый поиск: видно, где переменная меняется,
 * а не только где упоминается — как `kind` в семантической подсветке, только про место.
 */
export type HighlightKind = 'text' | 'read' | 'write';

export interface DocumentHighlightSpan {
  /** Строка с единицы (как у нас везде: `FileSymbol.line` тоже 1-based). */
  readonly line: number;
  /** Столбец начала с единицы. */
  readonly column: number;
  /** Столбец конца с единицы (исключающий — как `character` в LSP). */
  readonly endColumn: number;
  /** Длина в знаках UTF-16 (так считает буфер), не меньше 1. */
  readonly length: number;
  readonly kind: HighlightKind;
}

const KIND_BY_CODE: Readonly<Record<number, HighlightKind>> = { 1: 'text', 2: 'read', 3: 'write' };

/**
 * Подсветки из ответа сервера. Битые записи и пустые диапазоны пропускаем:
 * нулевая длина не рисуется и только шумит в списке.
 *
 * Код `kind` по LSP: 1 — Text, 2 — Read, 3 — Write. Неизвестный или отсутствующий
 * код — `text`: так подсветка просто не выделяет запись среди чтений, но показывает место.
 */
export function toDocumentHighlights(raw: unknown): DocumentHighlightSpan[] {
  if (!Array.isArray(raw)) return [];
  const spans: DocumentHighlightSpan[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as { range?: unknown; kind?: unknown };
    const range = value.range as
      | { start?: { line?: unknown; character?: unknown }; end?: { character?: unknown } }
      | undefined;
    const startLine = range?.start?.line;
    const startChar = range?.start?.character;
    const endChar = range?.end?.character;
    if (typeof startLine !== 'number' || typeof startChar !== 'number' || typeof endChar !== 'number') continue;
    // Сервер отдаёт 0-based; у нас везде 1-based — переводим на границе, дальше забыли.
    const column = startChar + 1;
    const length = endChar - startChar;
    if (!Number.isFinite(column) || !Number.isFinite(length) || length < 1) continue;
    const code = typeof value.kind === 'number' ? value.kind : 1;
    spans.push({
      line: startLine + 1,
      column,
      endColumn: endChar + 1,
      length,
      kind: KIND_BY_CODE[code] ?? 'text',
    });
  }
  return spans;
}
