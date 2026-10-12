/**
 * Подсказки языкового сервера для своего редактора: наведение, определение, ссылки, символы.
 *
 * Всё это раньше отдавал Monaco: он звал провайдеров (`lsp-providers.ts`) и складывал
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
 *   • позиции переводим туда-обратно: Monaco, наш редактор и `document.path` считают
 *     строки с 1, LSP — с 0. Перевод в одном месте, а не у каждого вызова;
 *   • разбор ответов берём из `shared/lsp-*.ts`: он уже проверен тестами и общий с
 *     агентом. Здесь — только I/O и склейка.
 *
 * Модуль чист по отношению к DOM: он ходит по сети и разбирает, но ничего не рисует.
 * Поэтому его видно в тестах без окна (с подставным `rpc`).
 */

import type { LspDiagnostic } from '../../../shared/api';
import type { FileEdit } from '../../../shared/edits';
import { toLocations, type SymbolLocation } from '../../../shared/lsp-locations';
import { toCompletions } from '../../../shared/lsp-completions';
import { toCodeActions, toLspDiagnostics, type CodeActionItem } from '../../../shared/lsp-code-actions';
import { toFoldRanges, type FoldRange } from '../../../shared/fold-ranges';
import { toSignatureHelp, type SignatureHelp } from '../../../shared/lsp-signature';
import type { FileSymbol } from '../../../shared/lsp-symbols';
import { toFileSymbols } from '../../../shared/lsp-symbols';
import { toWorkspaceFileEdits } from '../../../shared/lsp-workspace-edit';
import { pathToUri, uriToPath } from '../../core/document';
import type { RpcClient } from '../../core/rpc';
import type { CompletionItem } from '../complete/completions';

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
    }));
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
   * Выполнить команду сервера. Ответ бывает разным: чаще `null`, но бывают и правки
   * (`WorkspaceEdit`) — тогда их возвращаем, чтобы вызывающий применил их обычным путём.
   */
  async executeCommand(path: string, command: string, args: readonly unknown[]): Promise<unknown> {
    return this.request(path, 'workspace/executeCommand', { command, arguments: [...args] });
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
