/**
 * Быстрые исправления и прочие действия языка: разбор ответа `textDocument/codeAction`.
 *
 * Сервер отвечает списком действий. Действие бывает двух видов: правки (`edit` —
 * `WorkspaceEdit`, тот же вид, что у переименования) или команда, которую надо потом
 * выполнить на сервере (`command`). Разбираем оба, приводим к нашей форме и отдаём
 * вызывающему: показ (список) — дело renderer, применение правок — документной модели.
 *
 * Здесь же — сборка контекста запроса: сервер хочет видеть диагностики под курсором,
 * на которые и отвечает исправлениями. Пометки у нас в своей форме (`LspDiagnostic`),
 * переводим их в форму LSP (позиции с 0, серьёзность числом) в одном месте.
 *
 * Модуль чистый: про `file://` не знает (путь из ссылки передаёт вызывающий функцией),
 * поэтому проверяется тестами без окна (`tests/lsp-code-actions.test.ts`).
 */

import type { LspDiagnostic } from './api';
import type { FileEdit } from './edits';
import { toWorkspaceFileEdits } from './lsp-workspace-edit';

/** Команда сервера: её выполняют на сервере запросом `workspace/executeCommand`. */
export interface CodeActionCommand {
  command: string;
  arguments: unknown[];
}

/** Одно действие языка: что показать и чем оно правит. */
export interface CodeActionItem {
  title: string;
  /** Вид действия от сервера (`quickfix`, `refactor.extract`, …). Пусто — сервер не сказал. */
  kind: string;
  /** Сервер назвал действие предпочтительным — такое показываем первым. */
  preferred: boolean;
  /** Правки действия (несколько файлов). `null` — правок нет, есть только команда. */
  edits: FileEdit[] | null;
  /** Команда сервера. `null` — действие правит файлы само. */
  command: CodeActionCommand | null;
  /** Сообщения диагностик, к которым действие привязано (для подсказки в списке). */
  diagnostics: string[];
}

/**
 * Разбор ответа `codeAction`. Мусор и действия без заголовка пропускаем: показать их
 * нечем. Порядок — предпочтительные вперёд, дальше по заголовку: список читают глазами,
 * и «быстрое исправление» должно быть первым, а не там, где его прислал сервер.
 */
export function toCodeActions(raw: unknown, toPath: (uri: string) => string): CodeActionItem[] {
  if (!Array.isArray(raw)) return [];
  const items: CodeActionItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as {
      title?: unknown;
      kind?: unknown;
      isPreferred?: unknown;
      edit?: unknown;
      command?: unknown;
      diagnostics?: unknown;
    };
    if (typeof value.title !== 'string' || value.title.trim() === '') continue;
    const kind = typeof value.kind === 'string' ? value.kind : '';
    items.push({
      title: value.title,
      kind,
      // Сервер может не пометить быстрое исправление флажком — по виду это видно и так.
      preferred: value.isPreferred === true || kind.startsWith('quickfix'),
      edits: value.edit ? toWorkspaceFileEdits(value.edit, toPath) : null,
      command: toCommand(value.command),
      diagnostics: toDiagnosticMessages(value.diagnostics),
    });
  }
  return sortCodeActions(items);
}

/** Предпочтительные вперёд, дальше — по заголовку: порядок списка должен быть предсказуем. */
export function sortCodeActions(items: readonly CodeActionItem[]): CodeActionItem[] {
  return [...items].sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.title.localeCompare(b.title));
}

/** Команда сервера из действия: только с непустым именем, аргументы — всегда массив. */
function toCommand(raw: unknown): CodeActionCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { command?: unknown; arguments?: unknown };
  if (typeof value.command !== 'string' || value.command === '') return null;
  return { command: value.command, arguments: Array.isArray(value.arguments) ? value.arguments : [] };
}

/** Сообщения диагностик действия: сервер шлёт их целиком, нам нужен только текст. */
function toDiagnosticMessages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const messages: string[] = [];
  for (const entry of raw) {
    const message = entry && typeof entry === 'object' ? (entry as { message?: unknown }).message : null;
    if (typeof message === 'string' && message !== '') messages.push(message);
  }
  return messages;
}

/**
 * Что за действие — для подсказки справа в списке. Виды у LSP составные
 * (`refactor.extract.function`), поэтому смотрим на первый отрезок.
 */
export function codeActionKindLabel(kind: string): string {
  const head = kind.split('.')[0] ?? '';
  if (head === 'quickfix') return 'быстрое исправление';
  if (head === 'refactor') return 'рефакторинг';
  if (head === 'source') return 'источник';
  if (head === 'notebook') return 'блокнот';
  return kind;
}

/**
 * Пометки в форме LSP — для контекста запроса `codeAction`. Сервер отвечает
 * исправлениями именно на них, поэтому позиции переводим в 0-based, а серьёзность —
 * в число (в LSP это 1 ошибка, 2 предупреждение, 3 замечание).
 */
export function toLspDiagnostics(items: readonly LspDiagnostic[]): unknown[] {
  return items.map((item) => ({
    range: {
      start: { line: Math.max(0, item.line - 1), character: Math.max(0, item.column - 1) },
      end: { line: Math.max(0, item.endLine - 1), character: Math.max(0, item.endColumn - 1) },
    },
    severity: severityNumber(item.severity),
    ...(item.source ? { source: item.source } : {}),
    message: item.message,
  }));
}

/** Серьёзность пометки числом: как в LSP (`DiagnosticSeverity`). */
function severityNumber(severity: LspDiagnostic['severity']): number {
  if (severity === 'error') return 1;
  if (severity === 'warning') return 2;
  return 3;
}

/**
 * Действия, которые сервер отдал без правок и команды: их надо дотянуть.
 *
 * Часть серверов (`typescript-language-server` для автоимпорта, к примеру) в
 * первом ответе присылает только заголовок и `data`, а правки кладёт после
 * `codeAction/resolve`. Такому действию в списке делать нечего — оно ничего не
 * сделает. Считать надо по исходным объектам: в нашей форме `data` нет.
 */
export function unresolvedIndexes(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const indexes: number[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const value = entry as { edit?: unknown; command?: unknown };
    if (value.edit || value.command) return;
    indexes.push(index);
  });
  return indexes;
}

/**
 * Слить исходный объект с ответом `resolve`: сервер дописывает поля, а не отдаёт
 * новый объект. `title` из ответа берём, только если он есть: протокол его
 * разрешает не повторять, а нам он нужен в списке.
 */
export function mergeResolved(source: unknown, resolved: unknown): unknown {
  if (!resolved || typeof resolved !== 'object') return source;
  if (!source || typeof source !== 'object') return resolved;
  return { ...(source as Record<string, unknown>), ...(resolved as Record<string, unknown>) };
}
