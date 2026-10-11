/**
 * Правки от языкового сервера (переименование): разбор `WorkspaceEdit`.
 *
 * Сервер отвечает на `textDocument/rename` одним из двух видов: `changes` (карта
 * uri → правки) или `documentChanges` (список документов с правками; изредка там
 * же — операции с файлами). Оба сводим к нашей форме `FileEdit[]`, которую умеет
 * применять документная модель renderer: так правка от сервера идёт тем же путём,
 * что и `apply_edit`, — с undo и ревью.
 *
 * Модуль чистый: про `file://` не знает, путь из ссылки делает main (у него есть
 * утилиты Node), сюда его передают функцией. Поэтому проверяется без Electron.
 */

import type { FileEdit, TextEdit } from './edits';

/** Правки, сгруппированные по файлам, — форма `apply_edit`. */
export function toWorkspaceFileEdits(raw: unknown, toPath: (uri: string) => string): FileEdit[] | null {
  if (!raw || typeof raw !== 'object') return null;

  const byPath = new Map<string, TextEdit[]>();
  const add = (uri: unknown, items: unknown): void => {
    if (typeof uri !== 'string' || !Array.isArray(items)) return;
    const path = safePath(uri, toPath);
    if (!path) return;
    const target = byPath.get(path) ?? [];
    for (const item of items) {
      const edit = toTextEdit(item);
      if (edit) target.push(edit);
    }
    if (target.length > 0) byPath.set(path, target);
  };

  // `changes`: карта uri → список правок.
  const changes = (raw as { changes?: unknown }).changes;
  if (changes && typeof changes === 'object') {
    for (const [uri, items] of Object.entries(changes as Record<string, unknown>)) add(uri, items);
  }

  // `documentChanges`: список документов; операции с файлами (create/rename/delete)
  // пропускаем — переименование символа их не порождает, а обрабатывать их здесь
  // значило бы тащить в инструмент работу с файловой системой.
  const documentChanges = (raw as { documentChanges?: unknown }).documentChanges;
  if (Array.isArray(documentChanges)) {
    for (const change of documentChanges) {
      const value = change as { textDocument?: { uri?: unknown }; edits?: unknown };
      add(value.textDocument?.uri, value.edits);
    }
  }

  // Не WorkspaceEdit вовсе (пусто/чужая форма) — `null` вместо пустого списка:
  // агенту это разные подсказки (см. `rename_symbol`).
  if (byPath.size === 0) return null;

  return [...byPath.entries()]
    .map(([path, edits]) => ({ path, edits: sortEdits(edits) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Правки внутри файла — по позиции: порядок применения задаёт документ, но список стабилен. */
function sortEdits(edits: TextEdit[]): TextEdit[] {
  return [...edits].sort(
    (a, b) =>
      a.startLine - b.startLine || a.startColumn - b.startColumn || a.endLine - b.endLine || a.endColumn - b.endColumn,
  );
}

/** Одна правка LSP (`range` + `newText`) → наша форма (позиции 1-based). */
function toTextEdit(raw: unknown): TextEdit | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { range?: unknown; newText?: unknown };
  if (typeof value.newText !== 'string') return null;

  const range = value.range as {
    start?: { line?: unknown; character?: unknown };
    end?: { line?: unknown; character?: unknown };
  };
  const start = position(range?.start);
  if (!start) return null;
  // Конец без начала бессмыслен, а вот начало без конца — просто вставка: тогда
  // правка пустая, и её конец совпадает с началом.
  const end = position(range?.end) ?? start;

  return {
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
    newText: value.newText,
  };
}

/** Позиция LSP (0-based) → 1-based; нет поля или мусор — null. */
function position(raw: { line?: unknown; character?: unknown } | undefined): { line: number; column: number } | null {
  if (!raw || typeof raw.line !== 'number') return null;
  return { line: raw.line + 1, column: typeof raw.character === 'number' ? raw.character + 1 : 1 };
}

function safePath(uri: string, toPath: (uri: string) => string): string | null {
  try {
    return toPath(uri) || null;
  } catch {
    return null;
  }
}
