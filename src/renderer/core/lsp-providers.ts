import * as monaco from 'monaco-editor';
import { LANGUAGES } from '../../shared/languages';
import { uriToPath } from './document';
import type { RpcClient } from './rpc';

/**
 * Подсказки от языковых серверов.
 *
 * Своего анализатора у IDE нет: Monaco подсвечивает синтаксис, но не знает
 * ни импортов, ни типов. Поэтому при вводе спрашиваем языковой сервер (pylsp,
 * pyright, tsserver) и превращаем его ответ в объекты Monaco.
 *
 * Логика одна на три запроса — completion, hover, definition: собрать позицию,
 * сходить в main (сервер там, это процесс) и перевести ответ LSP в форму Monaco.
 * Нет сервера для языка — main вернёт null, и подсказка просто не появится.
 */

/** Ход к серверу: путь файла, метод LSP и его аргументы. */
type LspRequest = (path: string, method: string, params: unknown) => Promise<unknown>;

/** Ошибка сервера — не повод падать: подсказки просто не будет. */
function safeRequest(rpc: RpcClient): LspRequest {
  return (path, method, params) =>
    rpc.request('lsp.request', { path, method, params }).catch(() => null);
}

export function registerLspProviders(rpc: RpcClient): monaco.IDisposable {
  const request = safeRequest(rpc);
  const disposables: monaco.IDisposable[] = [];

  for (const language of LANGUAGES) {
    disposables.push(registerForLanguage(language.id, request));
  }

  return { dispose: () => { for (const item of disposables) item.dispose(); } };
}

function registerForLanguage(language: string, request: LspRequest): monaco.IDisposable {
  return combine([
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ['.', '"', "'", '/', '@'],
      async provideCompletionItems(model, position) {
        const path = pathOf(model);
        if (!path) return null;
        const result = await request(path, 'textDocument/completion', {
          textDocument: { uri: model.uri.toString() },
          position: toPosition(position),
        });
        const items = completionItems(result);
        if (items.length === 0) return null;
        return { suggestions: items.map((item) => toSuggestion(item, model, position)) };
      },
    }),
    monaco.languages.registerHoverProvider(language, {
      async provideHover(model, position) {
        const path = pathOf(model);
        if (!path) return null;
        const result = await request(path, 'textDocument/hover', {
          textDocument: { uri: model.uri.toString() },
          position: toPosition(position),
        });
        const contents = hoverContents(result);
        if (contents.length === 0) return null;
        const range = hoverRange(result);
        return { contents, ...(range ? { range } : {}) };
      },
    }),
    monaco.languages.registerDefinitionProvider(language, {
      async provideDefinition(model, position) {
        const path = pathOf(model);
        if (!path) return null;
        const result = await request(path, 'textDocument/definition', {
          textDocument: { uri: model.uri.toString() },
          position: toPosition(position),
        });
        return definitionLocations(result);
      },
    }),
    monaco.languages.registerReferenceProvider(language, {
      async provideReferences(model, position, context) {
        const path = pathOf(model);
        if (!path) return null;
        const result = await request(path, 'textDocument/references', {
          textDocument: { uri: model.uri.toString() },
          position: toPosition(position),
          context: { includeDeclaration: context.includeDeclaration },
        });
        return definitionLocations(result);
      },
    }),
    monaco.languages.registerRenameProvider(language, {
      async provideRenameEdits(model, position, newName) {
        const path = pathOf(model);
        if (!path) return null;
        const result = await request(path, 'textDocument/rename', {
          textDocument: { uri: model.uri.toString() },
          position: toPosition(position),
          newName,
        });
        return workspaceEdit(result);
      },
    }),
    monaco.languages.registerDocumentSymbolProvider(language, {
      async provideDocumentSymbols(model) {
        const path = pathOf(model);
        if (!path) return null;
        const result = await request(path, 'textDocument/documentSymbol', {
          textDocument: { uri: model.uri.toString() },
        });
        return documentSymbols(result);
      },
    }),
    // Быстрые правки: их предлагает сервер (у ruff — «убрать неиспользуемый импорт»).
    // Действие без собственной правки не показываем: команды сервера мы не исполняем.
    monaco.languages.registerCodeActionProvider(language, {
      async provideCodeActions(model, range, context) {
        const path = pathOf(model);
        if (!path) return null;
        const result = await request(path, 'textDocument/codeAction', {
          textDocument: { uri: model.uri.toString() },
          range: { start: toPosition(range.getStartPosition()), end: toPosition(range.getEndPosition()) },
          context: { diagnostics: lspDiagnostics(context.markers) },
        });
        return { actions: codeActions(result), dispose: () => undefined };
      },
    }),
  ]);
}

/* ── позиции ────────────────────────────────────────────────────────────── */

/** Monaco нумерует строки и столбцы с 1, LSP — с 0. */
function toPosition(position: monaco.Position): { line: number; character: number } {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

function fromRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }): monaco.Range {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
}

/** Путь файла из модели — в форме `document.path`: сервер ключует документы так же. */
function pathOf(model: monaco.editor.ITextModel): string | null {
  const uri = model.uri;
  if (uri.scheme !== 'file') return null;
  return uriToPath(uri.path);
}

/* ── completion ─────────────────────────────────────────────────────────── */

interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value: string };
  insertText?: string;
  sortText?: string;
  filterText?: string;
  textEdit?: { newText: string };
}

/** Сервер может вернуть список напрямую или в обёртке `CompletionList`. */
function completionItems(result: unknown): LspCompletionItem[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : ((result as { items?: unknown[] }).items ?? []);
  return list.filter((item): item is LspCompletionItem => {
    return typeof item === 'object' && item !== null && typeof (item as LspCompletionItem).label === 'string';
  });
}

/** Коды видов LSP → виды Monaco. Номера LSP и Monaco не совпадают, таблица обязательна. */
const K = monaco.languages.CompletionItemKind;
const COMPLETION_KIND: Record<number, monaco.languages.CompletionItemKind> = {
  1: K.Text,
  2: K.Method,
  3: K.Function,
  4: K.Constructor,
  5: K.Field,
  6: K.Variable,
  7: K.Class,
  8: K.Interface,
  9: K.Module,
  10: K.Property,
  11: K.Unit,
  12: K.Value,
  13: K.Enum,
  14: K.Keyword,
  15: K.Snippet,
  16: K.Color,
  17: K.File,
  18: K.Reference,
  20: K.EnumMember,
  21: K.Constant,
  22: K.Struct,
  24: K.Event,
  25: K.Operator,
};

function toSuggestion(
  item: LspCompletionItem,
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): monaco.languages.CompletionItem {
  const word = model.getWordUntilPosition(position);
  const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
  const documentation =
    typeof item.documentation === 'string' ? item.documentation : item.documentation?.value;

  return {
    label: item.label,
    kind: COMPLETION_KIND[item.kind ?? 1] ?? K.Text,
    insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
    range,
    ...(item.detail ? { detail: item.detail } : {}),
    ...(documentation ? { documentation } : {}),
    ...(item.sortText ? { sortText: item.sortText } : {}),
    ...(item.filterText ? { filterText: item.filterText } : {}),
  };
}

/* ── hover ──────────────────────────────────────────────────────────────── */

/** LSP может прислать строку, MarkupContent или массив — приводим к markdown-строкам. */
function hoverContents(result: unknown): monaco.IMarkdownString[] {
  if (!result || typeof result !== 'object') return [];
  const contents = (result as { contents?: unknown }).contents;
  if (contents === undefined || contents === null) return [];

  if (typeof contents === 'string') return [{ value: contents }];
  if (Array.isArray(contents)) {
    const parts = contents
      .map((part) => (typeof part === 'string' ? part : (part as { value?: string })?.value))
      .filter((part): part is string => Boolean(part));
    return parts.length > 0 ? [{ value: parts.join('\n\n') }] : [];
  }
  const value = (contents as { value?: string }).value;
  return value ? [{ value }] : [];
}

function hoverRange(result: unknown): monaco.Range | undefined {
  const range = (result as { range?: unknown })?.range;
  return isRange(range) ? fromRange(range) : undefined;
}

/* ── definition ─────────────────────────────────────────────────────────── */

/** LSP отдаёт Location, LocationLink или их массив — приводим к переходам Monaco. */
function definitionLocations(result: unknown): monaco.languages.Location[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  const locations: monaco.languages.Location[] = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const value = item as {
      uri?: string;
      range?: unknown;
      targetUri?: string;
      targetSelectionRange?: unknown;
    };
    const uri = value.uri ?? value.targetUri;
    const range = value.range ?? value.targetSelectionRange;
    if (typeof uri !== 'string' || !isRange(range)) continue;
    locations.push({ uri: monaco.Uri.parse(uri), range: fromRange(range) });
  }

  return locations;
}

function isRange(value: unknown): value is { start: { line: number; character: number }; end: { line: number; character: number } } {
  if (!value || typeof value !== 'object') return false;
  const range = value as { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } };
  return (
    typeof range.start?.line === 'number' &&
    typeof range.start.character === 'number' &&
    typeof range.end?.line === 'number' &&
    typeof range.end.character === 'number'
  );
}

/** Несколько регистраций — один выключатель: в app.ts его не придётся разбирать. */
function combine(disposables: monaco.IDisposable[]): monaco.IDisposable {
  return { dispose: () => { for (const item of disposables) item.dispose(); } };
}

/* ── ссылки, переименование, символы, быстрые правки ────────────────────── */

/**
 * Правки от сервера (rename, code action). LSP присылает их в одном из двух
 * видов: `changes` (карта uri → правки) или `documentChanges` (список с версией
 * документа). Monaco понимает единый `WorkspaceEdit`, поэтому сводим оба сюда.
 */
function workspaceEdit(result: unknown): monaco.languages.WorkspaceEdit | null {
  if (!result || typeof result !== 'object') return null;
  const edits: monaco.languages.IWorkspaceTextEdit[] = [];

  const changes = (result as { changes?: unknown }).changes;
  if (changes && typeof changes === 'object') {
    for (const [uri, list] of Object.entries(changes as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const edit = toTextEdit(item);
        if (edit) edits.push({ resource: monaco.Uri.parse(uri), versionId: undefined, textEdit: edit });
      }
    }
  }

  const documentChanges = (result as { documentChanges?: unknown }).documentChanges;
  if (Array.isArray(documentChanges)) {
    for (const change of documentChanges) {
      const value = change as { textDocument?: { uri?: unknown }; edits?: unknown };
      const uri = value.textDocument?.uri;
      if (typeof uri !== 'string' || !Array.isArray(value.edits)) continue;
      for (const item of value.edits) {
        const edit = toTextEdit(item);
        if (edit) edits.push({ resource: monaco.Uri.parse(uri), versionId: undefined, textEdit: edit });
      }
    }
  }

  return edits.length > 0 ? { edits } : null;
}

/** Одна правка LSP (`range` + `newText`) в форму Monaco (`range` + `text`). */
function toTextEdit(raw: unknown): monaco.languages.TextEdit | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { range?: unknown; newText?: unknown };
  if (!isRange(value.range) || typeof value.newText !== 'string') return null;
  return { range: fromRange(value.range), text: value.newText };
}

/**
 * Символы документа: структура файла (функции, классы) для панели и перехода.
 * Сервер может ответить `DocumentSymbol` (с вложенностью) или плоским
 * `SymbolInformation` — поддерживаем оба: у второго диапазон лежит в `location`.
 */
function documentSymbols(result: unknown): monaco.languages.DocumentSymbol[] {
  if (!Array.isArray(result)) return [];
  const out: monaco.languages.DocumentSymbol[] = [];
  for (const item of result) {
    const symbol = toDocumentSymbol(item);
    if (symbol) out.push(symbol);
  }
  return out;
}

function toDocumentSymbol(raw: unknown): monaco.languages.DocumentSymbol | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as {
    name?: unknown;
    kind?: unknown;
    range?: unknown;
    selectionRange?: unknown;
    location?: { range?: unknown };
    children?: unknown;
  };
  if (typeof value.name !== 'string') return null;

  const range = value.range ?? value.location?.range;
  if (!isRange(range)) return null;
  const selection = isRange(value.selectionRange) ? value.selectionRange : range;
  const children = Array.isArray(value.children)
    ? value.children
        .map(toDocumentSymbol)
        .filter((child): child is monaco.languages.DocumentSymbol => child !== null)
    : [];

  return {
    name: value.name,
    detail: '',
    kind: symbolKind(value.kind),
    tags: [],
    range: fromRange(range),
    selectionRange: fromRange(selection),
    children,
  };
}

/** Виды символов: LSP нумерует с 1, Monaco — с 0, остальное совпадает. */
function symbolKind(value: unknown): monaco.languages.SymbolKind {
  const lsp = typeof value === 'number' ? value : 1;
  return Math.min(Math.max(lsp - 1, 0), 25) as monaco.languages.SymbolKind;
}

/** Быстрые правки сервера, у которых есть собственная правка текста. */
function codeActions(result: unknown): monaco.languages.CodeAction[] {
  if (!Array.isArray(result)) return [];
  const out: monaco.languages.CodeAction[] = [];
  for (const item of result) {
    if (!item || typeof item !== 'object') continue;
    const value = item as { title?: unknown; kind?: unknown; edit?: unknown };
    if (typeof value.title !== 'string') continue;

    const action: monaco.languages.CodeAction = { title: value.title };
    if (typeof value.kind === 'string') action.kind = value.kind;
    const edit = workspaceEdit(value.edit);
    if (!edit) continue;
    action.edit = edit;
    out.push(action);
  }
  return out;
}

/**
 * Пометки Monaco → диагностики LSP для запроса быстрых правок.
 * Уровни не совпадают: Monaco Heavy кодирует битовой маской, LSP — числами 1..4.
 */
function lspDiagnostics(markers: readonly monaco.editor.IMarkerData[]): unknown[] {
  return markers.map((marker) => ({
    range: {
      start: { line: marker.startLineNumber - 1, character: marker.startColumn - 1 },
      end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 },
    },
    severity: markerSeverity(marker.severity),
    message: marker.message,
    ...(marker.source ? { source: marker.source } : {}),
  }));
}

function markerSeverity(value: monaco.MarkerSeverity): number {
  if (value >= monaco.MarkerSeverity.Error) return 1;
  if (value >= monaco.MarkerSeverity.Warning) return 2;
  if (value >= monaco.MarkerSeverity.Info) return 3;
  return 4;
}
