/**
 * Форматирование от языкового сервера: разбор правок `formatting`/`rangeFormatting`.
 *
 * Форматировать наша IDE умеет и без сервера — целым файлом, инструментом проекта
 * (ruff, black, prettier, biome). Но у этого пути есть предел: инструмент форматирует
 * ВЕСЬ файл, а бывает нужно привести в порядок только выделение — или только что
 * вставленный кусок, не трогая остального. Это умеет сервер: `textDocument/rangeFormatting`
 * отдаёт правки для указанного участка.
 *
 * Ответ у обоих запросов один — список правок (`TextEdit[]`), и разбор общий. Позиции
 * LSP нулевые, наши — с единицы: перевод делается здесь и в одном месте, поэтому
 * вызывающий получает привычную форму.
 *
 * Модуль чистый: он не знает ни о сервере, ни о документе.
 */

import type { TextEdit } from './edits';

/**
 * Правки из ответа сервера. Пустой ответ — сервер отформатировал бы в то же самое
 * или не умеет: и то, и другое для вызывающего одно — менять нечего.
 *
 * Битые записи пропускаем молча: ответ сервера — не наш формат, и падать из-за одной
 * кривой записи, когда рядом лежат годные, было бы хуже всего.
 */
export function toFormatEdits(raw: unknown): TextEdit[] {
  if (!Array.isArray(raw)) return [];

  const edits: TextEdit[] = [];
  for (const entry of raw) {
    const edit = toFormatEdit(entry);
    if (edit) edits.push(edit);
  }
  return edits;
}

function toFormatEdit(raw: unknown): TextEdit | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { range?: unknown; newText?: unknown; insertTextFormat?: unknown };
  if (typeof value.newText !== 'string') return null;

  const range = value.range as
    | { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } }
    | undefined;
  const startLine = lineNumber(range?.start?.line);
  const startColumn = lineNumber(range?.start?.character);
  const endLine = lineNumber(range?.end?.line);
  const endColumn = lineNumber(range?.end?.character);
  if (startLine === null || startColumn === null || endLine === null || endColumn === null) return null;

  const edit: TextEdit = {
    startLine: startLine + 1,
    startColumn: startColumn + 1,
    endLine: endLine + 1,
    endColumn: endColumn + 1,
    newText: value.newText,
  };
  return edit;
}

/** Целый номер строки/столбца из ответа (0-based); мусор — `null`, а не ноль. */
function lineNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

/**
 * Знает ли сервер, какие знаки запускают форматирование на вводе. Список приходит из
 * его возможностей (`documentOnTypeFormattingProvider.triggerCharacters`) — это часть
 * ОТВЕТА сервера, поэтому разбор живёт рядом с разбором правок.
 */
export function onTypeTriggers(capabilities: unknown): string[] {
  if (!capabilities || typeof capabilities !== 'object') return [];
  const provider = (capabilities as { documentOnTypeFormattingProvider?: unknown }).documentOnTypeFormattingProvider;
  if (!provider || typeof provider !== 'object') return [];
  const chars = (provider as { triggerCharacters?: unknown }).triggerCharacters;
  if (!Array.isArray(chars)) return [];
  return chars.filter((char): char is string => typeof char === 'string' && char.length > 0);
}
