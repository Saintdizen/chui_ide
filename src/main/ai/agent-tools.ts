import path from 'node:path';
import {
  type ApplyEditsHostResult,
  type DiagnosticItem,
  type DiagnosticsHostResult,
  type DirEntry,
  type GitStatus,
  type TerminalCreateOptions,
  type TerminalSession,
  type ToolFileChange,
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
  /** Фактически прочитанный диапазон строк (1-based, включительно): повтор не нужен. */
  read?: { path: string; from: number; to: number };
  /** Файловые операции (создание/удаление/перенос): их показывает панель изменений чата. */
  changes?: ToolFileChange[];
}

/**
 * Git-инструменты агента. Нужен только минимум: посмотреть статус и diff.
 * Полный `GitService` подходит сюда структурно (см. `diffText`).
 */
export interface GitTools {
  status(): Promise<GitStatus>;
  diffText(path: string, staged?: boolean): Promise<string>;
  /** История коммитов текстом: hash, дата, автор, заголовок. */
  logText(limit?: number, path?: string): Promise<string>;
}

/**
 * Терминал для агента: настоящий pty, а не одноразовый spawn. Сессия живёт
 * между шагами — можно поднять сервер и позже читать его вывод.
 * Полный `TerminalService` подходит сюда структурно.
 */
export interface TerminalAgent {
  list(): TerminalSession[];
  create(options: TerminalCreateOptions): Promise<TerminalSession>;
  write(id: string, data: string): void;
  read(id: string, from?: number): { data: string; offset: number; alive: boolean; exitCode?: number };
  kill(id: string): void;
}

export interface ToolContext {
  workspace: WorkspaceService;
  signal?: AbortSignal;
  /** Полный доступ: не спрашивать разрешения на правки. */
  autoApprove?: boolean;
  /** Полный доступ: не спрашивать разрешения ни на что — включая команды. */
  allowAll?: boolean;
  /**
   * Страховка полного доступа: даже при нём спрашивать перед необратимыми
   * командами. Идёт из `settings.ai.confirmDangerous`, по умолчанию выключена.
   */
  confirmDangerous?: boolean;
  /** Правки в документах; нет обработчика — правки недоступны. */
  applyEdits?(edits: FileEdit[], autoApprove: boolean): Promise<ApplyEditsHostResult>;
  /** Спросить у пользователя разрешение на запуск команды. */
  confirmCommand?(command: string): Promise<boolean>;
  /** Пометки языка из редактора. */
  diagnostics?(path?: string): Promise<DiagnosticsHostResult>;
  /** Git рабочей папки: нужен инструментам git_status/git_diff. */
  git?: GitTools;
  /** Открыть файл в редакторе (renderer): нужен инструменту open_file. */
  openFile?(path: string, line?: number, column?: number): Promise<boolean>;
  /** Терминальные сессии (pty): нужны инструментам terminal_*. */
  terminals?: TerminalAgent;
}

/** Ограничение вывода: без него один файл на 2 МБ съест весь контекст модели. */
const MAX_OUTPUT_CHARS = 20_000;
const MAX_SEARCH_HITS = 200;
/** Потолок для режима «только файлы»: там на файл одна строка, поэтому можно больше. */
const MAX_FIND_FILES = 2000;
const MAX_DIR_ENTRIES = 500;
/** Сколько строк отдаёт read_file за один диапазонный вызов. */
const MAX_READ_LINES = 2000;

/** Максимум правок за один вызов: защита от вырожденного ответа модели. */
const MAX_EDITED_FILES = 50;
const MAX_EDITS_PER_FILE = 500;

/** Команда длиннее — это уже не команда, а попытка спрятать скрипт. */
const MAX_COMMAND_CHARS = 2000;

/**
 * Необратимые команды — на них и срабатывает страховка полного доступа
 * (`settings.ai.confirmDangerous`). Список не защита от злого умысла, а страховка
 * от ошибки: цена промаха выше выигрыша от автоматизации. Ловим опасные глаголы
 * в любом месте строки (после `;`, `&&`, `|`), а не только в начале, и намеренно
 * склонны спросить лишний раз: страховка включается вручную, и промах в сторону
 * вопроса дешевле пропущенного `rm -rf`.
 */
const DANGEROUS_COMMAND = new RegExp(
  [
    String.raw`(^|[\s;&|])(sudo|doas|su)\s`,
    String.raw`(^|[\s;&|])(rm|rmdir|shred|wipefs|mkfs\S*|fdisk|sfdisk|parted|shutdown|reboot|poweroff|halt|killall|pkill)\s`,
    String.raw`(^|[\s;&|])dd\s+[^\n]*\bif=`,
    String.raw`>\s*\/dev\/(sd|nvme|hd|disk)`,
    String.raw`>\s*(\/etc\/|\/boot\/|\/usr\/|~?\/?\.ssh\/|~?\/?\.bashrc|~?\/?\.zshrc)`,
    String.raw`:\s*\(\s*\)\s*\{`,
    String.raw`chmod\s+-R\s+(777|666)\s+\/(\s|$)`,
    String.raw`chown\s+-R\s+\S+\s+\/(\s|$)`,
    String.raw`git\s+(push\s+[^\n]*(--force|-f)\b|reset\s+--hard|clean\s+-[a-z]*f[a-z]*d)`,
    String.raw`(curl|wget)\b[^\n|]*\|\s*(ba|z|fi|da)?sh\b`,
    `--no-preserve-root`,
  ].join('|'),
  'i',
);

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND.test(command);
}

/**
 * Спрашивать ли разрешение на команду. Обычный агент спрашивает всегда; при
 * полном доступе — только если включена страховка `confirmDangerous`
 * и команда необратима. По умолчанию страховка выключена, и полный доступ
 * исполняет всё без вопросов.
 */
function needsConfirmation(ctx: ToolContext, command: string): boolean {
  if (!ctx.allowAll) return true;
  return ctx.confirmDangerous === true && isDangerousCommand(command);
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
      case 'read_files':
        return await readFiles(ctx.workspace, parsed.value);
      case 'search':
        return await search(ctx, parsed.value);
      case 'find_files':
        return await findFiles(ctx.workspace, parsed.value);
      case 'get_diagnostics':
        return await diagnostics(ctx, parsed.value);
      case 'apply_edit':
        return await applyEdit(ctx, parsed.value);
      case 'replace_in_files':
        return await replaceInFiles(ctx.workspace, parsed.value);
      case 'run_terminal':
        return await runTerminal(ctx, parsed.value);
      case 'create_file':
        return await createFile(ctx.workspace, parsed.value);
      case 'delete_file':
        return await deleteFile(ctx.workspace, parsed.value);
      case 'move_file':
        return await moveFile(ctx.workspace, parsed.value);
      case 'update_plan':
        // План не исполняется здесь: его показывает service отдельным событием.
        return { ok: true, summary: 'план обновлён' };
      case 'git_status':
        return await gitStatus(ctx);
      case 'git_diff':
        return await gitDiff(ctx, parsed.value);
      case 'git_log':
        return await gitLog(ctx, parsed.value);
      case 'open_file':
        return await openFile(ctx, parsed.value);
      case 'terminal_list':
        return terminalList(ctx);
      case 'terminal_start':
        return await terminalStart(ctx, parsed.value);
      case 'terminal_read':
        return terminalRead(ctx, parsed.value);
      case 'terminal_write':
        return await terminalWrite(ctx, parsed.value);
      case 'terminal_stop':
        return terminalStop(ctx, parsed.value);
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
  const rel = relative(target, workspace.rootPath());
  const allLines = content.text.length === 0 ? [] : content.text.split('\n');
  const total = allLines.length;

  const startLine = optionalInteger(args, 'startLine');
  const endLine = optionalInteger(args, 'endLine');

  // Без диапазона поведение прежнее: файл целиком с обрезкой по символам.
  if (startLine === undefined && endLine === undefined) {
    const { text, truncated } = truncate(content.text);
    return {
      ok: true,
      summary: `${rel}: ${total} строк${truncated ? ' (обрезано)' : ''}`,
      detail: text.length ? text : '(пустой файл)',
      ...(truncated || total === 0 ? {} : { read: { path: target, from: 1, to: total } }),
    };
  }

  if (total === 0) {
    return { ok: true, summary: `${rel}: пустой файл`, detail: '(пустой файл)' };
  }

  const from = Math.max(1, startLine ?? 1);
  const to = Math.min(total, endLine ?? total);
  if (from > total || to < from) {
    return {
      ok: false,
      summary: `${rel}: диапазон ${from}–${to} вне файла`,
      detail: `В файле ${total} строк. Запроси диапазон в пределах 1–${total}.`,
    };
  }

  // Диапазон тоже ограничиваем: модель может попросить «весь файл» через 1–∞.
  const last = Math.min(to, from + MAX_READ_LINES - 1);
  const slice = allLines.slice(from - 1, last);
  const width = String(last).length;
  const body = slice.map((line, index) => `${String(from + index).padStart(width, ' ')} | ${line}`).join('\n');
  const clipped =
    last < to ? `\n… (показаны строки ${from}–${last} из ${to}; продолжай с ${last + 1})` : '';

  // Диапазон тоже режем по символам: 2000 строк по ~40 символов — это ~80 КБ,
  // вчетверо больше общего потолка вывода. Без этого одно чтение диапазона
  // съедало окно модели сильнее, чем чтение целого файла без диапазона.
  const { text: trimmed } = truncate(body);
  // Весь запрошенный кусок ушёл целиком — только тогда его можно считать прочитанным.
  const whole = trimmed === body;

  return {
    ok: true,
    summary: `${rel}: строки ${from}–${last} из ${total}`,
    detail: `${trimmed}${clipped}`,
    ...(whole ? { read: { path: target, from, to: last } } : {}),
  };
}

/** Сколько файлов и сколько символов отдаёт `read_files` за один вызов. */
const MAX_READ_FILES = 10;
const MAX_READ_FILES_TOTAL_CHARS = 60_000;

/**
 * Пакетное чтение: 2–5 файлов за один шаг. Каждый файл получает те же номера
 * строк, что и `read_file`, но общий вывод ограничен — иначе пятёрка больших
 * файлов вытеснит из контекста всё остальное.
 */
async function readFiles(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const raw = args.paths;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Не задан аргумент «paths»: нужен непустой массив путей');
  }
  const paths = raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (paths.length === 0) throw new Error('В «paths» нет ни одного корректного пути');
  if (paths.length > MAX_READ_FILES) {
    throw new Error(`Слишком много файлов за один вызов: ${paths.length} (максимум ${MAX_READ_FILES})`);
  }

  const root = workspace.rootPath();
  const parts: string[] = [];
  const failed: string[] = [];
  let total = 0;
  let read = 0;

  for (const target of paths) {
    const rel = relative(target, root);
    if (total >= MAX_READ_FILES_TOTAL_CHARS) {
      parts.push(`### ${rel}\n… (пропущен: общий лимит вывода исчерпан)`);
      continue;
    }
    try {
      const content = await workspace.readFile(target);
      const lines = content.text.length === 0 ? [] : content.text.split('\n');
      const width = String(lines.length).length;
      const body = lines.map((line, index) => `${String(index + 1).padStart(width, ' ')} | ${line}`).join('\n');
      const { text, truncated } = truncate(body);
      const chunk = `### ${rel} (${lines.length} строк${truncated ? ', обрезано' : ''})\n${text || '(пустой файл)'}`;
      parts.push(chunk);
      total += chunk.length;
      read += 1;
    } catch (error) {
      failed.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const failure of failed) parts.push(`### ошибка\n${failure}`);

  const summaryParts = [`прочитано файлов: ${read}`];
  if (failed.length > 0) summaryParts.push(`ошибок: ${failed.length}`);
  if (total >= MAX_READ_FILES_TOTAL_CHARS) summaryParts.push('вывод обрезан');

  return {
    ok: failed.length < paths.length,
    summary: summaryParts.join(', '),
    detail: parts.join('\n\n'),
  };
}

/* ── замена по проекту ──────────────────────────────────────────────────── */
/** Сколько файлов показывает сводка замены: остальные — числом. */
const MAX_REPLACE_SUMMARY_FILES = 20;

/**
 * Массовая замена по файлам проекта. Идёт в main, как и остальные файловые
 * операции: логика замены чистая (`shared/replace.ts`) и уже проверена.
 * Изменённые файлы возвращаются в `changes` — панель изменений чата их покажет.
 */
async function replaceInFiles(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const query = requireString(args, 'query');
  const replacement = typeof args.replacement === 'string' ? args.replacement : '';
  const result = await workspace.replace({
    query,
    replacement,
    isRegex: optionalBoolean(args, 'isRegex') ?? false,
    caseSensitive: optionalBoolean(args, 'caseSensitive') ?? false,
    glob: optionalString(args, 'glob'),
  });

  if (result.replaced === 0) {
    return {
      ok: true,
      summary: 'ничего не заменено',
      detail: `Вхождений «${query}» не найдено${args.glob ? ` по маске ${args.glob}` : ''}.`,
    };
  }

  const root = workspace.rootPath();
  const shown = result.files.slice(0, MAX_REPLACE_SUMMARY_FILES);
  const lines = shown.map((file) => relative(file, root));
  if (result.files.length > shown.length) lines.push(`… ещё файлов: ${result.files.length - shown.length}`);

  return {
    ok: true,
    summary: `заменено вхождений: ${result.replaced} · файлов: ${result.files.length}`,
    detail: lines.join('\n'),
    changes: result.files.map((file) => ({ path: file, kind: 'modified' as const, replaced: result.replaced })),
  };
}

async function search(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const workspace = ctx.workspace;
  const query = requireString(args, 'query');
  const isRegex = optionalBoolean(args, 'isRegex') ?? false;
  const caseSensitive = optionalBoolean(args, 'caseSensitive') ?? false;
  const filesOnly = optionalBoolean(args, 'filesOnly') ?? false;
  const glob = optionalString(args, 'glob');

  const result = await workspace.search(
    { query, isRegex, caseSensitive, filesOnly, glob, maxResults: filesOnly ? MAX_FIND_FILES : MAX_SEARCH_HITS },
    ctx.signal,
  );
  const root = workspace.rootPath();

  // Режим «только файлы»: одна строка на файл, без номера строки и текста.
  if (filesOnly) {
    const files = [...new Set(result.hits.map((hit) => relativePath(hit.path, root)))];
    return {
      ok: true,
      summary: `совпадения в файлах: ${files.length}${result.truncated ? ' (список обрезан)' : ''} · просканировано: ${result.scanned}`,
      detail: files.length ? truncate(files.join('\n')).text : 'Ничего не найдено',
    };
  }

  const lines = result.hits.map((hit) => `${relativePath(hit.path, root)}:${hit.line}:${hit.column}: ${hit.text}`);

  return {
    ok: true,
    summary: `${result.hits.length} совпадений${result.truncated ? ', список обрезан' : ''} · просканировано файлов: ${result.scanned}`,
    detail: lines.length ? truncate(lines.join('\n')).text : 'Ничего не найдено',
  };
}

/**
 * Файлы по glob-маске. Отдельно от `search`: тут не читается содержимое,
 * поэтому обход дешёвый и результат — список путей.
 */
async function findFiles(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const glob = optionalString(args, 'glob');
  const limit = optionalInteger(args, 'limit') ?? 200;

  const files = await workspace.findFiles(glob, limit);
  return {
    ok: true,
    summary: `${glob ? `«${glob}»: ` : ''}файлов: ${files.length}${files.length >= limit ? ' (обрезано)' : ''}`,
    detail: files.length ? truncate(files.join('\n')).text : 'Ничего не найдено',
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

  // Обычный агент спрашивает всегда; полный доступ — только если включена страховка.
  if (needsConfirmation(ctx, command)) {
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
  // Причёсываем и держим хвост: один `npm install` иначе завалит контекст логом.
  const output = truncateTail(condenseOutput(result.output));
  const notes: string[] = [];
  if (result.timedOut) notes.push('превышено время выполнения');
  if (result.truncated) notes.push('вывод обрезан');

  return {
    ok: result.code === 0 && !result.timedOut,
    summary: `код выхода ${result.code ?? '—'}${notes.length ? ` (${notes.join(', ')})` : ''}`,
    detail: `$ ${command}\n${output.length ? output : '(пустой вывод)'}`,
  };
}

/** История коммитов: read-only контекст «что тут менялось». */
async function gitLog(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.git) return { ok: false, summary: 'Git недоступен' };

  const limit = optionalInteger(args, 'limit') ?? 20;
  const target = optionalString(args, 'path');
  const text = (await ctx.git.logText(limit, target)).trim();

  if (!text) {
    return { ok: true, summary: 'история пуста', detail: 'У репозитория нет коммитов.' };
  }

  const lines = text.split('\n').filter(Boolean);
  return {
    ok: true,
    summary: `коммитов: ${lines.length}${target ? ` по ${path.basename(target)}` : ''}`,
    detail: text,
  };
}

/* ── создание, удаление и перемещение ───────────────────────────────────── */

/** Новый файл. Существующий не перетираем — для этого есть apply_edit. */
async function createFile(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const target = requireString(args, 'path');
  const contents = typeof args.contents === 'string' ? args.contents : '';
  const created = await workspace.createFile(target, contents);
  const lines = contents.length === 0 ? 0 : contents.split('\n').length;
  return {
    ok: true,
    summary: `создан ${relative(created, workspace.rootPath())} (${lines} строк)`,
    detail: `Создан файл ${created}.`,
    changes: [{ path: created, kind: 'created', lines }],
  };
}

/** Удаление только в корзину: безвозвратное rm из IDE — слишком дорогая ошибка. */
async function deleteFile(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const target = requireString(args, 'path');
  await workspace.trash(target);
  return {
    ok: true,
    summary: `в корзину: ${relative(target, workspace.rootPath())}`,
    detail: `Удалено (в корзину): ${target}.`,
    changes: [{ path: target, kind: 'deleted' }],
  };
}

/** Перемещение/переименование. Целевой путь не должен существовать. */
async function moveFile(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const from = requireString(args, 'from');
  const to = requireString(args, 'to');
  const moved = await workspace.rename(from, to);
  const root = workspace.rootPath();
  return {
    ok: true,
    summary: `${relative(from, root)} → ${relative(moved, root)}`,
    detail: `Перемещено: ${from} → ${moved}.`,
    changes: [{ path: moved, kind: 'moved', from }],
  };
}

/* ── git ────────────────────────────────────────────────────────────────── */

/** Буква изменения — как в списке git: M, A, D, R, U (новый), ! (конфликт). */
function gitLetter(change: GitStatus['files'][number]['change']): string {
  switch (change) {
    case 'modified':
      return 'M';
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'untracked':
      return 'U';
    case 'conflicted':
      return '!';
    default:
      return '?';
  }
}

const MAX_GIT_FILES = 200;

/** Состояние репозитория: ветка, синхронизация и список изменённых файлов. */
async function gitStatus(ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.git) return { ok: false, summary: 'Git недоступен' };

  const status = await ctx.git.status();
  const repo = status.repository;
  if (!repo) {
    return { ok: true, summary: 'не git-репозиторий', detail: 'Рабочая папка не лежит внутри git-репозитория.' };
  }

  const where = repo.branch
    ? `ветка ${repo.branch}`
    : repo.detached
      ? `отделённый HEAD ${repo.head ?? ''}`.trim()
      : 'репозиторий без коммитов';
  const sync = [repo.ahead > 0 ? `впереди ${repo.ahead}` : '', repo.behind > 0 ? `позади ${repo.behind}` : ''].filter(Boolean).join(', ');

  if (status.files.length === 0) {
    return { ok: true, summary: `${where}: изменений нет`, detail: 'Рабочее дерево чистое.' };
  }

  const shown = status.files.slice(0, MAX_GIT_FILES);
  const lines = shown.map((file) => `${gitLetter(file.change)} ${file.staged ? '[индекс]' : '[ ]     '} ${file.relative}`);
  if (status.files.length > shown.length) lines.push(`… ещё файлов: ${status.files.length - shown.length}`);

  return {
    ok: true,
    summary: `${where}: ${status.files.length} изменённых файлов${sync ? ` (${sync})` : ''}`,
    detail: lines.join('\n'),
  };
}

/** Diff файла в формате git: `+`/`-` строки, как в терминале. */
async function gitDiff(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.git) return { ok: false, summary: 'Git недоступен' };

  const target = requireString(args, 'path');
  const staged = optionalBoolean(args, 'staged') ?? false;
  const diff = await ctx.git.diffText(target, staged);
  const rel = relative(target, ctx.workspace.rootPath());

  if (!diff.trim()) {
    return { ok: true, summary: `${rel}: нет изменений`, detail: 'git не показал различий для этого файла.' };
  }

  const { text } = truncate(diff);
  return { ok: true, summary: `diff ${rel}${staged ? ' (индекс)' : ''}`, detail: text };
}

/* ── открытие файла в редакторе ─────────────────────────────────────────── */

/** Открывает файл в renderer: вкладка и позиция — дело интерфейса, не ФС. */
async function openFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.openFile) {
    return { ok: false, summary: 'Открытие файла недоступно: окно редактора не подключено' };
  }

  const target = requireString(args, 'path');
  const line = optionalInteger(args, 'line');
  const column = optionalInteger(args, 'column');
  await ctx.openFile(target, line, column);

  const rel = relative(target, ctx.workspace.rootPath());
  return { ok: true, summary: `открыт ${rel}${line ? `:${line}` : ''}`, detail: 'Файл открыт в редакторе.' };
}

/* ── терминальные сессии (pty) ──────────────────────────────────────────── */

/** ANSI-последовательности и возврат каретки модели не нужны: оставляем текст. */
function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '') // OSC-титул
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI-цвета и курсор
    .replace(/\r/g, '');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Отменено'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Отменено'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function terminalList(ctx: ToolContext): ToolOutcome {
  if (!ctx.terminals) return { ok: false, summary: 'Терминал недоступен' };
  const sessions = ctx.terminals.list();
  if (sessions.length === 0) {
    return { ok: true, summary: 'открытых терминалов нет', detail: 'Список пуст. Открой сессию через terminal_start.' };
  }
  const lines = sessions.map((session) => `${session.id} · ${session.shell} · ${session.cwd} (pid ${session.pid})`);
  return { ok: true, summary: `терминалов: ${sessions.length}`, detail: lines.join('\n') };
}

const TERMINAL_COLS = 120;
const TERMINAL_ROWS = 30;
/** Сколько ждём первый вывод после старта/команды, прежде чем вернуть управление. */
const TERMINAL_SETTLE_MS = 700;

async function terminalStart(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.terminals) return { ok: false, summary: 'Терминал недоступен' };

  const cwd = optionalString(args, 'cwd') ?? ctx.workspace.rootPath() ?? undefined;
  const command = optionalString(args, 'command');
  if (command && command.length > MAX_COMMAND_CHARS) {
    throw new Error(`Команда длиннее ${MAX_COMMAND_CHARS} символов`);
  }

  // Обычный агент спрашивает всегда; полный доступ — только если включена страховка.
  if (command && needsConfirmation(ctx, command)) {
    if (!ctx.confirmCommand) return { ok: false, summary: 'Запуск команд недоступен' };
    const allowed = await ctx.confirmCommand(command);
    if (!allowed) {
      return {
        ok: false,
        summary: 'Пользователь запретил команду',
        detail: 'Не повторяй эту команду — предложи другое решение.',
      };
    }
  }

  const session = await ctx.terminals.create({ cols: TERMINAL_COLS, rows: TERMINAL_ROWS, cwd });
  if (command) ctx.terminals.write(session.id, `${command}\r`);

  await delay(TERMINAL_SETTLE_MS, ctx.signal);
  const { data, offset, alive } = ctx.terminals.read(session.id, 0);
  // Причёсывание снимает пустые простыни, обрезка держит хвост: у сборки и логов
  // важен последний вывод, а один большой cat иначе съедает всё окно модели.
  const output = truncateTail(condenseOutput(stripAnsi(data)));

  return {
    ok: true,
    summary: `сессия ${session.id}${command ? `: ${command}` : ''}`,
    detail: [
      `id: ${session.id}`,
      `cwd: ${session.cwd}`,
      `offset: ${offset}`,
      `alive: ${alive}`,
      '',
      output || '(пока пусто)',
    ].join('\n'),
  };
}

function terminalRead(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  if (!ctx.terminals) return { ok: false, summary: 'Терминал недоступен' };

  const id = requireString(args, 'id');
  const from = optionalInteger(args, 'from') ?? 0;
  const { data, offset, alive, exitCode } = ctx.terminals.read(id, from);
  // Как в terminal_start: хвост важнее начала, пустые простыни сжимаем.
  const output = truncateTail(condenseOutput(stripAnsi(data)));

  return {
    ok: true,
    summary: `${id}: ${output ? `${output.split('\n').length} строк нового вывода` : 'нового вывода нет'}${alive ? '' : ' (процесс завершён)'}`,
    detail: [
      `offset: ${offset}`,
      `alive: ${alive}${exitCode !== undefined ? ` (код ${exitCode})` : ''}`,
      '',
      output || '(нового вывода нет)',
    ].join('\n'),
  };
}

async function terminalWrite(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.terminals) return { ok: false, summary: 'Терминал недоступен' };

  const id = requireString(args, 'id');
  const data = requireString(args, 'data');

  // Ввод в терминал может быть чем угодно — страховка ловит необратимое и здесь.
  if (needsConfirmation(ctx, data)) {
    if (!ctx.confirmCommand) return { ok: false, summary: 'Ввод в терминал недоступен' };
    const allowed = await ctx.confirmCommand(`[${id}] ${data.replace(/\n/g, '⏎')}`);
    if (!allowed) return { ok: false, summary: 'Пользователь запретил ввод', detail: 'Ввод отклонён.' };
  }

  ctx.terminals.write(id, data);
  return {
    ok: true,
    summary: `отправлено в ${id}`,
    detail: `В сессию ${id} отправлено символов: ${data.length}. Прочитай вывод через terminal_read.`,
  };
}

function terminalStop(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  if (!ctx.terminals) return { ok: false, summary: 'Терминал недоступен' };

  const id = requireString(args, 'id');
  ctx.terminals.kill(id);
  return { ok: true, summary: `${id} остановлен`, detail: `Сессия ${id} остановлена.` };
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

/**
 * Причесать вывод процесса перед отправкой модели: снять хвостовые пробелы и
 * сжать простыни пустых строк. В логах сборки и тестов их много, а смысла они не
 * несут — только жгут токены. Оформление по краям тоже убираем: это не содержание.
 */
function condenseOutput(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Обрезка с конца: у вывода терминала и команд важнее последние строки — начало
 * (приветствие, старая сборка) модели уже не нужно. Оставляем хвост и говорим,
 * сколько символов отброшено, чтобы она знала, что видит не весь вывод.
 */
function truncateTail(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const dropped = text.length - limit;
  return `… (отброшено символов в начале: ${dropped})\n${text.slice(dropped)}`;
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

function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}
