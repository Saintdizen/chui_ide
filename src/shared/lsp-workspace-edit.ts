/**
 * Правки от языкового сервера: разбор `WorkspaceEdit`.
 *
 * Сервер отвечает на `textDocument/rename` (и на другие правящие действия) одним из двух
 * видов: `changes` (карта uri → правки) или `documentChanges` (список документов с правками;
 * там же бывают ОПЕРАЦИИ С ФАЙЛАМИ — создать, переименовать, удалить). Правки содержимого
 * сводим к нашей форме `FileEdit[]`, которую умеет применять документная модель renderer;
 * файловые операции отдаём отдельным списком — их применяет приложение (у него файловая
 * система). Порядок операций сохраняем: сервер выстраивает их не случайно.
 *
 * Модуль чистый: про `file://` не знает, путь из ссылки делает main (у него есть утилиты
 * Node), сюда его передают функцией. Поэтому проверяется без Electron.
 */

import type { FileEdit, TextEdit } from './edits';

/** Создать файл. `overwrite` — перетирать существующий, `ignoreIfExists` — молча пропустить. */
export interface CreateFileOperation {
  readonly kind: 'create';
  readonly path: string;
  readonly overwrite: boolean;
  readonly ignoreIfExists: boolean;
}

/** Переименовать/переместить файл. */
export interface RenameFileOperation {
  readonly kind: 'rename';
  readonly from: string;
  readonly to: string;
  readonly overwrite: boolean;
  readonly ignoreIfExists: boolean;
}

/** Удалить файл. `recursive` — вместе с папкой, `ignoreIfNotExists` — молча пропустить. */
export interface DeleteFileOperation {
  readonly kind: 'delete';
  readonly path: string;
  readonly recursive: boolean;
  readonly ignoreIfNotExists: boolean;
}

export type FileOperation = CreateFileOperation | RenameFileOperation | DeleteFileOperation;

/** Полный разбор `WorkspaceEdit`: правки содержимого и операции с файлами. */
export interface WorkspaceEdits {
  readonly files: FileEdit[];
  readonly operations: FileOperation[];
}

/** Правки, сгруппированные по файлам, — форма `apply_edit`. `null` — правок нет. */
export function toWorkspaceFileEdits(raw: unknown, toPath: (uri: string) => string): FileEdit[] | null {
  const parsed = parse(raw, toPath);
  if (!parsed || parsed.files.length === 0) return null;
  return parsed.files;
}

/**
 * Разобрать всё: и правки, и операции с файлами. `null` — не WorkspaceEdit вовсе
 * (пусто/чужая форма): это разные подсказки вызывающему, а не «ничего не делать».
 */
export function toWorkspaceEdits(raw: unknown, toPath: (uri: string) => string): WorkspaceEdits | null {
  return parse(raw, toPath);
}

function parse(raw: unknown, toPath: (uri: string) => string): WorkspaceEdits | null {
  if (!raw || typeof raw !== 'object') return null;

  const byPath = new Map<string, TextEdit[]>();
  const operations: FileOperation[] = [];
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

  // `documentChanges`: документы с правками и операции с файлами — вперемешку, по порядку.
  const documentChanges = (raw as { documentChanges?: unknown }).documentChanges;
  if (Array.isArray(documentChanges)) {
    for (const change of documentChanges) {
      const operation = toFileOperation(change, toPath);
      if (operation) {
        operations.push(operation);
        continue;
      }
      const value = change as { textDocument?: { uri?: unknown }; edits?: unknown };
      add(value.textDocument?.uri, value.edits);
    }
  }

  if (byPath.size === 0 && operations.length === 0) return null;

  const files = [...byPath.entries()]
    .map(([path, edits]) => ({ path, edits: sortEdits(edits) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { files, operations };
}

/** Операция с файлом из элемента `documentChanges`. Не операция — `null`. */
function toFileOperation(raw: unknown, toPath: (uri: string) => string): FileOperation | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as {
    kind?: unknown;
    uri?: unknown;
    oldUri?: unknown;
    newUri?: unknown;
    options?: { overwrite?: unknown; ignoreIfExists?: unknown; recursive?: unknown; ignoreIfNotExists?: unknown };
  };
  const options = value.options ?? {};

  if (value.kind === 'create') {
    const path = typeof value.uri === 'string' ? safePath(value.uri, toPath) : null;
    if (!path) return null;
    return {
      kind: 'create',
      path,
      overwrite: options.overwrite === true,
      ignoreIfExists: options.ignoreIfExists === true,
    };
  }
  if (value.kind === 'rename') {
    const from = typeof value.oldUri === 'string' ? safePath(value.oldUri, toPath) : null;
    const to = typeof value.newUri === 'string' ? safePath(value.newUri, toPath) : null;
    if (!from || !to) return null;
    return {
      kind: 'rename',
      from,
      to,
      overwrite: options.overwrite === true,
      ignoreIfExists: options.ignoreIfExists === true,
    };
  }
  if (value.kind === 'delete') {
    const path = typeof value.uri === 'string' ? safePath(value.uri, toPath) : null;
    if (!path) return null;
    return {
      kind: 'delete',
      path,
      recursive: options.recursive === true,
      ignoreIfNotExists: options.ignoreIfNotExists === true,
    };
  }
  return null;
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
