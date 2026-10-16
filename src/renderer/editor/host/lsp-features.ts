/**
 * Подсказки языкового сервера для своего редактора: наведение, определение, ссылки, символы.
 *
 * Всё это раньше отдавал движок: он звал провайдеров (`lsp-providers.ts`) и складывал
 * ответы в свои попапы. Свой редактор попапов под это не имеет, поэтому запрос к
 * серверу и разбор ответа вынесены СЮДА, а показ — в слой вида (наведение) и в
 * вызывающего (переход, список ссылок). Разбор остаётся чистым правилом: превратить
 * ответ LSP в наши типы и позиции — и всё.
 *
 * Границы, которые здесь видны:
 *
 *   • запрос уходит через `rpc.request('lsp.request', …)` — сервер живёт в main, это
 *     процесс; в renderer остаётся только «сходи и разбери». Ошибка сервера не повод
 *     падать: `null` от прокси значит «сервера для языка нет», и подсказки просто не будет;
 *   • позиции переводим туда-обратно: наш редактор и `document.path` считают
 *     строки с 1, LSP — с 0. Перевод в одном месте, а не у каждого вызова;
 *   • разбор ответов берём из `shared/lsp-*.ts`: он уже проверен тестами и общий с
 *     агентом. Здесь — только I/O и склейка.
 *
 * Модуль чист по отношению к DOM: он ходит по сети и разбирает, но ничего не рисует.
 * Поэтому его видно в тестах без окна (с подставным `rpc`).
 */

import type { LspDiagnostic } from '../../../shared/api';
import type { FileEdit, TextEdit } from '../../../shared/edits';
import { toLocations, type SymbolLocation } from '../../../shared/lsp-locations';
import { toCompletions, toResolvedCompletion, type ResolvedCompletion } from '../../../shared/lsp-completions';
import { toCodeActions, toLspDiagnostics, type CodeActionItem } from '../../../shared/lsp-code-actions';
import { pickAnyRefactors, pickRefactors, type RefactorAction } from '../../../shared/lsp-refactor';
import { toFoldRanges, type FoldRange } from '../../../shared/fold-ranges';
import { targetFromResolvedLink, toDocumentLinks, type DocumentLinkEntry } from '../../../shared/lsp-document-links';
import { toLinkedRanges, type LinkedRange } from '../../../shared/lsp-linked-editing';
import { toSelectionSpans, type SelectionSpan } from '../../../shared/lsp-selection-range';
import type { SemanticToken } from '../../../shared/lsp-semantic-tokens';
import { toMonikers, type MonikerEntry } from '../../../shared/lsp-moniker';
import { toInlineValues, type InlineValue } from '../../../shared/lsp-inline-value';
import { toInlayHints, type InlayHint } from '../../../shared/lsp-inlay-hints';
import { commandFromLens, toCodeLenses, type CodeLensEntry } from '../../../shared/lsp-code-lens';
import { toSignatureHelp, type SignatureHelp } from '../../../shared/lsp-signature';
import type { FileSymbol } from '../../../shared/lsp-symbols';
import { toFileSymbols } from '../../../shared/lsp-symbols';
import { toWorkspaceEdits, toWorkspaceFileEdits, type WorkspaceEdits } from '../../../shared/lsp-workspace-edit';
import { pathToUri, uriToPath } from '../../core/document';
import type { RpcClient } from '../../core/rpc';
import type { CompletionItem } from '../complete/completions';

/** Потолок досчёта линз без команды: на каждую сервер зовём отдельно. */
const MAX_LENS_RESOLVES = 100;

/** Что сервер готов открывать подсказками: его знаки-триггеры и знаки «принять». */
export interface CompletionTriggers {
  triggerCharacters: string[];
  allCommitCharacters: string[];
  resolveProvider: boolean;
}

/** Сервера нет или он ещё не ответил — триггеров не знаем. */
const NO_TRIGGERS: CompletionTriggers = { triggerCharacters: [], allCommitCharacters: [], resolveProvider: false };

/** Позиция в документе: строка и столбец, оба с единицы — как их видит человек. */
export interface LspPosition {
  line: number;
  column: number;
}

/**
 * Мост к языковому серверу одного проекта. Держит только шаблон запроса: путь и метод,
 * плюс перевод позиций. Всё остальное — разбор ответа в вызывающих.
 */
export class LspFeatures {
  constructor(private readonly rpc: RpcClient) {}

  /**
   * Сходить к серверу. `null` — сервера для языка нет или он не ответил: и то, и другое
   * для показа значит одно — подсказки не будет. Ошибку не пробрасываем: падать из-за
   * недоступного сервера редактор не должен.
   */
  private request(path: string, method: string, params: unknown): Promise<unknown> {
    return this.rpc.request('lsp.request', { path, method, params }).catch(() => null);
  }

  /**
   * Наведение: текст подсказки о символе под позицией. Отдаём готовые строки разметки
   * (markdown) — вид показывает их как есть, не зная, строка это или блок.
   */
  async hover(path: string, position: LspPosition): Promise<string | null> {
    const result = await this.request(path, 'textDocument/hover', {
      textDocument: { uri: pathToUri(path) },
      position: toLspPosition(position),
    });
    return hoverText(result);
  }

  /** Определение символа под позицией: куда перейти. Может быть несколько мест. */
  async definition(path: string, position: LspPosition): Promise<SymbolLocation[]> {
    const result = await this.request(path, 'textDocument/definition', {
      textDocument: { uri: pathToUri(path) },
      position: toLspPosition(position),
    });
    return toLocations(result, uriToPath);
  }

  /** Ссылки на символ под позицией. */
  async references(path: string, position: LspPosition): Promise<SymbolLocation[]> {
    const result = await this.request(path, 'textDocument/references', {
      textDocument: { uri: pathToUri(path) },
      position: toLspPosition(position),
      context: { includeDeclaration: true },
    });
    return toLocations(result, uriToPath);
  }

  /** Объявления в файле (структура). Пустой список — сервер ответил, объявлений нет. */
  async documentSymbols(path: string): Promise<FileSymbol[]> {
    const result = await this.request(path, 'textDocument/documentSymbol', {
      textDocument: { uri: pathToUri(path) },
    });
    return toFileSymbols(result);
  }

  /**
   * Переименование символа под позицией. Сервер отвечает правками сразу в нескольких
   * файлах, поэтому отдаём `FileEdit[]` — их применяет документная модель renderer тем
   * же путём, что и `apply_edit` (с undo). `null` — сервер правок не дал или отказался.
   */
  async rename(path: string, position: LspPosition, newName: string): Promise<FileEdit[] | null> {
    const result = await this.request(path, 'textDocument/rename', {
      textDocument: { uri: pathToUri(path) },
      position: toLspPosition(position),
      newName,
    });
    return toWorkspaceFileEdits(result, uriToPath);
  }

  /**
   * Знаки-триггеры сервера для файла: попап открывается по НИМ (`@` в CSS, `:` в JSON,
   * `.` в TS), а не только по нашему правилу про точку. Сервера нет — пустой ответ.
   */
  async completionTriggers(path: string): Promise<CompletionTriggers> {
    const result = (await this.rpc
      .request('lsp.capabilities', { path })
      .catch(() => null)) as Partial<CompletionTriggers> | null;
    if (!result) return NO_TRIGGERS;
    return {
      triggerCharacters: Array.isArray(result.triggerCharacters) ? result.triggerCharacters : [],
      allCommitCharacters: Array.isArray(result.allCommitCharacters) ? result.allCommitCharacters : [],
      resolveProvider: result.resolveProvider === true,
    };
  }

  /**
   * Подсказки языка в позиции курсора. Отдаём в том же виде, что и слова документа
   * (`CompletionItem`), поэтому вид списка не знает, откуда пришло: от сервера это
   * или из нашего словаря. `insert` сервера важнее подписи — им и вставляем.
   */
  async completion(path: string, position: LspPosition): Promise<CompletionItem[]> {
    const result = await this.request(path, 'textDocument/completion', {
      textDocument: { uri: pathToUri(path) },
      position: toLspPosition(position),
    });
    return toCompletions(result).map((entry) => ({
      label: entry.label,
      kind: 'external' as const,
      detail: entry.detail || 'сервер',
      insert: entry.insert,
      ...(entry.snippet !== undefined ? { snippet: entry.snippet } : {}),
      // Авто-импорт: правки (обычно строка import) применяем вместе со вставкой.
      ...(entry.additionalEdits ? { additionalEdits: entry.additionalEdits } : {}),
      // Сервер сортирует и сопоставляет сам — эти поля переносим как есть.
      ...(entry.filterText !== undefined ? { filterText: entry.filterText } : {}),
      ...(entry.sortText !== undefined ? { sortText: entry.sortText } : {}),
      ...(entry.preselect ? { preselect: true } : {}),
      ...(entry.deprecated ? { deprecated: true } : {}),
      // Исходный элемент — по нему список доводит строку через `completionItem/resolve`.
      ...(entry.source !== undefined ? { resolve: entry.source } : {}),
    }));
  }

  /**
   * Довести подсказку: `completionItem/resolve`. Серверы, умеющие это, в первом ответе
   * часто опускают описание и подробность — без дотягивания список выглядит голым.
   * `item` — исходный элемент от сервера (лежит в `CompletionItem.resolve`).
   */
  async resolveCompletion(path: string, item: unknown): Promise<ResolvedCompletion | null> {
    const result = await this.request(path, 'completionItem/resolve', item);
    return toResolvedCompletion(result);
  }

  /**
   * Подсказка о параметрах вызова в позиции курсора. Разбор — в `shared/lsp-signature.ts`:
   * оттуда приходят подписи, активный довод и границы параметров для подсветки.
   * `null` — сервер молчит или подсказать нечего; показ пропускаем, это не ошибка.
   */
  async signatureHelp(path: string, position: LspPosition): Promise<SignatureHelp | null> {
    const result = await this.request(path, 'textDocument/signatureHelp', {
      textDocument: { uri: pathToUri(path) },
      position: toLspPosition(position),
    });
    return toSignatureHelp(result);
  }

  /**
   * Быстрые исправления и действия языка в позиции курсора. `diagnostics` — пометки этой
   * строки: сервер отвечает исправлениями именно на них, и без них ответа часто нет.
   * Пустой список — сервер ответил, действий не предложил; это не ошибка.
   */
  async codeActions(
    path: string,
    position: LspPosition,
    diagnostics: readonly LspDiagnostic[],
  ): Promise<CodeActionItem[]> {
    const range = toLspPosition(position);
    const result = await this.request(path, 'textDocument/codeAction', {
      textDocument: { uri: pathToUri(path) },
      // Курсор — точкой: сервер сам решит, что взять из пометок контекста.
      range: { start: range, end: range },
      context: { diagnostics: toLspDiagnostics(diagnostics), triggerKind: 1 },
    });
    return toCodeActions(result, uriToPath);
  }

  /**
   * Упорядочить импорты: просим у сервера действие `source.organizeImports` (он один
   * знает, что лишнее, а чего не хватает). Диапазон — весь документ: своего текста у
   * моста нет, конец передаёт вызывающий. Контекст сужен до этого вида действия, чтобы
   * сервер не отвечал прочими правками.
   */
  async organizeImports(path: string, end: { line: number; column: number }): Promise<CodeActionItem[]> {
    const result = await this.request(path, 'textDocument/codeAction', {
      textDocument: { uri: pathToUri(path) },
      range: {
        start: { line: 0, character: 0 },
        end: { line: Math.max(0, end.line - 1), character: Math.max(0, end.column - 1) },
      },
      context: { diagnostics: [], only: ['source.organizeImports'], triggerKind: 1 },
    });
    return toCodeActions(result, uriToPath);
  }

  /**
   * Рефакторинг выделения или символа под кареткой: извлечение («вынести в переменную»)
   * или разворачивание (inline). Сам рефакторинг делает сервер — мы лишь называем
   * раздел действий (`refactor`), а нужный подвид отбираем из его ответа
   * (`shared/lsp-refactor.ts`). Пусто — сервера нет или он такого не предложил.
   */
  async refactor(
    path: string,
    range: { startLine: number; startColumn: number; endLine: number; endColumn: number },
    action: RefactorAction,
  ): Promise<CodeActionItem[]> {
    const result = await this.request(path, 'textDocument/codeAction', {
      textDocument: { uri: pathToUri(path) },
      // Диапазон — как у выделения: извлечение работает по участку, разворачивание —
      // по символу под кареткой (у выделения там нулевая ширина).
      range: {
        start: { line: Math.max(0, range.startLine - 1), character: Math.max(0, range.startColumn - 1) },
        end: { line: Math.max(0, range.endLine - 1), character: Math.max(0, range.endColumn - 1) },
      },
      // Просим весь раздел `refactor` разом, а подвид отбираем сами: серверы сверяют вид
      // по-разному, и строгий ответ на `refactor.extract.function` был бы пустым.
      context: { diagnostics: [], only: ['refactor'], triggerKind: 1 },
    });
    return pickRefactors(toCodeActions(result, uriToPath), action);
  }

  /**
   * Все рефакторинги, которые сервер предлагает для выделения (или символа под кареткой).
   * Отличие от `refactor`: не отбираем подвид, а отдаём весь раздел `refactor` — из него
   * строится общий список «Рефакторинг…». Пусто — сервер ничего не предложил.
   */
  async refactorActions(
    path: string,
    range: { startLine: number; startColumn: number; endLine: number; endColumn: number },
  ): Promise<CodeActionItem[]> {
    const result = await this.request(path, 'textDocument/codeAction', {
      textDocument: { uri: pathToUri(path) },
      range: {
        start: { line: Math.max(0, range.startLine - 1), character: Math.max(0, range.startColumn - 1) },
        end: { line: Math.max(0, range.endLine - 1), character: Math.max(0, range.endColumn - 1) },
      },
      context: { diagnostics: [], only: ['refactor'], triggerKind: 1 },
    });
    return pickAnyRefactors(toCodeActions(result, uriToPath));
  }

  /**
   * Выполнить команду сервера. Ответ бывает разным: чаще `null`, но бывают и правки
   * (`WorkspaceEdit`) — тогда их возвращаем, чтобы вызывающий применил их обычным путём.
   */
  /**
   * Подсказки-вставки: тип переменной, имя параметра. Серверу нужен диапазон — своего
   * текста у моста нет, поэтому конец документа передаёт вызывающий. Пустой ответ —
   * сервер не умеет или нечего подсказать; это не ошибка.
   */
  async inlayHints(path: string, end: { line: number; column: number }): Promise<InlayHint[]> {
    const result = await this.request(path, 'textDocument/inlayHint', {
      textDocument: { uri: pathToUri(path) },
      range: {
        start: { line: 0, character: 0 },
        end: { line: Math.max(0, end.line - 1), character: Math.max(0, end.column - 1) },
      },
    });
    return toInlayHints(result);
  }

  async executeCommand(path: string, command: string, args: readonly unknown[]): Promise<unknown> {
    return this.request(path, 'workspace/executeCommand', { command, arguments: [...args] });
  }

  /**
   * Код-линзы файла: подписи-действия у объявлений («3 ссылки», «Запустить тест»).
   * Часть серверов отдаёт линзы без команды — её просят отдельно (`codeLens/resolve`),
   * и без неё показывать нечего. Такие доводим до готовых, но с потолком: файл с сотнями
   * линз не должен стоить сотни запросов, а недоделанная линза отсеивается.
   */
  async codeLenses(path: string): Promise<CodeLensEntry[]> {
    const result = await this.request(path, 'textDocument/codeLens', {
      textDocument: { uri: pathToUri(path) },
    });
    const entries = toCodeLenses(result);
    const unresolved = entries.filter((entry) => !entry.command).slice(0, MAX_LENS_RESOLVES);
    if (unresolved.length === 0) return entries;

    const resolved = new Map<CodeLensEntry, CodeLensEntry>();
    await Promise.all(
      unresolved.map(async (entry) => {
        const done = await this.resolveCodeLens(path, entry);
        if (done) resolved.set(entry, done);
      }),
    );
    // Линзу без команды (даже после resolve) не показываем: кликать по ней не по чему.
    return entries.flatMap((entry) => {
      const done = resolved.get(entry);
      if (done) return [done];
      return entry.command ? [entry] : [];
    });
  }

  /** `codeLens/resolve`: сервер дописывает команду в линзу, которую отдал без неё. */
  private async resolveCodeLens(path: string, entry: CodeLensEntry): Promise<CodeLensEntry | null> {
    const result = await this.request(path, 'codeLens/resolve', entry.source);
    const command = commandFromLens(result);
    return command ? { ...entry, command } : null;
  }

  /**
   * Отформатировать участок (`textDocument/rangeFormatting`) — выделение или вставленный
   * кусок. Пусто — сервер не умеет или менять нечего. Позиции 1-based, как везде у нас.
   */
  async formatRange(
    path: string,
    range: { startLine: number; startColumn: number; endLine: number; endColumn: number },
  ): Promise<TextEdit[]> {
    return this.rpc.request('lsp.formatRange', { path, ...range }).catch(() => []);
  }

  /**
   * Диапазоны свёртки файла от сервера. Пустой список — сервер ответил, сворачивать
   * нечего или он этого не умеет: вызывающий тогда считает блоки по отступам.
   */
  async foldingRanges(path: string): Promise<FoldRange[]> {
    const result = await this.request(path, 'textDocument/foldingRange', {
      textDocument: { uri: pathToUri(path) },
    });
    return toFoldRanges(result);
  }

  /**
   * Ссылки внутри файла (`textDocument/documentLink`). Часть серверов адрес отдаёт
   * не сразу, а в `resolve` — тогда у ссылки нет `target`, и вызывающий доводит её
   * `resolveDocumentLink`. Без адреса ссылку не показываем: подчёркивать некуда ведущий участок незачем.
   */
  async documentLinks(path: string): Promise<DocumentLinkEntry[]> {
    const result = await this.request(path, 'textDocument/documentLink', {
      textDocument: { uri: pathToUri(path) },
    });
    return toDocumentLinks(result);
  }

  /** Довести ссылку до адреса: `documentLink/resolve` (тот же элемент назад). */
  async resolveDocumentLink(path: string, item: unknown): Promise<string | null> {
    const result = await this.request(path, 'documentLink/resolve', item);
    return targetFromResolvedLink(result);
  }

  /**
   * Связанные участки в позиции курсора (`textDocument/linkedEditingRange`): имена
   * парных тегов HTML/XML, которые надо править вместе. Пустой ответ — сервер не умеет
   * или связывать под курсором нечего; это не ошибка, подсветки просто не будет.
   */
  async linkedEditingRanges(path: string, position: LspPosition): Promise<LinkedRange[]> {
    const result = await this.request(path, 'textDocument/linkedEditingRange', {
      textDocument: { uri: pathToUri(path) },
      position: toLspPosition(position),
    });
    return toLinkedRanges(result);
  }

  /**
   * Цепочка участков вокруг позиции (`textDocument/selectionRange`): от узкого к широкому.
   * По ней работает «выделить по структуре» — слово, потом выражение, строка, блок.
   * Пусто — сервер не умеет или участков нет; это не ошибка, шагать будет некуда.
   */
  async selectionRanges(path: string, position: LspPosition): Promise<SelectionSpan[]> {
    const result = await this.request(path, 'textDocument/selectionRange', {
      textDocument: { uri: pathToUri(path) },
      positions: [toLspPosition(position)],
    });
    return toSelectionSpans(result);
  }

  /**
   * Переименование целиком: `WorkspaceEdit` от сервера может нести и правки содержимого,
   * и операции с файлами (создать/переименовать/удалить). Правки применяет документная
   * модель, операции — приложение (у него файловая система). См. `shared/lsp-workspace-edit.ts`.
   */
  async workspaceEdit(path: string, position: LspPosition, newName: string): Promise<WorkspaceEdits | null> {
    const result = await this.request(path, 'textDocument/rename', {
      textDocument: { uri: pathToUri(path) },
      position: toLspPosition(position),
      newName,
    });
    return toWorkspaceEdits(result, uriToPath);
  }

  /**
   * Семантическая подсветка файла: точные роли от сервера поверх нашей грамматики
   * (см. `LspService.semanticTokens`). Ответ разобран в main — там легенда сервера, —
   * сюда приходят готовые участки. Пусто — сервер не умеет или файл ему неизвестен.
   */
  async semanticTokens(path: string): Promise<SemanticToken[]> {
    const result = await this.rpc.request('lsp.semanticTokens', { path }).catch(() => null);
    return Array.isArray(result) ? (result as SemanticToken[]) : [];
  }

  /**
   * Значения переменных в коде при отладке (`textDocument/inlineValue`). Сервер помечает
   * участки, где стоит показать значение, а сами значения берём у отладчика — поэтому
   * отдаём не готовый текст, а то, ЧТО запросить (см. `shared/lsp-inline-value.ts`).
   * `frameId` — кадр отладчика; сервер по нему решает, что видно в этой точке.
   */
  async inlineValues(
    path: string,
    range: { start: LspPosition; end: LspPosition },
    frame: { frameId: number; line: number; column: number },
  ): Promise<InlineValue[]> {
    const uri = pathToUri(path);
    const result = await this.request(path, 'textDocument/inlineValue', {
      textDocument: { uri },
      range: { start: toLspPosition(range.start), end: toLspPosition(range.end) },
      // Контекст останова: кадр и место, где программа стоит. Без него сервер не знает,
      // какие переменные «живые» на этой строке.
      context: {
        frameId: frame.frameId,
        stoppedLocation: {
          uri,
          range: {
            start: { line: Math.max(0, frame.line - 1), character: Math.max(0, frame.column - 1) },
            end: { line: Math.max(0, frame.line - 1), character: Math.max(0, frame.column - 1) },
          },
        },
      },
    });
    return toInlineValues(result);
  }

  /**
   * Устойчивое имя символа под позицией (`textDocument/moniker`): по нему символ
   * связывается с тем же символом в других инструментах. Пусто — сервер не умеет
   * или у символа нет моникера; это не ошибка.
   */
  async monikers(path: string, position: LspPosition): Promise<MonikerEntry[]> {
    const result = await this.request(path, 'textDocument/moniker', {
      textDocument: { uri: pathToUri(path) },
      position: toLspPosition(position),
    });
    return toMonikers(result);
  }
}

/** Наш 1-based вид → LSP 0-based. Перевод в одном месте, чтобы не разъехаться. */
function toLspPosition(position: LspPosition): { line: number; character: number } {
  return { line: Math.max(0, position.line - 1), character: Math.max(0, position.column - 1) };
}

/**
 * Текст наведения из ответа LSP. Ответ бывает строкой, `MarkupContent` или их массивом —
 * во всех случаях получается набор строк разметки, которые склеиваем пустой строкой
 * (так их и показывает любой редактор: абзацы подсказки разделены).
 *
 * Чистая функция: разбор ответа проверяется без окна и без сети.
 */
export function hoverText(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const contents = (result as { contents?: unknown }).contents;
  if (contents === undefined || contents === null) return null;

  if (typeof contents === 'string') return contents.trim() || null;

  if (Array.isArray(contents)) {
    const parts = contents
      .map((part) => (typeof part === 'string' ? part : (part as { value?: string })?.value))
      .filter((part): part is string => typeof part === 'string' && part.length > 0);
    return parts.length > 0 ? parts.join('\n\n') : null;
  }

  const value = (contents as { value?: string }).value;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
