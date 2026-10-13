/**
 * Разбор ответа `textDocument/documentLink`: кликабельные ссылки внутри кода.
 *
 * Сервер помечает участки текста, по которым можно перейти: путь к файлу в `import`
 * или `require`, адрес в комментарии, ссылка на схему в JSON. Отдаёт он `range`
 * (участок в нумерации LSP, с нуля) и `target` — адрес, куда вести. Часть серверов
 * объявляет `resolveProvider` и в первом ответе `target` НЕ присылает: его надо
 * добыть отдельным запросом `documentLink/resolve` (тем же элементом назад) —
 * поэтому `source` сохраняем, как и в подсказках.
 *
 * Модуль чистый: ни сети, ни DOM. Диапазоны переводим в 1-based — так их видит
 * редактор (см. `SquigglyDecoration`), а второй перевод в другом месте развёл бы их.
 */

/** Ссылка в тексте: участок, куда ведёт, и подпись для наведения. */
export interface DocumentLinkEntry {
  /** Строка (1-based). */
  readonly line: number;
  /** Столбец начала (1-based, включительно). */
  readonly startColumn: number;
  /** Столбец конца (1-based, исключительно). */
  readonly endColumn: number;
  /** Куда ведёт ссылка. Пусто — сервер отдаст адрес только в `resolve`. */
  readonly target?: string;
  /** Подпись при наведении. */
  readonly tooltip?: string;
  /** Исходный элемент сервера: нужен для `documentLink/resolve`. */
  readonly source?: unknown;
}

/**
 * Ссылки из ответа сервера. Битые записи пропускаем: без диапазона ссылку не нарисовать,
 * а участок нулевой длины некуда нажимать.
 */
export function toDocumentLinks(raw: unknown): DocumentLinkEntry[] {
  if (!Array.isArray(raw)) return [];
  const links: DocumentLinkEntry[] = [];
  for (const item of raw) {
    const link = toLink(item);
    if (link) links.push(link);
  }
  return links;
}

function toLink(raw: unknown): DocumentLinkEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as {
    range?: { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } };
    target?: unknown;
    tooltip?: unknown;
  };
  const start = value.range?.start;
  const end = value.range?.end;
  if (typeof start?.line !== 'number' || typeof start.character !== 'number') return null;
  if (typeof end?.line !== 'number' || typeof end.character !== 'number') return null;
  // Многострочных ссылок не бывает (документация LSP их не допускает): берём первую строку.
  const startColumn = start.character + 1;
  const endColumn = (end.line === start.line ? end.character : start.character) + 1;
  if (endColumn <= startColumn) return null;

  return {
    line: start.line + 1,
    startColumn,
    endColumn,
    ...(typeof value.target === 'string' && value.target ? { target: value.target } : {}),
    ...(typeof value.tooltip === 'string' && value.tooltip ? { tooltip: value.tooltip } : {}),
    source: raw,
  };
}

/**
 * Адрес из ответа `documentLink/resolve`: поле `target`. Пусто — сервер адреса не дал,
 * и ссылку показывать нечем (подчёркивать некуда ведущий участок незачем).
 */
export function targetFromResolvedLink(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const target = (raw as { target?: unknown }).target;
  return typeof target === 'string' && target ? target : null;
}
