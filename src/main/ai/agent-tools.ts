import path from 'node:path';
import {
  type ApplyEditsHostResult,
  type DiagnosticItem,
  type DiagnosticsHostResult,
  type DirEntry,
} from '../../shared/api';
import type { FileEdit, TextEdit } from '../../shared/edits';
import { parseToolArguments } from '../../shared/tools';
import type { WorkspaceService } from '../workspace/workspace';
import { runShellCommand } from './run-command';

/**
 * Исполнение инструментов агента.
 *
 * Чтение (list_dir, read_file, search) и запуск команд делаются здесь же:
 * все пути проходят через `WorkspaceService`, а значит ограничены рабочей
 * папкой (включая проверку симлинков). Правки (`apply_edit`) уходят в renderer
 * хостовым вызовом — там документная модель, undo и ревью пользователя.
 */

export interface ToolOutcome {
  ok: boolean;
  /** Короткая строка для карточки в UI. */
  summary: string;
  /** То, что уходит модели. Может быть длинным — усекается до `MAX_OUTPUT_CHARS`. */
  detail?: string;
}

export interface ToolContext {
  workspace: WorkspaceService;
  signal?: AbortSignal;
  /** Автопилот: не спрашивать разрешения на правки и рядовые команды. */
  autoApprove?: boolean;
  /** Правки в документах; нет обработчика — правки недоступны. */
  applyEdits?(edits: FileEdit[], autoApprove: boolean): Promise<ApplyEditsHostResult>;
  /** Спросить у пользователя разрешение на запуск команды. */
  confirmCommand?(command: string): Promise<boolean>;
  /** Пометки языка из редактора. */
  diagnostics?(path?: string): Promise<DiagnosticsHostResult>;
}

/** Ограничение вывода: без него один файл на 2 МБ съест весь контекст модели. */
const MAX_OUTPUT_CHARS = 20_000;
const MAX_SEARCH_HITS = 200;
const MAX_DIR_ENTRIES = 500;

/** Максимум правок за один вызов: защита от вырожденного ответа модели. */
const MAX_EDITED_FILES = 50;
const MAX_EDITS_PER_FILE = 500;

/** Команда длиннее — это уже не команда, а попытка спрятать скрипт. */
const MAX_COMMAND_CHARS = 2000;

/**
 * Команды, которые в автопилоте всё равно спрашивают подтверждение.
 * Список не защита от злого умысла, а страховка от необратимой ошибки:
 * цена промаха у них выше, чем выигрыш от автоматизации.
 */
const DANGEROUS_COMMAND =
  /(^|[\s;&|])(rm|rmdir|shred|dd|mkfs\S*|fdisk|shutdown|reboot|poweroff|halt|format)\s|:\s*\(\s*\)\s*\{|>\s*\/dev\/(sd|nvme|disk)|chmod\s+-R\s+\S*\s+\/\s|git\s+push\s+[^\n]*(--force|-f)\b|npm\s+publish|\|\s*(ba|z|fi)?sh\b/i;

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND.test(command);
}

export async function runTool(ctx: ToolContext, name: string, rawArguments: string): Promise<ToolOutcome> {
  const parsed = parseToolArguments(rawArguments);
  if (!parsed.ok) return { ok: false, summary: parsed.message };

  try {
    switch (name) {
      case 'list_dir':
        return await listDir(ctx.workspace, parsed.value);
      case 'read_file':
        return await readFile(ctx.workspace, parsed.value);
      case 'search':
        return await search(ctx.workspace, parsed.value);
      case 'get_diagnostics':
        return await diagnostics(ctx, parsed.value);
      case 'apply_edit':
        return await applyEdit(ctx, parsed.value);
      case 'run_terminal':
        return await runTerminal(ctx, parsed.value);
      default:
        return { ok: false, summary: `Инструмент недоступен: ${name}` };
    }
  } catch (error) {
    return { ok: false, summary: error instanceof Error ? error.message : String(error) };
  }
}

async function listDir(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const requested = optionalString(args, 'path') ?? workspace.rootPath();
  if (!requested) return { ok: false, summary: 'Рабочая папка не открыта' };

  const root = workspace.rootPath();
  const entries = await workspace.readDir(requested);
  const shown = entries.slice(0, MAX_DIR_ENTRIES);
  const lines = shown.map((entry) => `${describe(entry, root)}`);
  if (entries.length > shown.length) lines.push(`… ещё ${entries.length - shown.length} записей`);

  return {
    ok: true,
    summary: `${relative(requested, root)}: ${entries.length} записей`,
    detail: lines.length ? lines.join('\n') : '(пусто)',
  };
}

async function readFile(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const target = requireString(args, 'path');
  const content = await workspace.readFile(target);
  const { text, truncated } = truncate(content.text);
  const lines = content.text.length === 0 ? 0 : content.text.split('\n').length;

  return {
    ok: true,
    summary: `${relative(target, workspace.rootPath())}: ${lines} строк${truncated ? ' (обрезано)' : ''}`,
    detail: text.length ? text : '(пустой файл)',
  };
}

async function search(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const query = requireString(args, 'query');
  const isRegex = optionalBoolean(args, 'isRegex') ?? false;
  const glob = optionalString(args, 'glob');

  const result = await workspace.search({ query, isRegex, glob, maxResults: MAX_SEARCH_HITS });
  const root = workspace.rootPath();
  const lines = result.hits.map((hit) => `${relativePath(hit.path, root)}:${hit.line}:${hit.column}: ${hit.text}`);

  return {
    ok: true,
    summary: `${result.hits.length} совпадений${result.truncated ? ', список обрезан' : ''} · просканировано файлов: ${result.scanned}`,
    detail: lines.length ? lines.join('\n') : 'Ничего не найдено',
  };
}

/* ── диагностика ────────────────────────────────────────────────────────── */

const MAX_DIAGNOSTICS = 100;

/** Пометки языка собирает renderer: они живут в Monaco, а не на диске. */
async function diagnostics(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.diagnostics) {
    return { ok: false, summary: 'Диагностика недоступна: окно редактора не подключено' };
  }

  const target = optionalString(args, 'path');
  const result = await ctx.diagnostics(target);
  const items = result.items.slice(0, MAX_DIAGNOSTICS);

  if (result.items.length === 0) {
    return {
      ok: true,
      summary: target ? `Ошибок нет: ${path.basename(target)}` : 'Ошибок нет',
      detail: 'Пометок языка нет. Если ждал ошибку — проверь, что файл открыт в редакторе.',
    };
  }

  const root = ctx.workspace.rootPath();
  const lines = items.map((item) => `${formatDiagnostic(item, root)}`);
  if (result.items.length > items.length) lines.push(`… ещё пометок: ${result.items.length - items.length}`);

  const errors = result.items.filter((item) => item.severity === 'error').length;
  const warnings = result.items.length - errors;

  return {
    ok: true,
    summary: `ошибок: ${errors}, предупреждений: ${warnings}`,
    detail: lines.join('\n'),
  };
}

function formatDiagnostic(item: DiagnosticItem, root: string | null): string {
  const where = root ? path.relative(root, item.path) : item.path;
  return `${where}:${item.line}:${item.column} [${item.severity}] ${item.message}${item.source ? ` (${item.source})` : ''}`;
}

/* ── правки документов ──────────────────────────────────────────────────── */
/** `apply_edit` едет в renderer: там документная модель, undo и ревью. */
async function applyEdit(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.applyEdits) {
    return { ok: false, summary: 'Правки сейчас недоступны: окно редактора не подключено' };
  }

  const edits = parseFileEdits(args.edits);
  const names = edits.map((file) => path.basename(file.path));
  const decision = await ctx.applyEdits(edits, ctx.autoApprove === true);

  if (decision.rejected) {
    return {
      ok: false,
      summary: `Пользователь отклонил правки: ${names.join(', ')}`,
      detail: 'Пользователь отклонил правки. Не повторяй этот вызов — предложи другое решение.',
    };
  }

  const applied = decision.result?.reports ?? [];
  const failed = decision.result?.failed ?? [];
  const lines = [
    ...applied.map((report) => `ok ${path.basename(report.path)}: применено правок — ${report.applied}`),
    ...failed.map((failure) => `ошибка ${path.basename(failure.path)}: ${failure.message}`),
  ];

  return {
    ok: failed.length === 0,
    summary: `применено файлов: ${applied.length}${failed.length ? `, с ошибками: ${failed.length}` : ''}`,
    detail: lines.join('\n') || 'Правки не применены',
  };
}

/**
 * Разбор аргументов `apply_edit`. Модель — недоверенный источник, поэтому
 * структура проверяется вручную: битый FileEdit дальше в документную модель
 * попасть не должен.
 */
function parseFileEdits(value: unknown): FileEdit[] {
  if (!Array.isArray(value)) throw new Error('Аргумент «edits» должен быть массивом');
  if (value.length === 0) throw new Error('Не передано ни одной правки');
  if (value.length > MAX_EDITED_FILES) {
    throw new Error(`Слишком много файлов за один вызов: ${value.length} (максимум ${MAX_EDITED_FILES})`);
  }

  return value.map((item, index) => parseFileEdit(item, index));
}

function parseFileEdit(value: unknown, index: number): FileEdit {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`edits[${index}]: ожидался объект`);
  }

  const raw = value as Record<string, unknown>;
  const filePath = raw.path;
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error(`edits[${index}]: не задан path`);
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error(`edits[${index}].path: нужен абсолютный путь, получено «${filePath}»`);
  }

  const edits = raw.edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error(`edits[${index}].edits: нужен непустой массив правок`);
  }
  if (edits.length > MAX_EDITS_PER_FILE) {
    throw new Error(`edits[${index}].edits: слишком много правок (${edits.length}), максимум ${MAX_EDITS_PER_FILE}`);
  }

  const fileEdit: FileEdit = {
    path: filePath,
    edits: edits.map((edit, editIndex) => parseTextEdit(edit, index, editIndex)),
  };
  if (typeof raw.expectedVersion === 'number') fileEdit.expectedVersion = raw.expectedVersion;
  return fileEdit;
}

function parseTextEdit(value: unknown, fileIndex: number, editIndex: number): TextEdit {
  const where = `edits[${fileIndex}].edits[${editIndex}]`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: ожидался объект`);
  }

  const raw = value as Record<string, unknown>;
  const position = (key: string): number => {
    const number = raw[key];
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
      throw new Error(`${where}.${key}: нужно целое число ≥ 1`);
    }
    return number;
  };

  const newText = raw.newText;
  if (typeof newText !== 'string') throw new Error(`${where}.newText: нужна строка`);

  const edit: TextEdit = {
    startLine: position('startLine'),
    startColumn: position('startColumn'),
    endLine: position('endLine'),
    endColumn: position('endColumn'),
    newText,
  };

  // Необязательный якорь: с ним правка сверяется с документом и не может
  // «попасть» в другое место из-за сбитой позиции.
  if (raw.oldText !== undefined) {
    if (typeof raw.oldText !== 'string') throw new Error(`${where}.oldText: нужна строка`);
    edit.oldText = raw.oldText;
  }

  return edit;
}

/* ── запуск команд ──────────────────────────────────────────────────────── */

/**
 * `run_terminal` — единственный инструмент, который меняет систему за
 * пределами документов, поэтому он всегда идёт через подтверждение.
 */
async function runTerminal(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const command = requireString(args, 'command').trim();
  if (command.length > MAX_COMMAND_CHARS) {
    throw new Error(`Команда длиннее ${MAX_COMMAND_CHARS} символов`);
  }
  if (!ctx.confirmCommand) {
    return { ok: false, summary: 'Запуск команд недоступен: окно редактора не подключено' };
  }

  const root = ctx.workspace.rootPath();
  if (!root) return { ok: false, summary: 'Рабочая папка не открыта' };

  // В автопилоте рядовые команды идут без вопросов, но необратимые — всегда через диалог.
  const needsPermission = !ctx.autoApprove || isDangerousCommand(command);
  if (needsPermission) {
    const allowed = await ctx.confirmCommand(command);
    if (!allowed) {
      return {
        ok: false,
        summary: 'Пользователь запретил выполнение команды',
        detail: 'Пользователь не разрешил выполнить эту команду. Не повторяй её — предложи другое решение.',
      };
    }
  }

  const result = await runShellCommand(command, root, ctx.signal);
  const output = result.output.trim();
  const notes: string[] = [];
  if (result.timedOut) notes.push('превышено время выполнения');
  if (result.truncated) notes.push('вывод обрезан');

  return {
    ok: result.code === 0 && !result.timedOut,
    summary: `код выхода ${result.code ?? '—'}${notes.length ? ` (${notes.join(', ')})` : ''}`,
    detail: `$ ${command}\n${output.length ? output : '(пустой вывод)'}`,
  };
}

/* ── вспомогательное ────────────────────────────────────────────────────── */

function describe(entry: DirEntry, root: string | null): string {
  const suffix = entry.kind === 'directory' ? '/' : '';
  const size = entry.kind === 'file' ? ` (${entry.size} Б)` : '';
  return `${relativePath(entry.path, root)}${suffix}${size}`;
}

function relative(target: string, root: string | null): string {
  return relativePath(target, root);
}

function relativePath(target: string, root: string | null): string {
  if (!root) return target;
  const rel = path.relative(root, target);
  return rel.length === 0 ? '.' : rel;
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (вывод обрезан)`, truncated: true };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Не задан аргумент «${key}»`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}
