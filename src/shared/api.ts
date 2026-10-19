/**
 * Единственный контракт между main- и renderer-процессами.
 *
 * Здесь: каналы IPC, доменные типы и таблица RPC-методов (ChuiMethods).
 * Файл попадает и в Node, и в браузер, поэтому импортировать сюда electron/node нельзя.
 */

import type { MenuRole } from './app-menu';
import type { CursorStyle } from './cursor-style';
import type { ApplyResult, FileEdit, TextEdit } from './edits';
import type { BlameLine } from './git-blame';
import type { PatchFile } from './patch';
import type { ProjectScan } from './project-scan';
import type { ProjectSettings } from './project-config';
import type { AutoSaveMode } from './auto-save';
import type { IconBadgeRule } from './icon-badges';
import type { Snippet } from './snippets';
import type { ReviewThread } from './review';
import type { HistoryEntry } from './file-history';
import type { BookmarkRecord } from './bookmarks';
import type { FileLabelRecord } from './file-labels';
import type { GitLfsInfo } from './git-lfs';
import type { GitSparseInfo } from './git-sparse';
import type { GitIdentity, GitSshKey } from './git-identity';
import type { WorkspaceRoot } from './workspace-roots';
import type { LspStatus } from './lsp-status';
import type { InheritedResult, SymbolIndexStatus } from './symbol-index';
import type { LineProfile } from './line-profile';
import type { SemanticToken } from './lsp-semantic-tokens';
import type { FolderCompareResult } from './folder-compare';
import type { StructuralProjectMatches, StructuralProjectOptions } from './structural-search';
import type { ExportsQuery, ExportsResult } from './symbol-exports';
import type { InheritanceQuery, InheritanceResult } from './type-inheritance';
import type { ProjectPackage } from './monorepo';
import type { ProjectCommand } from './commands';
import type { ChatTitleParts } from './chat-title';
import type { PermissionPreset } from './permissions';
import type { ForgeComment, ForgeInfo, ForgeIssue, ForgeNotification, ForgePipeline } from './git-platform';
import type { GitReflogEntry } from './git-reflog';
import type { GitStashEntry } from './git-stash';
import type { GitTag } from './git-tags';
import type { RebaseTodoItem } from './git-rebase';
import type { PullMode } from './git-pull';
import type { GitRefDiff } from './git-ref-diff';
import type { GitRootFetch, GitRootSummary } from './git-multiroot';
import type { CommitPromptParts } from './commit-message';
import type { TestPromptParts } from './test-generation';
import type { GitBisectState } from './git-bisect';
import type { GitSubmodule } from './git-submodules';
import type { GitWorktree } from './git-worktrees';
import type { ThemeFile } from './theme-file';
import type { NodeEnvironmentHealth, NodeInfo, NodePackage } from './node-env';
import type { NodeTestSuite } from './node-tests';
import type { PythonEnvironment, PythonInterpreter, VenvLocation, VenvLookup } from './python-env';
import type { InstalledPackage } from './python-packages';
import type { CollectedSuite } from './python-tests';
import type { EnvironmentHealth } from './python-health';
import type { ProjectSymbol } from './lsp-symbols';
import type { McpServerConfig } from './mcp';
import type { WebSearchProvider } from './web-search';
import type { AiSandboxSettings } from './sandbox';
import type { WhitespaceMode } from './whitespace';
import type { KeybindingSettings } from './keybindings';
import type { ProjectKind } from './project-kinds';
import type { ScheduleResult, TaskSchedule } from './scheduling';
import type { ChatRunLog } from './run-log';
import type { ReviewVerdict } from './approval-review';

/* ── Каналы IPC ─────────────────────────────────────────────────────────── */

export const RPC_CALL_CHANNEL = 'chui:rpc:call';
export const RPC_EVENT_CHANNEL = 'chui:rpc:event';
export const RPC_CANCEL_CHANNEL = 'chui:rpc:cancel';
export const PUSH_CHANNEL = 'chui:push';

/**
 * Служебное событие стрима: все события вызова уже отправлены.
 *
 * События идут отдельным каналом от ответа на вызов, и порядок между ними
 * не обещан: ответ на `invoke` нередко обгоняет последние `send`. Без метки
 * «больше ничего не будет» renderer не отличит «ответ пришёл, событий больше
 * нет» от «ответ пришёл, а события ещё в пути» — и последний кусок ответа
 * модели терялся в ленте.
 */
export const RPC_EVENT_END = '__end__';

/** Обратный вызов: main просит renderer выполнить действие и ждёт ответа. */
export const HOST_REQUEST_CHANNEL = 'chui:host:request';
export const HOST_REPLY_CHANNEL = 'chui:host:reply';

/** Темы широковещательных уведомлений main → renderer. */
export const PushTopic = {
  WorkspaceChanged: 'workspace:changed',
  GitChanged: 'git:changed',
  GitSummary: 'git:summary',
  SettingsChanged: 'settings:changed',
  MenuCommand: 'menu:command',
  TerminalData: 'terminal:data',
  TerminalExit: 'terminal:exit',
  ThemeChanged: 'theme:changed',
  WindowStateChanged: 'window:state',
  LspDiagnostics: 'lsp:diagnostics',
  LspProgress: 'lsp:progress',
  DebugState: 'debug:state',
  DebugStopped: 'debug:stopped',
  DebugOutput: 'debug:output',
  BrowserNav: 'browser:nav',
  /** Задача расписания дождалась своего времени: renderer начинает ход. */
  ScheduleDue: 'schedule:due',
  /** Проверка модели разрешила команду без человека: в ленте строка «разрешено проверкой». */
  ApprovalReview: 'approval:review',
} as const;

/* ── Транспорт ──────────────────────────────────────────────────────────── */

export interface RpcCall {
  id: string;
  method: string;
  params: unknown;
  /** Долгий вызов с событиями: main отметит конец событий меткой `RPC_EVENT_END`. */
  stream?: boolean;
}

export interface RpcError {
  code: number;
  message: string;
  details?: string;
}

export type RpcResult = { id: string; ok: true; value: unknown } | { id: string; ok: false; error: RpcError };

/** Событие внутри одного RPC-вызова: стриминг токенов, прогресс, лог. */
export interface RpcEventMessage {
  id: string;
  event: string;
  payload: unknown;
}

export interface PushMessage {
  topic: string;
  payload: unknown;
}

/**
 * Запрос main → renderer. Нужен там, где действие живёт только в renderer:
 * правка документа обязана идти через документную модель, undo и ревью.
 */
export interface HostRequest {
  id: string;
  method: string;
  params: unknown;
}

export type HostReply = { id: string; ok: true; value: unknown } | { id: string; ok: false; error: RpcError };

export const RpcErrorCode = {
  Cancelled: -32800,
  InvalidParams: -32602,
  MethodNotFound: -32601,
  Internal: -32603,
  NotFound: -32001,
  /** Возможность выключена в настройках (например, ассистент целиком). */
  Disabled: -32002,
} as const;

/* ── Приложение ─────────────────────────────────────────────────────────── */

export interface AppInfo {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
}

/* ── Файловая система ───────────────────────────────────────────────────── */

export type EntryKind = 'file' | 'directory' | 'symlink';

/** Вид, на который указывает символическая ссылка: файл это или папка. */
export type SymlinkTarget = 'file' | 'directory';

/** Куда ведёт символическая ссылка и что там лежит. Есть только при `kind === 'symlink'`. */
export interface SymlinkInfo {
  /** Цель ссылки: путь, куда она ведёт (у битой — сам текст ссылки). */
  target: string;
  /** Что лежит по цели: папка или файл. */
  kind: SymlinkTarget;
  /** Цель не найдена — ссылка «битая». */
  broken: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number;
  /** Время последней правки, мс. Нужно сортировке «по времени изменения». */
  mtimeMs: number;
  /**
   * Куда ведёт символическая ссылка и что там лежит. Задано только при
   * `kind === 'symlink'`: по этому видно, раскрывать запись как папку, открывать как
   * файл или не трогать вовсе (битая ссылка). Смысл полей — в `shared/entry-kind.ts`.
   */
  symlink?: SymlinkInfo;
}

export interface FileStat {
  path: string;
  kind: EntryKind;
  size: number;
  mtimeMs: number;
}

export interface FileContent {
  text: string;
  mtimeMs: number;
  /** Размер файла в байтах: по нему редактор решает, открывать ли только для чтения. */
  size: number;
  /** Файл большой и открывается только для чтения (см. `shared/large-file.ts`). */
  readOnly: boolean;
}

export interface WorkspaceInfo {
  /** Активный корень области: им отвечают операции без явного пути. */
  root: string;
  name: string;
  /** Записи активного корня. */
  entries: DirEntry[];
  /** Все корни рабочей области: их может быть несколько (см. `shared/workspace-roots.ts`). */
  roots: WorkspaceRoot[];
}

export interface SearchOptions {
  query: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
  glob?: string;
  /** Искать только внутри этой папки (или файла). Без неё — по всему проекту. */
  path?: string;
  /** Только имена файлов с совпадением, без строк — обзор «где это встречается». */
  filesOnly?: boolean;
  /**
   * Строк контекста вокруг совпадения — как `-A`/`-B` у grep. 0 или не задано —
   * только строка совпадения. С контекстом навигация не требует отдельного
   * `read_file` и экономит шаг агента.
   */
  context?: number;
}

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  text: string;
  /** Строки до совпадения (только при `context` в запросе), ближняя — последняя. */
  before?: string[];
  /** Строки после совпадения (только при `context`), ближняя — первая. */
  after?: string[];
}

export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
  scanned: number;
}

export interface ReplaceFilesOptions {
  query: string;
  replacement: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  /** Маска пути: замена только в подходящих файлах (`**` — любая глубина). */
  glob?: string;
}

export interface ReplaceFilesResult {
  /** Абсолютные пути файлов, в которых что-то заменилось. */
  files: string[];
  /** Сколько вхождений заменено всего. */
  replaced: number;
}
/* ── Окно ─────────────────────────────────────────────────────────────── */

/** Состояние окна нужно своей рамке: без неё не понять, что рисовать в кнопках. */
export interface WindowState {
  maximized: boolean;
  fullScreen: boolean;
  platform: string;
  /** На macOS остаются системные «светофоры», свои кнопки не нужны. */
  customControls: boolean;
}
/* ── Терминал ───────────────────────────────────────────────────────────── */

export interface TerminalSession {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  pid: number;
}

export interface TerminalCreateOptions {
  cols: number;
  rows: number;
  cwd?: string;
}

/**
 * Сессия рабочей папки: что было открыто в прошлый раз. Восстанавливается
 * при открытии проекта, чтобы не собирать рабочее место заново.
 */
export interface SessionState {
  /** Абсолютные пути открытых вкладок в порядке слева направо. */
  tabs: string[];
  /** Активная вкладка — если она ещё входит в `tabs`. */
  activeTab?: string;
  /** Абсолютные пути раскрытых папок дерева. */
  expanded: string[];
  /** Закреплённые в дереве файлы и папки: показываются блоком сверху. */
  pinned?: string[];
  /**
   * Корни рабочей области (когда папок в окне несколько): первый — активный.
   * Хранится, чтобы рабочая область из нескольких папок пережила перезапуск.
   */
  roots?: string[];
  /** Какая вкладка нижней панели открыта: `terminal`, `search`, `git`. */
  dockActive?: string;
  /** Параметры запуска отладки: аргументы, окружение и рабочий каталог. */
  debugLaunch?: DebugLaunchOptions;
  /** Наблюдаемые в панели отладки выражения. */
  debugWatch?: string[];
  /** Останов по исключению: какие исключения останавливали программу. */
  debugExceptions?: DebugExceptionFilters;
  /** Точки останова отладки по файлам — их рабочее место помнит для проекта. */
  breakpoints?: BreakpointRecord[];
  /** Закладки: строки файлов, к которым человек возвращается. */
  bookmarks?: BookmarkRecord[];
  /** Метки файлов в дереве: цветные ярлыки («в работе», «срочно»). */
  labels?: FileLabelRecord[];
  /** Где стоял курсор в каждом открытом файле (1-based). */
  cursors?: Record<string, CursorPosition>;
  /** Записанный макрос: шаги записывает и разбирает редактор (`shared/macro.ts`). */
  macro?: unknown[];
  /**
   * Несохранённые правки: текст буферов, которые человек не успел сохранить
   * («hot exit»). При следующем открытии проекта они возвращаются как есть —
   * файл на диске при этом не трогается.
   */
  unsaved?: UnsavedBuffer[];
}

/** Текст несохранённого буфера: путь файла и правленое содержимое. */
export interface UnsavedBuffer {
  path: string;
  text: string;
}

/** Позиция курсора в файле (1-based) - как её считает редактор. */
export interface CursorPosition {
  line: number;
  column: number;
}

/**
 * Точка останова в сессии проекта: файл, строка и её настройки. Похожа на
 * `DebugBreakpoint`, но без `verified`: подтверждает точку отладчик, а в сессии
 * хранится только то, что задал человек.
 */
export interface BreakpointRecord {
  /** Абсолютный путь файла. */
  path: string;
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

/** Полезная нагрузка события `PushTopic.WorkspaceChanged`. */
export interface WorkspaceChangedPayload {
  /** Корень рабочей папки — он же ключ, по которому событие адресуется. */
  root: string;
  /** Что именно изменилось: путь файла или папки. */
  path: string;
  /**
   * Изменилось сразу много файлов, а не один: переключение ветки, `git stash pop`,
   * `merge`, массовое форматирование, правка агентом по всему проекту. Тогда `path` —
   * это корень, а не конкретный файл, и потребителю нужен общий пересчёт, а не
   * точечный: одного пути из потока событий недостаточно (остальные потерялись бы).
   */
  many?: boolean;
}

/** Полезная нагрузка события `PushTopic.TerminalData`. */
export interface TerminalDataPayload {
  id: string;
  data: string;
}

/** Полезная нагрузка события `PushTopic.TerminalExit`. */
export interface TerminalExitPayload {
  id: string;
  exitCode: number;
  signal?: number;
}

/**
 * Прямоугольник области страницы в координатах окна.
 *
 * Вложение рисует не DOM, а сам Chromium отдельным слоем окна, поэтому его место
 * задаётся числами: renderer меряет область редактора и присылает сюда результат.
 */
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Состояние вкладки встроенного браузера: то, чем живёт адресная строка и кнопки. */
export interface BrowserNavState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /**
   * Масштаб страницы: 1 — 100 %. Не часть адреса, а состояние вкладки: оно живёт
   * в самом вложении и меняется кнопками шапки, Ctrl+колесом и агентом.
   */
  zoom: number;
  /** Причина неудачи загрузки — показывается человеком словами, а не кодом. */
  error?: string;
}

/** Как менять масштаб страницы: шаг туда-обратно, вписать по ширине или 1:1. */
export type BrowserZoomMode = 'in' | 'out' | 'fit' | 'actual';

/**
 * Элемент страницы, выбранный мышью для вопроса в чате.
 *
 * Собирается на самой странице (см. `panel.ts`): в renderer'е нет ни доступа к
 * DOM гостя, ни возможности что-то в нём подсветить — страница лежит отдельным
 * слоем окна. Поэтому всё, что можно сказать об элементе, приходит готовым.
 */
export interface BrowserPickedElement {
  /** Имя тега маленькими буквами: `button`, `input`, `div`. */
  tag: string;
  /** Путь до элемента: `main.form > input#email`. Короткий, но однозначный. */
  selector: string;
  /** Что написано на элементе или в его `aria-label`: подпись для чипа в чате. */
  name: string;
  /** Роль из `role`; пусто — роль выводится из тега. */
  role: string;
  /** Видимый текст элемента (обрезанный). */
  text: string;
  /** Разметка элемента (обрезанная): без неё непонятно, как он устроен. */
  html: string;
  /** Значимые вычисленные стили: то, что обычно и правят в вёрстке. */
  styles: Record<string, string>;
  /** Где он на странице (в CSS-пикселях, до масштаба). */
  rect: BrowserRect;
}

/**
 * Полезная нагрузка события `PushTopic.BrowserNav`: вложение сообщило о себе.
 *
 * Виды разные по смыслу, а не по оттенку одного: состояние вкладки, просьба
 * страницы о новой вкладке, страница, которую открыл агент, закрытие и общий
 * доступ. Объединять их в один объект с необязательными полями значило бы
 * заставлять renderer угадывать смысл события по тому, какие поля оказались
 * заполнены.
 */
export type BrowserEventPayload =
  /** Состояние активной вкладки: им живут адресная строка и кнопки. */
  | ({ kind: 'state'; id: string } & BrowserNavState)
  /** Страница просит новую вкладку (`_blank`, `window.open`): вторых окон у нас нет. */
  | { kind: 'newTab'; id: string; url: string }
  /** Страницу открыл агент: вкладку заводит renderer, а ключ вкладки дал main. */
  | { kind: 'opened'; id: string; url: string }
  /** Агент закончил работу — вкладку убираем вместе с вложением. */
  | { kind: 'closed'; id: string }
  /** Человек поделился вкладкой с ассистентом: агент работает в этой же странице. */
  | { kind: 'shared'; id: string }
  /** Общий доступ снят (отозван или вкладка закрыта): агент снова заводит свою. */
  | { kind: 'unshared'; id: string }
  /**
   * Агент действует на вкладке: нажал, ввёл текст, выполнил скрипт, открыл адрес.
   * Человек должен видеть, что страница под его руками живёт не только от него.
   */
  | { kind: 'agent'; id: string; action: string };

/** Действие над вкладкой браузера, которое renderer просит выполнить main. */
export type BrowserAction = 'back' | 'forward' | 'reload' | 'stop' | 'navigate' | 'devtools';

/* ── Git ───────────────────────────────────────────────────────────────── */

/** Как git помечает файл в статусе. Коды porcelain приведены к домену. */
export type GitChange = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface GitFileStatus {
  /** Абсолютный путь — по нему UI находит файл в дереве проекта. */
  path: string;
  /** Путь от корня репозитория: в таком виде его понимает git. */
  relative: string;
  change: GitChange;
  /** Правка лежит в индексе, то есть попадёт в коммит. */
  staged: boolean;
  /** Есть незакоммиченные правки в рабочем дереве. */
  unstaged: boolean;
}

export interface GitRepository {
  root: string;
  /** Ветка; null — если HEAD оторван (detached HEAD). */
  branch: string | null;
  detached: boolean;
  /** Короткий хеш HEAD. */
  head: string | null;
  ahead: number;
  behind: number;
}

export interface GitStatus {
  /** null — рабочая папка не лежит внутри репозитория. */
  repository: GitRepository | null;
  files: GitFileStatus[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
}

/**
 * Diff того, что попадёт в коммит: чем кормить модель для сообщения коммита.
 * `diff` уже обрезан по размеру (потолок — в `shared/commit-message.ts`), `truncated`
 * говорит, что картина неполная, а `untracked` — новые файлы: их содержимого в
 * `git diff` нет, но названия о правке говорят.
 */
export interface GitCommitDiff {
  diff: string;
  /** Правки проиндексированы: diff — индекс против HEAD, иначе рабочее дерево против индекса. */
  staged: boolean;
  /** Обрезан ли diff по размеру. */
  truncated: boolean;
  /** Сколько файлов с правками попадает в коммит. */
  files: number;
  /** Новые файлы: в diff их нет, показываем именами. */
  untracked: string[];
}

/** Ответ «сообщение коммита по diff»: текст, готовый лечь в поле сообщения. */
export interface CommitMessageResult {
  message: string;
}

/** Ответ «тест к выделенному коду»: код теста, готовый лечь в файл. */
export interface TestGenerationResult {
  code: string;
}

/**
 * Название беседы от модели. Пустая строка — названия нет: вкладка останется с
 * заголовком по первому вопросу, и это нормальный вид, а не сбой.
 */
export interface ChatTitleResult {
  title: string;
}

/**
 * Блоки изменений одного файла — для действий прямо из жёлоба редактора.
 *
 * Два набора, потому что строки, по которым щёлкают в редакторе, согласуются с
 * рабочим деревом: правки, ещё не попавшие в индекс, ищутся в `unstaged` (рабочее
 * дерево против индекса), уже проиндексированные — в `staged` (индекс против HEAD).
 * Границы — как в `shared/git-hunks.ts`, номера блоков годятся для `git apply`.
 */
export interface GitFileHunks {
  /** Блоки вне индекса: их можно проиндексировать или откатить. */
  unstaged: GitDiffHunk[];
  /** Блоки в индексе: их можно убрать из индекса. */
  staged: GitDiffHunk[];
}

/** Границы блока изменений в сравнении: по строкам старой и новой версий. */
export interface GitDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface GitDiff {
  /** С чем сравниваем: HEAD или индекс. */
  original: string;
  /** Что сравниваем: индекс или рабочее дерево. */
  modified: string;
  /**
   * Блоки изменений в порядке файла: по ним интерфейс ставит у каждого свою
   * кнопку «проиндексировать блок». Границы совпадают с теми, что приложил бы
   * `git apply`, поэтому номер блока из этого списка годится и в main.
   */
  hunks: GitDiffHunk[];
}

export interface GitCommitInfo {
  hash: string;
  summary: string;
}

/**
 * Итог операции с историей (rebase). Rebase — не одна команда: он может
 * остановиться на конфликте или на шаге `edit`. Поэтому ответ несёт не только
 * «получилось», но и текст git, и признак того, что rebase ещё идёт и ждёт человека.
 */
export interface GitRebaseResult {
  /** Завершился ли rebase целиком (без останова на конфликте или `edit`). */
  ok: boolean;
  /** Идёт ли rebase прямо сейчас: нужно остановиться, разрешить и продолжить. */
  inProgress: boolean;
  /** Есть ли неразрешённые конфликты: тогда правки надо свести руками. */
  conflict: boolean;
  /** Словами git: что он сделал или на чём споткнулся. */
  message: string;
  status: GitStatus;
}

/**
 * Три версии файла из конфликта слияния: общий предок и две стороны.
 * Пустая строка — соответствующего объекта в индексе нет (например, файл
 * добавлен только одной стороной: у него нет ни базы, ни второй стороны).
 */
export interface GitConflictParts {
  /** Общий предок (стадия 1). */
  base: string;
  /** Наша версия (стадия 2, HEAD). */
  ours: string;
  /** Их версия (стадия 3, входящая ветка). */
  theirs: string;
}

/** Один коммит из истории: то, что нужно списку, без тела сообщения и диффа. */
export interface GitCommit {
  /** Короткий хеш (7 символов), как его печатает git. */
  hash: string;
  author: string;
  /** Дата коммита, `ГГГГ-ММ-ДД`. */
  date: string;
  summary: string;
  /**
   * Время коммита в миллисекундах эпохи. По нему лента истории файла ставит коммиты
   * и локальные снимки в один порядок (см. `shared/timeline.ts`); у старых ответов
   * поля нет — тогда берём дату.
   */
  at?: number;
}

/** Удалённый репозиторий: как он назван в `git remote` и куда ведут адреса. */
export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

/**
 * Итог операции с внешним репозиторием (fetch/pull/push). Сбой не бросаем: сеть,
 * авторизация и конфликты — обычные ответы, а не исключения, поэтому `ok` и текст
 * от git едут вместе. Свежий статус — рядом: после операции состояние изменилось.
 */
export interface GitNetworkResult {
  ok: boolean;
  message: string;
  status: GitStatus;
}

/** Строка в списке недавних: путь, имя и признак того, что папка ещё существует. */
export interface RecentProject {
  path: string;
  name: string;
  exists: boolean;
}

/** Событие прогресса `git.clone`: строки, которые git пишет в прогресс-вывод. */
export const CloneEvent = {
  Progress: 'progress',
} as const;

/** Событие прогресса `python.createVenv`: шаги и вывод команд. */
export const VenvEvent = {
  Progress: 'venv:progress',
} as const;

/** Полезная нагрузка события `CloneEvent.Progress`. */
export interface CloneProgressPayload {
  line: string;
}

/* ── Настройки ──────────────────────────────────────────────────────────── */

/**
 * Сколько модель думает перед ответом — «thinking effort» из интерфейса.
 * `off` означает «параметр не отправлять»: у большинства моделей его нет вовсе,
 * и подставлять туда что-то своё было бы выдумкой.
 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

/** Провайдер в том виде, в каком его видит renderer: без ключа, только факт наличия. */
export interface AiProviderView {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  defaultModel?: string;
  hasApiKey: boolean;
  /** Протокол общения: OpenAI-совместимый (по умолчанию) или нативный Anthropic. */
  protocol?: 'openai' | 'anthropic';
}

export interface AiSettings {
  /** Общий выключатель ассистента: `false` глушит AI целиком. */
  enabled: boolean;
  providers: AiProviderView[];
  activeProviderId?: string;
  activeModel?: string;
  temperature: number;
  maxTokens: number;
  /**
   * Размер контекстного окна модели в токенах. Не задан — определяем по имени
   * модели (`contextWindow` в shared/providers.ts); задан — берём как есть.
   */
  contextWindow?: number;
  /**
   * Абсолютный предел истории в токенах: выше него беседа сжимается автоматически,
   * даже если до конца окна ещё далеко. 0 — сжимать только при подходе к окну.
   */
  compactAtTokens: number;
  /**
   * Модель для сжатия беседы. Не задана — сжимаем той же моделью, что и беседа.
   * Пересказ — задача простая: небольшая модель справится дешевле и не займёт
   * окно основной.
   */
  compactModel?: string;
  systemPrompt: string;
  /** Сколько модели думать перед ответом (`reasoning_effort`). */
  reasoningEffort: ReasoningEffort;
  /**
   * Страховка от зацикливания: сколько шагов «модель → инструмент → модель»
   * агент делает в обычном режиме, прежде чем остановиться.
   */
  maxSteps: number;
  /** То же при полном доступе: задача длиннее, шагов нужно больше. */
  maxAutopilotSteps: number;
  /**
   * Даже при полном доступе спрашивать перед необратимыми командами (удаление,
   * запись на диск, sudo, `git push --force`). По умолчанию выключено: «полный
   * доступ» остаётся полным. Включается галочкой в настройках.
   */
  confirmDangerous: boolean;
  /**
   * Спрашивать модель перед подтверждением команды.
   *
   * Работает в режимах, где подтверждение вообще бывает: безобидные команды
   * (`ls`, `git status`, сборка) выполняются сами, а всё остальное — сомнительное,
   * меняющее файлы, ходящее в сеть — по-прежнему спрашивает человека. Необратимые
   * команды проверка не трогает вообще.
   */
  approvalReview: boolean;
  /**
   * Модель для проверки команд. Не задана — проверяет активная модель беседы.
   * Отдельная нужна потому, что здесь достаточно дешёвой.
   */
  reviewModel?: string;
  /**
   * Сжимать вывод инструментов перед отправкой модели: убрать прогресс-бары,
   * служебные последовательности терминала, повторы одинаковых строк и простыни
   * пустых строк. Содержание — код, диффы, ошибки — не трогается: в карточке
   * инструмента человек всё равно видит полный вывод.
   */
  compressOutput: boolean;
  /** Веб-поиск: выключен по умолчанию, инструмент предлагается только при включении. */
  webSearch: AiWebSearchSettings;
  /** Чтение страниц по ссылке: отдельный выключатель, тоже выключен по умолчанию. */
  webFetch: AiWebFetchSettings;
  /** Браузерная автоматизация: выключена по умолчанию, как и веб-поиск. */
  browser: AiBrowserSettings;
  /** Песочница: команды агента идут в контейнер, а не на машину пользователя. */
  sandbox: AiSandboxSettings;
  /**
   * Серверы внешних инструментов (MCP). Пусто — агент работает только своими
   * инструментами. Команду запуска задаёт человек: модель её не меняет.
   */
  mcpServers: McpServerConfig[];
  /** Подсказка «допиши за меня» (inline-автодополнение). Выключена по умолчанию. */
  inlineCompletion: AiInlineCompletionSettings;
}

/**
 * Inline-автодополнение (как Copilot): модель дописывает код прямо в месте
 * курсора. Каждый такой запрос — обращение к модели (то есть время и деньги),
 * поэтому выключено по умолчанию и имеет задержку перед запросом.
 */
export interface AiInlineCompletionSettings {
  enabled: boolean;
  /** Пауза после последнего ввода перед запросом, мс: на каждую букву не спрашиваем. */
  debounceMs: number;
}

/**
 * Настройки редактора. Здесь только то, что читает своё ядро редактора
 * (`src/renderer/editor/`). Липкий заголовок и раскраска скобок включены всегда и
 * настройки не имеют — переключать их незачем; направляющие столбцов задаются
 * списком.
 */
export interface EditorSettings {
  tabSize: number;
  /** Кегль текста в редакторе, px. */
  fontSize: number;
  /** Высота строки в px; `0` — «по шрифту» (авто, 1.4 от кегля). */
  lineHeight: number;
  /** Форма каретки: полоска, блок или подчёркивание. */
  cursorStyle: CursorStyle;
  /** Мигает ли каретка. Выключенное мигание спокойнее глазу при долгом чтении. */
  cursorBlink: boolean;
  insertSpaces: boolean;
  /** Язык задаёт свои отступы: Python — 4 пробела, Makefile — символ табуляции. */
  languageIndent: boolean;
  /** Форматировать документ при сохранении (ruff или black из окружения). */
  formatOnSave: boolean;
  /** Убирать пробелы в конце строк при сохранении. */
  trimTrailingWhitespace: boolean;
  /** Дописывать перевод строки в конце файла при сохранении. */
  insertFinalNewline: boolean;
  /**
   * Автосохранение: когда правка уходит на диск сама, без Ctrl+S. По умолчанию
   * выключено — «само записалось» застаёт врасплох (см. `shared/auto-save.ts`).
   */
  autoSave: AutoSaveMode;
  /** Пауза автосохранения в миллисекундах: для режима «через паузу после правки». */
  autoSaveDelayMs: number;
  /** Столбцы направляющих (ruler): вертикальные черты через всю высоту редактора. */
  rulers: number[];
  /** Показ невидимых знаков: ничего, только хвостовые пробелы или все. */
  renderWhitespace: WhitespaceMode;
  /** Миникарта справа: сжатый вид всего файла. */
  minimap: boolean;
  /** Перенос длинных строк: строка шире окна ломается на несколько рядов. */
  wordWrap: boolean;
  /**
   * Плавная прокрутка: прыжок курсора уводит текст разгоном, а не скачком.
   * Прыжки по клику и движению курсора остаются мгновенными.
   */
  smoothScroll: boolean;
  /**
   * Vim-режим: модальное управление клавишами (нормальный, визуальный и режим вставки).
   * Выключен — клавиши работают как обычно.
   */
  vimMode: boolean;
  /**
   * Emacs-режим: сочетания Ctrl/Alt (Ctrl+F/B/N/P/A/E, Ctrl+K/U/Y, метка и т.д.) поверх
   * обычного ввода. Режим не модальный: буквы печатают текст как всегда.
   */
  emacsMode: boolean;
  /** Лигатуры шрифта: `=>`, `!=`, `->` одним знаком (шрифт должен их уметь). */
  fontLigatures: boolean;
  /** Свои сниппеты (шаблоны кода); к ним добавляется набор по умолчанию. */
  snippets: Snippet[];
  /** Emmet: раскрытие сокращений разметки и стилей по Tab (`ul>li*3` → список). */
  emmet: boolean;
  /**
   * Форматировать вставленный кусок сразу после вставки. Делает это языковой сервер
   * (`rangeFormatting`) — инструмент проекта так не умеет, он переписывает файл целиком.
   */
  formatOnPaste: boolean;
  /** Проверка орфографии: волнистые подчёркивания под словами не из словаря. */
  spellcheck: boolean;
  /** Слова человека, добавленные в словарь поверх системного. Переживают перезапуск. */
  spellWords: string[];
}

/** Плотность строк дерева проекта. */
export type TreeRowDensity = 'compact' | 'normal' | 'cozy';
/** Порядок детей в дереве. */
export type TreeSort = 'name' | 'type' | 'modified' | 'git';

/**
 * Настройки проводника. Дерево — главный способ ходить по проекту, поэтому
 * всё, что меняет его вид и поведение, живёт здесь, а не в коде по вкусу автора.
 */
export interface ExplorerSettings {
  /** Значки по виду файла — вместо одинаковых листов. */
  icons: boolean;
  /** Показывать скрытые файлы и папки (`.git`, `.env`, `.venv`). */
  showHidden: boolean;
  /** Папки выше файлов. */
  foldersFirst: boolean;
  sort: TreeSort;
  /** Отступ одного уровня вложенности, px. */
  indent: number;
  rowDensity: TreeRowDensity;
  /** Буквы M/A/D у файлов с правками. */
  gitDecorations: boolean;
  /** Точка у свёрнутой папки, внутри которой есть правки. */
  folderChangeDot: boolean;
  /**
   * Отмечать файлы, тронутые недавно (в пределах `recentWindowHours`): git-пометка
   * говорит о правках с последнего коммита, а эта — о свежести самой правки.
   */
  recentChanges: boolean;
  /** Окно свежести в часах: файл, тронутый раньше, отметки не получает. */
  recentWindowHours: number;
  /** Приглушать игнорируемые git файлы и папки: их видно, но они не мешают. */
  dimIgnored: boolean;
  /** Открывать файл одним кликом (иначе — двойным). */
  openOnSingleClick: boolean;
  /** Спрашивать подтверждение перед удалением. */
  confirmDelete: boolean;
  /** Шаблоны имён, которые не показываем в дереве (`*.min.js`, `coverage`). */
  exclude: string[];
  /** Сворачивать связанные файлы под родителя (`Button.tsx` ← `Button.test.tsx`). */
  fileNesting: boolean;
  /**
   * При переименовании файла или папки править импорты, ведущие на прежний путь.
   * Без этого переименование ломает сборку: на файл ссылаются по имени.
   */
  updateImportsOnRename: boolean;
  /**
   * Собирать файлы папки по назначению (тесты, стили, документация…) под подписанные
   * полки. Папки остаются сверху — группировка только про файлы.
   */
  groupByType: boolean;
  /**
   * В монорепо показывать пакеты верхнего уровня отдельными строками, а промежуточные
   * каталоги (`packages`) прятать: пакет — это проект, а каталог — просто место на диске.
   */
  groupByPackage: boolean;
  /**
   * Свои правила вложения: строка на родителя, `*.tsx: *.test.tsx, *.module.css`.
   * Пусто — берутся правила по умолчанию (см. `core/file-nesting.ts`).
   */
  nestingRules: string[];
  /**
   * Отличия настроек для отдельных корней рабочей области: «путь папки → своё».
   * Зачем — см. `shared/explorer-settings.ts`; там же и разрешение настроек.
   */
  byRoot: ExplorerRootOverrides;
  /**
   * Значки поверх дерева от ЧУЖИХ наборов: правила «маска → подпись и цвет».
   * Свои украшения (git, подмодули, приглушение) дерево знает и без них — здесь
   * пометки проекта, которые IDE придумать не может (см. `shared/icon-badges.ts`).
   */
  badges: IconBadgeRule[];
}

/**
 * Что можно задать отдельно для папки: вид и фильтрация дерева. Поведение, которое
 * меняет файлы (обновление импортов при переименовании), сюда не входит.
 */
export interface ExplorerRootOverride {
  showHidden?: boolean;
  foldersFirst?: boolean;
  sort?: TreeSort;
  indent?: number;
  rowDensity?: TreeRowDensity;
  icons?: boolean;
  gitDecorations?: boolean;
  folderChangeDot?: boolean;
  recentChanges?: boolean;
  dimIgnored?: boolean;
  openOnSingleClick?: boolean;
  confirmDelete?: boolean;
  exclude?: string[];
  fileNesting?: boolean;
  nestingRules?: string[];
  groupByType?: boolean;
  groupByPackage?: boolean;
}

/** Карта «корень → отличия»: ключ — абсолютный путь папки, как у корней области. */
export type ExplorerRootOverrides = Record<string, ExplorerRootOverride>;

export type PackageManagerChoice = 'auto' | 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Как запускать файлы и скрипты проекта. */
export interface RunSettings {
  /** Интерпретатор Python. Пусто — ищем виртуальное окружение проекта, затем `python3`. */
  pythonPath: string;
  /** Менеджер пакетов Node. `auto` — по файлу блокировки в корне проекта. */
  packageManager: PackageManagerChoice;
  /** Сохранять документ перед запуском. */
  saveBeforeRun: boolean;
  /**
   * Интерпретатор для конкретного проекта: ключ — корень проекта. Пусто —
   * берётся общий `pythonPath`. Так два Python-проекта не мешают друг другу.
   */
  pythonByRoot: Record<string, string>;
}

/** Настройки работы с git. Портятся к проекту: у команд разные привычки. */
export interface GitSettings {
  /** Как вливать изменения при `pull`: слиянием, перебазированием, только перемоткой. */
  pullMode: PullMode;
  /**
   * Сохранять несохранённые файлы перед коммитом. Коммит читает рабочее дерево, а
   * не экран редактора: без этого правки из буфера в коммит бы не попали, а вкладка
   * осталась бы с пометкой «не сохранён».
   */
  saveBeforeCommit: boolean;
}

export interface AppearanceSettings {
  /** Масштаб интерфейса: 1 — как есть. Редактора не касается (у него свой кегль). */
  uiScale: number;
  /** Тема из файла: `null`/не задано — встроенная палитра. */
  customTheme?: ThemeFile | null;
}

/** Что приложение помнит о работе: история открытых папок для стартового окна. */
export interface WorkspaceSettings {
  /** Недавние проекты, новые в начале списка. */
  recent: string[];
  /**
   * Удалённые папки рабочего места: адреса вида `ssh://user@host/srv/app`,
   * `wsl://Ubuntu/home/me/app`, `container://имя/workspace`. Ходят туда клиентом
   * самой системы (см. `main/workspace/remote-fs.ts`), а не своим протоколом.
   */
  remoteRoots: string[];
  /**
   * «Избранное»: постоянные места (папки и файлы), к которым человек возвращается.
   * Живёт в настройках IDE, а не в сессии проекта: список переживает смену проекта
   * и может указывать на папку вне рабочей области (см. `shared/favorites.ts`).
   */
  favorites: string[];
}

/**
 * Макет рабочей области: размеры и видимость панелей. Общий для всех проектов —
 * это рабочее место человека, а не свойство кода.
 */
export interface LayoutSettings {
  /** Ширина боковой панели, px. */
  sidebarSize: number;
  /** Ширина правой панели, px. */
  rightSize: number;
  /** Высота нижней панели, px. */
  dockSize: number;
  sidebarVisible: boolean;
  rightVisible: boolean;
  dockVisible: boolean;
}

/* ── Python: окружения и создание venv ─────────────────────────────────── */

/** Уровень установки пакетов при создании окружения. */
export type VenvInstallPreset = 'empty' | 'pytest' | 'full';

export interface CreateVenvOptions {
  /** Имя каталога окружения. По умолчанию `.venv`. */
  name?: string;
  /** Где создать: в проекте (по умолчанию), в `~/.venvs` или в своей папке. */
  location?: VenvLocation;
  /** Своя папка для `location: 'custom'`: абсолютный путь, `~` или путь от корня проекта. */
  path?: string;
  /** Базовый интерпретатор для создания окружения, если задан явно. */
  base?: string;
  /** Доустановить pytest, pylsp, ruff — одним из готовых профилей. */
  preset?: VenvInstallPreset;
  /** Поставить зависимости из requirements.txt, если он есть. */
  installRequirements?: boolean;
}

/** Событие прогресса создания окружения: шаг и вывод команд. */
export interface VenvProgressPayload {
  type: 'step' | 'output' | 'done' | 'error';
  message: string;
}

export interface CreateVenvResult {
  environment: PythonEnvironment;
  /** Что реально поставили: `requirements.txt` и/или имена пакетов. */
  installed: string[];
}

/** Что поставить в главное окружение проекта. */
export interface PythonInstallOptions {
  /** Явные пакеты: то, что человек выбрал, и то, что подсказали подчёркнутые импорты. */
  packages?: string[];
  /** Доустановить то, что просит `requirements.txt` (если файл есть). */
  requirements?: boolean;
}

/** Результат установки: что реально поставили. */
export interface PythonInstallResult {
  installed: string[];
}

/** Результат форматирования файла. */
export interface PythonFormatResult {
  /** Отформатированный текст; совпадает с исходным, если менять нечего. */
  text: string;
  /** Инструмент, который отформатировал; null — ни ruff, ни black не нашлись. */
  tool: string | null;
}

/**
 * Результат форматирования файла инструментом Node-проекта. Форма та же, что у
 * питоновского: renderer обрабатывает оба ответа одинаково.
 */
export type NodeFormatResult = PythonFormatResult;

/**
 * Профиль строк файла от своего профилировщика (`main/python/line-profile.ts`):
 * строки с временем и «жаром», плюс что программа напечатала и как завершилась.
 */
export interface PythonLineProfileResult {
  profile: LineProfile;
  /** Хвост вывода программы — показать его целиком незачем. */
  stdout: string;
  stderr: string;
  /** Прогон не состоялся: интерпретатор не запустился, истёк таймаут. */
  failed: boolean;
  /** Пояснение к неудаче для интерфейса; `null` — всё в порядке. */
  message: string | null;
}

/* ── LSP ───────────────────────────────────────────────────────────────── */

/** Один языковой сервер: язык, команда запуска и включён ли он. */
export interface LspServerConfig {
  /** Идентификатор языка (как в shared/languages.ts): python, typescript, … */
  language: string;
  command: string;
  args: string[];
  enabled: boolean;
  /**
   * Подпись для интерфейса. Нужна серверам из поставки: у них `command` — путь к
   * самому Electron (`ELECTRON_RUN_AS_NODE`), и показывать его человеку нечего.
   */
  label?: string;
  /** Дополнительные переменные окружения процесса сервера (например, режим Node). */
  env?: Record<string, string>;
  /**
   * Довод к `initialize`. Нужен серверам из поставки: TypeScript Language Server
   * требует назвать путь к своему `tsserver.js` (см. `shared/lsp-bundled.ts`).
   */
  initializationOptions?: Record<string, unknown>;
}

export interface LspSettings {
  /** Общий выключатель: без него серверы не запускаются. */
  enabled: boolean;
  /**
   * Журнал обмена с серверами: все сообщения обоих направлений пишутся в файл
   * (путь говорит main). Нужен для отладки: без него «сервер молчит» — догадка.
   */
  trace: boolean;
  servers: LspServerConfig[];
}

/** Пометка от языкового сервера, уже привязанная к файлу. */
export interface LspDiagnostic {
  severity: 'error' | 'warning' | 'info';
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
  source?: string;
  /**
   * Код правила у сервера (`reportIncompatibleVariableOverride` у pyright, `E501` у ruff).
   * Нужен, чтобы отличать настоящую ошибку от замечания о стиле: и то и другое сервер
   * шлёт как `error`, а по коду видно, чего это правило стоит (см. `shared/lsp-severity.ts`).
   */
  code?: string;
}

/** Полезная нагрузка события `PushTopic.LspDiagnostics`. */
export interface LspDiagnosticsPayload {
  path: string;
  diagnostics: LspDiagnostic[];
}

/** Полезная нагрузка события `PushTopic.ThemeChanged`: сменилась тема из файла. */
export interface ThemeChangedPayload {
  /** Активная тема из файла — или `null`, если работает встроенная палитра. */
  customTheme?: ThemeFile | null;
}

/* ── Отладчик (DAP) ─────────────────────────────────────────────────────── */

/** Что делает сессия отладки прямо сейчас. */
export type DebugPhase = 'idle' | 'starting' | 'running' | 'stopped';

/**
 * Точка останова.
 *
 * Поля-настройки необязательны и работают вместе так же, как в DAP:
 * `condition` и `hitCondition` решают, останавливаться ли, а `logMessage` —
 * останавливаться ли вообще: точка с сообщением только пишет строку в вывод.
 */
export interface DebugBreakpoint {
  line: number;
  /** Останавливаться, только если выражение истинно. */
  condition?: string;
  /** Останавливаться после стольких попаданий (`>5`, `10`). Счёт ведёт отладчик. */
  hitCondition?: string;
  /**
   * Точка в журнал: вместо останова печатает сообщение. `{выражение}` внутри
   * текста подставляет значение — так же, как его понимает отладчик.
   */
  logMessage?: string;
  /** Подтвердил ли точку отладчик (проверена ли исполнимость строки). */
  verified: boolean;
}

/** Кадр стека в момент останова. */
export interface DebugFrame {
  id: number;
  name: string;
  /** Файл кадра; null — кадр без исходника (например, во внутренностях). */
  path: string | null;
  line: number;
  column: number;
}

/** Область видимости кадра (локальные, глобальные). */
export interface DebugScope {
  name: string;
  variablesReference: number;
  /** Дорогое раскрытие (большие коллекции) — отладчик сам об этом сообщает. */
  expensive: boolean;
}

/** Переменная или поле раскрытой структуры. */
export interface DebugVariable {
  name: string;
  value: string;
  type: string | null;
  /** Ненулевое — у значения есть дети, его можно раскрыть. */
  variablesReference: number;
}

/** Состояние сессии: его рассылает main, чтобы панель и статусбар шли в ногу. */
export interface DebugStatePayload {
  phase: DebugPhase;
  /** Причина останова (`breakpoint`, `step`, `pause`) — для подписи. */
  reason: string | null;
  /** Кадр, на котором остановились (курсор редактора). */
  topFrame: DebugFrame | null;
}

/** Полезная нагрузка `PushTopic.DebugStopped`: останов и стек целиком. */
export interface DebugStoppedPayload {
  reason: string;
  frames: DebugFrame[];
}

/** Полезная нагрузка `PushTopic.DebugOutput`: вывод отлаживаемой программы. */
export interface DebugOutputPayload {
  category: string;
  text: string;
}

/**
 * Как запускать программу: чего не хватает одному имени файла.
 *
 * Аргументы — то, что человек ввёл строкой и разобрал `parseArguments`;
 * рабочий каталог — где запускать процесс (по умолчанию корень проекта);
 * переменные окружения — дополнение к окружению проекта (`.env`), их видит
 * только отлаживаемая программа, а не адаптер.
 */
export interface DebugLaunchOptions {
  /** Аргументы командной строки программы (после имени файла). */
  args?: string[];
  /** Дополнительные переменные окружения программы (перекрывают `.env` и системные). */
  env?: Record<string, string>;
  /** Рабочий каталог процесса; не задан — корень проекта. */
  cwd?: string;
}

/**
 * Как подключиться к уже запущенному процессу.
 *
 * Отличие от запуска принципиальное: процесс поднял не отладчик, а сам человек
 * (или другая программа), и перезапускать его нельзя. Поэтому вместо программы
 * известно только, где слушает его инспектор — порт.
 */
export interface DebugAttachOptions {
  /** Порт инспектора: у Node это `--inspect=127.0.0.1:9229`, у Python — `debugpy --listen`. */
  port: number;
  /** Хост инспектора; не задан — локальный адрес. */
  host?: string;
  /**
   * Какой адаптер поднимать. По умолчанию Node: чаще всего подключаются к
   * `node --inspect`, а Python-процесс слушает `debugpy`, и это видно по файлу.
   */
  target?: 'node' | 'python';
}

/**
 * Останов по исключению: какие исключения останавливают программу.
 *
 * `caught` включает и пойманные — это «все исключения»; он перекрывает
 * `uncaught`. Адаптеры зовут эти фильтры по-разному, поэтому наружу даём пару
 * понятных флагов, а перевод делает main.
 */
export interface DebugExceptionFilters {
  /** Необработанные исключения. */
  uncaught: boolean;
  /** Пойманные исключения (любые). */
  caught: boolean;
}

export interface Settings {
  ai: AiSettings;
  editor: EditorSettings;
  explorer: ExplorerSettings;
  run: RunSettings;
  appearance: AppearanceSettings;
  workspace: WorkspaceSettings;
  layout: LayoutSettings;
  lsp: LspSettings;
  git: GitSettings;
  /** Изменённые горячие клавиши: поверх сочетаний по умолчанию. */
  keybindings: KeybindingSettings;
}

/** Провайдер, которого добавляют или меняют из интерфейса. Ключ задаётся отдельно. */
export interface AiProviderPatch {
  id: string;
  label?: string;
  baseUrl?: string;
  models?: string[];
  defaultModel?: string;
  protocol?: 'openai' | 'anthropic';
}

export interface AiSettingsPatch {
  /** Общий выключатель ассистента: `false` глушит AI целиком. */
  enabled?: boolean;
  activeProviderId?: string;
  activeModel?: string;
  temperature?: number;
  maxTokens?: number;
  /** Размер контекстного окна в токенах; 0 — вернуть автоопределение по модели. */
  contextWindow?: number;
  /** Абсолютный предел истории для автосжатия в токенах; 0 — только по окну модели. */
  compactAtTokens?: number;
  /** Модель для сжатия беседы; пусто — активная модель. */
  compactModel?: string;
  systemPrompt?: string;
  reasoningEffort?: ReasoningEffort;
  /** Сколько шагов делает агент в обычном режиме (страховка от зацикливания). */
  maxSteps?: number;
  /** Сколько шагов делает агент при полном доступе (когда подтверждения не нужны). */
  maxAutopilotSteps?: number;
  /** Спрашивать ли при полном доступе перед необратимыми командами. */
  confirmDangerous?: boolean;
  /** Проверять ли команду моделью перед карточкой подтверждения. */
  approvalReview?: boolean;
  /** Модель для проверки команд; пусто — активная модель беседы. */
  reviewModel?: string;
  /** Сжимать ли вывод инструментов перед отправкой модели. */
  compressOutput?: boolean;
  /** Настройки веб-поиска: ключ задаётся отдельным вызовом `ai.setWebSearchKey`. */
  webSearch?: { enabled?: boolean; provider?: WebSearchProvider; endpoint?: string };
  /** Чтение страниц по ссылке: только включение. */
  webFetch?: { enabled?: boolean };
  /** Браузерная автоматизация: включение, встроенный или отдельный Chromium. */
  browser?: { enabled?: boolean; executable?: string; headless?: boolean; integrated?: boolean };
  /** Песочница: включение, образ, рабочий каталог и сеть. */
  sandbox?: { enabled?: boolean; image?: string; workdir?: string; network?: boolean };
  /** Список серверов MCP заменяется целиком: так его проще править из интерфейса. */
  mcpServers?: McpServerConfig[];
  /** Настройка inline-автодополнения: включение и задержка. */
  inlineCompletion?: Partial<AiInlineCompletionSettings>;
  /** Добавить провайдера или обновить существующего по `id`. */
  provider?: AiProviderPatch;
  /** Убрать провайдера из списка. */
  removeProviderId?: string;
}

/** Результат «Проверить подключение»: ошибки объясняем текстом, а не кодом. */
export interface AiConnectionTestResult {
  ok: boolean;
  models: string[];
  message: string;
}

/** Что ответил один сервер MCP: его инструменты или причина, по которой он не поднялся. */
export interface McpServerTools {
  id: string;
  /** Ошибка запуска или связи; нет — сервер ответил. */
  error?: string;
  tools: Array<{
    name: string;
    description: string;
    readOnly: boolean;
    /** Пойдёт ли инструмент модели: за потолком остаётся `false`. */
    offered: boolean;
  }>;
}

/**
 * Веб-поиск ассистента. Выключен по умолчанию: это единственное действие агента,
 * которое ходит в интернет, и включать его без спроса невежливо.
 */
export interface AiWebSearchSettings {
  enabled: boolean;
  /** SearxNG (ключ не нужен) или Brave Search API (нужен ключ). */
  provider: WebSearchProvider;
  /** Адрес сервиса; пусто — адрес по умолчанию для выбранного вида поиска. */
  endpoint: string;
  /** Ключ задан. Сам ключ наружу не отдаём — как и ключи провайдеров. */
  hasApiKey: boolean;
}

/**
 * Чтение страниц по ссылке (`web_fetch`). Отдельно от поиска: поиск находит, а
 * сюда агент идёт за содержимым. Выключено по умолчанию — это ход наружу.
 */
export interface AiWebFetchSettings {
  enabled: boolean;
}

/**
 * Браузерная автоматизация. Выключена по умолчанию: агент ходит в интернет и
 * нажимает кнопки на чужих страницах — это осознанное действие, а не фон.
 */
export interface AiBrowserSettings {
  enabled: boolean;
  /** Путь к исполняемому файлу Chromium; пусто — ищем известные имена в PATH. */
  executable: string;
  /** Работать без окна: браузер не отвлекает и заводится на машинах без экрана. */
  headless: boolean;
  /**
   * Работать во встроенном браузере — вкладкой в редакторе, рядом с кодом. Агент
   * подключается к той же странице, которую видит человек. Выключено — отдельный
   * Chromium с пустым профилем: ею проверяют страницу в настоящем браузере человека.
   */
  integrated: boolean;
}

export interface WorkspaceSettingsPatch {
  /** Полная замена списка избранного (порядок — как добавили). */
  favorites?: string[];
  /** Полная замена списка удалённых папок. */
  remoteRoots?: string[];
}

export interface SettingsPatch {
  ai?: AiSettingsPatch;
  editor?: Partial<EditorSettings>;
  explorer?: Partial<ExplorerSettings>;
  run?: Partial<RunSettings>;
  appearance?: Partial<AppearanceSettings>;
  layout?: Partial<LayoutSettings>;
  workspace?: WorkspaceSettingsPatch;
  lsp?: Partial<LspSettings>;
  git?: Partial<GitSettings>;
  keybindings?: Partial<KeybindingSettings>;
}

/* ── AI ─────────────────────────────────────────────────────────────────── */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** Вызов инструмента, который запросила модель. Аргументы — сырая JSON-строка. */
export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  /**
   * Картинки сообщения — data-URL (`data:image/png;base64,…`).
   * Отдельным полем, а не частями `content`: на проводе они становятся
   * мультимодальным содержимым, но внутри приложения текст остаётся текстом,
   * и весь код работы с историей его таким и видит.
   */
  images?: readonly string[];
  /** Для role='assistant': инструменты, которые модель попросила вызвать. */
  toolCalls?: ChatToolCall[];
  /** Для role='tool': id вызова, на который отвечает это сообщение. */
  toolCallId?: string;
  /** Оценка ответа пользователем: помогает понять, какие ответы были полезны. */
  rating?: 'up' | 'down';
}

/**
 * Контекст, который renderer собрал сам и прикладывает к вопросу.
 * Так работают `#selection`, `#file` и `#problems` в панели ассистента.
 */
export interface ChatAttachment {
  kind: 'file' | 'selection' | 'problems' | 'note' | 'image' | 'session';
  /** Короткая подпись для чипа в композере. */
  label: string;
  /** Заголовок блока в промпте: путь файла или описание. */
  title: string;
  text: string;
  /** Для kind='image': сама картинка — data-URL, уходит в модель как изображение. */
  dataUrl?: string;
  /** Размер картинки в байтах: показываем в чипе и проверяем предел. */
  bytes?: number;
  /**
   * Для kind='session': ссылка на источник справки (`chui://chat/<uid>`).
   * В промпт попадает атрибутом блока `session-reference` — по нему видно, что
   * это разговор, а не файл проекта. Не наша схема — атрибут не пишется вовсе.
   */
  uri?: string;
  /**
   * Для kind='session': справка обрезана по байтовому потолку. Признак едет
   * атрибутом `truncated`, чтобы модель знала, что видит не весь разговор.
   */
  truncated?: boolean;
}

/** Больше четырёх картинок в одном вопросе — это уже не вопрос, а альбом. */
export const MAX_CHAT_IMAGES = 4;
/** Предел на картинку: больше не примет ни провайдер, ни смысл вложения. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Картинка, выбранная в системном диалоге или прочитанная из буфера. */
export interface PickedImage {
  /** Имя файла без пути: в чипе видно, что приложено. */
  name: string;
  /** Тип (`image/png`) — для подсказки и проверки на стороне main. */
  mime: string;
  bytes: number;
  dataUrl: string;
}

/**
 * Картинка, открытая в редакторе на просмотр. Тот же `data-URL`, что у вложения
 * в чат, но предел выше: посмотреть скриншот — не то же, что послать его модели.
 */
export interface ViewImage {
  /** Тип содержимого (`image/png`). */
  mime: string;
  /** Размер файла в байтах — показываем в шапке вьюера. */
  bytes: number;
  dataUrl: string;
}

/**
 * Запрос подсказки inline-автодополнения. Контекст — уже нарезанный в renderer
 * текст вокруг курсора: main не читает файлы ради этого, он только спрашивает модель.
 */
export interface InlineCompletionRequest {
  /** Путь открытого файла (для контекста в промпте). */
  path: string;
  /** Язык файла: модель подсказывает по нему. */
  language: string;
  /** Текст до курсора. */
  prefix: string;
  /** Текст после курсора. */
  suffix: string;
}

/** Ответ подсказки: готовый к вставке текст (может быть пустым). */
export interface InlineCompletionResult {
  text: string;
}

export interface ChatRequest {
  providerId: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Усилие размышления для этой конкретной отправки (иначе — из настроек). */
  reasoningEffort?: ReasoningEffort;
  systemPrompt?: string;
  /** Включить агентный цикл: модель сможет вызывать инструменты из shared/tools.ts. */
  useTools?: boolean;
  /**
   * Права ассистента: три состояния одним выбором (см. `shared/permissions.ts`).
   * Не заданы — считаем по `autoApprove`, как в старых запросах.
   */
  permission?: PermissionPreset;
  /**
   * Устаревшее: `true` — это «полный доступ». Оставлено для проб и скриптов,
   * которые шлют запрос напрямую; настоящий выбор теперь в `permission`.
   */
  autoApprove?: boolean;
  /**
   * Режим плана: агент только читает проект и составляет план, ничего не меняя.
   * Правки и команды в этом режиме не предлагаются и не исполняются.
   */
  planMode?: boolean;
  /** Дополнительный контекст от renderer: выделение, файл, ошибки. */
  attachments?: ChatAttachment[];
  /**
   * Цель работы (см. `shared/goal.ts`): что агент должен довести до конца.
   *
   * От обычного вопроса отличается тем, что переживает ход: цель остаётся
   * в беседе, пока её не закроют, а прогон, кончившийся без закрытия, main
   * продолжает сам. Пусто — работа идёт как обычно, «шаг и ответ».
   */
  goal?: string;
}

/**
 * Цель работы: то, что агент обязан довести до конца, а не сделать за один ход.
 *
 * Живёт в беседе, а не в прогоне: вопрос уходит модели один раз, цель — в каждом
 * следующем запросе, пока не закрыта. Это и отличает её от плана (`PlanStep[]`),
 * который описывает порядок шагов одной задачи и живёт до конца прогона.
 */
export interface ChatGoal {
  text: string;
  /** Цель достигнута (или снята человеком): в запросы больше не идёт. */
  done: boolean;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  /**
   * Сколько входных токенов пришло из кеша промпта. Они дешевле обычных,
   * поэтому это число — прямой признак экономии на многошаговой задаче.
   */
  cachedTokens?: number;
}

/**
 * След одного прогона агента: сколько шагов он сделал и что потратил. Агентский
 * прогон — это несколько «модель → инструмент → модель», и расход по каждому шагу
 * провайдер сообщает отдельно. Без сложения виден только последний шаг, то есть
 * стоимость прогона занижена во много раз.
 */
export interface ChatRunTrace {
  /** Сколько шагов «модель → инструмент → модель» сделал прогон. */
  steps: number;
  /** Сколько всего вызовов инструментов было в прогоне. */
  toolCalls: number;
  /** Суммарный расход токенов за весь прогон. */
  usage: ChatUsage;
  /**
   * Сколько контекста заняли описания инструментов, реально ушедших в этом
   * прогоне. Число знает только main: какой набор предложить, решает `canRun`
   * (наличие git, терминалов, языкового сервера, MCP), а renderer этого не
   * видит и оценивал бы по всему списку — то есть врал бы в обе стороны.
   */
  toolsTokens?: number;
}

export interface ChatStreamDone {
  text: string;
  finishReason?: string;
  usage?: ChatUsage;
  /** След прогона: шаги, вызовы и суммарный расход за все шаги (для наблюдаемости). */
  trace?: ChatRunTrace;
  /**
   * Подробная трасса этого прогона: что ушло модели, каждый шаг с его вызовами,
   * временем и итог. По ней разбирают, «почему это заняло минуту», — в отличие от
   * `trace`, где только итоговые числа.
   */
  run?: ChatRunLog;
  /** Размышления reasoning-моделей: ответу не принадлежат, но их полезно видеть. */
  reasoning?: string;
  /** Вызовы инструментов из последнего шага модели (если модель их запросила). */
  toolCalls?: ChatToolCall[];
  /**
   * Вся ветка диалога, которую породил этот вызов: assistant(toolCalls) →
   * tool(результат) → assistant(ответ). Renderer дописывает её в историю,
   * поэтому в следующем вопросе модель помнит, что успела прочитать.
   */
  agentMessages?: ChatMessage[];
}

/**
 * Беседа в том виде, в каком она переживает перезапуск. От сессии в renderer
 * отличается тем, что здесь нет ни ленты DOM, ни незаписанных правок — только
 * то, что имеет смысл показать после старта: история, заголовок и расход контекста.
 */
export interface ChatConversation {
  /** Идентификатор беседы: в отличие от номера вкладки, стабилен между запусками. */
  uid: string;
  title: string;
  /** Время последнего изменения: по нему беседы можно упорядочивать в списке. */
  updatedAt: number;
  /** Вся переписка: то, что человек видит в ленте после перезапуска. */
  messages: ChatMessage[];
  /**
   * Контекст, который посылается модели, если беседа сжата. Не задано — посылается
   * `messages`. Два поля, потому что это разные вещи: сжатие заменяет контекст
   * резюме, но не стирает переписку, которую человек уже прочитал.
   */
  context?: ChatMessage[];
  usage?: ChatUsage;
  /** Накопленный след беседы: переживает перезапуск вместе с историей. */
  trace?: ChatRunTrace;
  /** Цель работы: незакрытая цель поднимается вместе с беседой. */
  goal?: ChatGoal;
}

/** Всё, что main хранит по одной рабочей папке. */
export interface ChatHistory {
  conversations: ChatConversation[];
  /** Беседа, которая была активной: её показываем после восстановления. */
  activeUid?: string;
}

/** Имена событий стрима `ai.chat`. */
export const ChatStreamEvent = {
  Delta: 'delta',
  Reasoning: 'reasoning',
  ToolStart: 'tool_start',
  ToolResult: 'tool_result',
  Plan: 'plan',
  Goal: 'goal',
} as const;

export interface ChatDeltaPayload {
  text: string;
}

/** Цель поставлена, закрыта или прогон пошёл на новый круг ради неё. */
export interface ChatGoalPayload {
  /** Текущая цель; null — цели нет. */
  goal: ChatGoal | null;
  /** Сколько раз прогон уже продолжал сам себя ради этой цели. */
  continued?: number;
  /** Сколько таких продолжений допускается за один прогон. */
  limit?: number;
}

/** Поток размышлений модели: показываем сворачиваемым блоком над ответом. */
export interface ChatReasoningPayload {
  text: string;
}

/** Модель решила вызвать инструмент — в UI появляется карточка «выполняется». */
export interface ChatToolStartPayload {
  id: string;
  name: string;
  /** Сырые аргументы (JSON-строка), как их прислала модель. */
  args: string;
}

/** Инструмент отработал: короткая сводка для карточки и полный вывод. */
export interface ChatToolResultPayload {
  id: string;
  name: string;
  ok: boolean;
  summary: string;
  detail?: string;
  /** Сколько инструмент работал, мс: видно, что шаг ушёл на сборку, а не на чтение. */
  ms?: number;
  /** Файлы, которых коснулся инструмент без правки документа (создание, удаление, перенос). */
  changes?: ToolFileChange[];
  /**
   * Картинки, которые инструмент отдал модели (`read_image`). Нужны в карточке:
   * человек должен видеть, на что именно смотрел агент, а не только путь.
   */
  images?: string[];
}

/**
 * Файловая операция агента, которую видно в панели «Изменён N файл».
 * Правки документов едут отдельным путём (apply_edit → ревью), а это —
 * создание, удаление и перенос: они меняют диск, но не буфер редактора.
 */
export interface ToolFileChange {
  path: string;
  kind: 'created' | 'deleted' | 'moved' | 'modified';
  /** Для `moved` — исходный путь. */
  from?: string;
  /** Для `modified` — сколько вхождений заменено (массовая замена). */
  replaced?: number;
  /** Строк в созданном файле (для счётчика). */
  lines?: number;
}

/** Статус шага плана: как в todo-инструментах агентов. */
export type PlanStepStatus = 'pending' | 'in_progress' | 'done';

export interface PlanStep {
  text: string;
  status: PlanStepStatus;
}

/** Модель обновила план работы — в ленте появляется чек-лист. */
export interface ChatPlanPayload {
  steps: PlanStep[];
}

/* ── Хост-вызовы main → renderer ────────────────────────────────────────── */

/** Аргументы `ai.applyEdits`: то, что агент просит применить к документам. */
export interface ApplyEditsHostParams {
  edits: FileEdit[];
  /** Полный доступ: применить сразу, без экрана ревью. */
  autoApprove?: boolean;
}

export interface ApplyEditsHostResult {
  /** Пользователь отказался — это решение, а не ошибка. */
  rejected: boolean;
  result?: ApplyResult;
  /**
   * Пути, чьи правки легли только в буфер редактора: на диск они не записаны.
   * Так бывает без полного доступа (файл пишет человек кнопкой «Сохранить») и при
   * конфликте с чужой правкой. Молчать об этом нельзя: main читает файлы с диска,
   * и агент принял бы старый текст за применённый.
   */
  unwritten?: string[];
}

/** Аргументы `ai.applyPatches`: правки по якорю, без позиций. */
export interface ApplyPatchesHostParams {
  patches: PatchFile[];
  /** Полный доступ: применить сразу, без экрана ревью. */
  autoApprove?: boolean;
}

/** Аргументы `ai.confirmCommand`: команда, которую просит выполнить агент. */
export interface ConfirmCommandHostParams {
  command: string;
  /**
   * Что сказала проверка модели, если она не решилась разрешить сама. Причина
   * показывается в карточке подсказкой: человеку полезно видеть, что её смутило.
   */
  review?: ReviewVerdict;
}

export interface ConfirmCommandHostResult {
  allowed: boolean;
}

/** Аргументы `ai.confirmGit`: действие git, которое просит выполнить агент. */
export interface ConfirmGitHostParams {
  action: string;
}

/** Аргументы `ai.confirmBrowser`: действие в браузере, которое просит выполнить агент. */
export interface ConfirmBrowserHostParams {
  action: string;
}

export interface ConfirmBrowserHostResult {
  allowed: boolean;
}

export interface ConfirmGitHostResult {
  allowed: boolean;
}

/** Аргументы `ai.ask`: вопрос ассистента и, если есть, готовые варианты ответа. */
export interface AskHostParams {
  question: string;
  /** Готовые варианты (до 5) — показываются кнопками. */
  options?: readonly string[];
}

export interface AskHostResult {
  /** Ответ человека. Пустая строка — вопрос остался без ответа (например, прогон прервали). */
  answer: string;
}

/** Одна пометка языка: ошибка, предупреждение, подсказка. */
export interface DiagnosticItem {
  path: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: string;
}

/** Аргументы `ai.getDiagnostics`: без пути — по всем открытым файлам. */
export interface DiagnosticsHostParams {
  path?: string;
}

export interface DiagnosticsHostResult {
  items: DiagnosticItem[];
}

/** Аргументы `ai.openFile`: файл и место, которое нужно показать в редакторе. */
export interface OpenFileHostParams {
  path: string;
  /** Строка (1-based). Без неё — начало файла. */
  line?: number;
  /** Столбец (1-based). */
  column?: number;
}

export interface OpenFileHostResult {
  ok: boolean;
}

/**
 * Таблица хостовых методов: main обязан знать, что renderer умеет исполнять.
 * Обратный вызов нужен только там, где действие физически живёт в renderer.
 */
export interface HostMethods {
  'ai.applyEdits': { params: ApplyEditsHostParams; result: ApplyEditsHostResult };
  /** Правки по якорю: позиции считает renderer — у него есть текст документа. */
  'ai.applyPatches': { params: ApplyPatchesHostParams; result: ApplyEditsHostResult };
  'ai.confirmCommand': { params: ConfirmCommandHostParams; result: ConfirmCommandHostResult };
  'ai.confirmGit': { params: ConfirmGitHostParams; result: ConfirmGitHostResult };
  'ai.confirmBrowser': { params: ConfirmBrowserHostParams; result: ConfirmBrowserHostResult };
  /** Вопрос человеку с ожиданием ответа: инструмент `ask`. */
  'ai.ask': { params: AskHostParams; result: AskHostResult };
  /** Пометки языка живут в renderer (в редакторе), а не на диске. */
  'ai.getDiagnostics': { params: DiagnosticsHostParams; result: DiagnosticsHostResult };
  /** Показать файл в редакторе: открытие вкладки — тоже дело renderer. */
  'ai.openFile': { params: OpenFileHostParams; result: OpenFileHostResult };
}

export type HostMethodName = keyof HostMethods;
export type HostParamsOf<M extends HostMethodName> = HostMethods[M]['params'];
export type HostResultOf<M extends HostMethodName> = HostMethods[M]['result'];

/* ── Контракт RPC ───────────────────────────────────────────────────────── */

/**
 * Таблица методов. Main обязан зарегистрировать все ключи (это проверяет
 * компилятор в `main/ipc/register.ts`), renderer получает автовывод типов
 * аргументов и результата из имени метода.
 */
export interface ChuiMethods {
  'app.info': { params: void; result: AppInfo };

  'dialog.pickFolder': { params: { title?: string }; result: { path: string | null } };
  /**
   * Выбор пути для сохранения файла ПОД ДРУГИМ ИМЕНЕМ (Save As). `defaultPath` —
   * папка и имя текущего файла: диалог открывается на них, а не на прошлом месте.
   */
  'dialog.saveFile': { params: { title?: string; defaultPath?: string }; result: { path: string | null } };
  'dialog.confirm': {
    params: { title: string; message: string; detail?: string; confirmLabel?: string };
    result: { confirmed: boolean };
  };
  /**
   * Закрытие окна с несохранёнными файлами: исходов три, а не два, поэтому не
   * `dialog.confirm`. Файлы — полные пути: имена для диалога выводит main.
   */
  'dialog.confirmClose': {
    params: { files: string[] };
    result: { choice: 'save' | 'discard' | 'cancel' };
  };
  /**
   * Выбор картинок системным диалогом. Читает файлы и отдаёт data-URL сам main:
   * renderer не имеет доступа к файловой системе и не должен его получать.
   */
  'dialog.pickImages': { params: void; result: PickedImage[] };

  'workspace.open': { params: { path: string }; result: WorkspaceInfo };
  'workspace.readDir': { params: { path: string }; result: DirEntry[] };
  'workspace.readFile': { params: { path: string }; result: FileContent };
  /** Прочитать файл-картинку для вьюера. Текстом её не открыть: бинарь. */
  'workspace.readImage': { params: { path: string }; result: ViewImage };
  'workspace.writeFile': { params: { path: string; text: string }; result: { mtimeMs: number } };
  'workspace.stat': { params: { path: string }; result: FileStat };

  /*
   * Удалённые файловые системы (SSH, WSL, контейнер): адрес собирается из схемы и
   * пути (см. `shared/fs-address.ts`), а main ходит туда клиентом системы
   * (`main/workspace/remote-fs.ts`). Отдельные методы, а не общие с `workspace.*`:
   * путь-адрес не проверяется `safePath` и в списки локальных корней не попадает.
   */
  'remote.check': { params: { address: string }; result: { ok: boolean; detail: string } };
  'remote.readDir': { params: { address: string }; result: DirEntry[] };
  'remote.readFile': { params: { address: string; maxBytes?: number }; result: { text: string; truncated: boolean } };
  'remote.writeFile': { params: { address: string; text: string }; result: { ok: boolean } };
  'remote.stat': {
    params: { address: string };
    result: { exists: boolean; kind: 'file' | 'directory'; size: number; mtimeMs: number };
  };
  'remote.mkdir': { params: { address: string }; result: { ok: boolean } };
  'remote.rename': { params: { from: string; to: string }; result: { ok: boolean } };
  'remote.remove': { params: { address: string }; result: { ok: boolean } };
  'workspace.search': { params: SearchOptions; result: SearchResult };
  /** Относительные (POSIX) пути всех файлов проекта — для быстрого открывателя. */
  'workspace.listFiles': { params: void; result: string[] };
  /** Сравнить две папки рабочей области: какие файлы различаются. */
  'workspace.compareFolders': { params: { left: string; right: string }; result: FolderCompareResult };
  /** Сессия проекта: восстановление при открытии и сохранение изменений. */
  'session.load': { params: { root: string }; result: SessionState };
  'session.save': { params: { root: string; state: SessionState }; result: void };
  'workspace.replace': { params: ReplaceFilesOptions; result: ReplaceFilesResult };
  /**
   * Поиск по структуре кода по всему проекту — предпросмотр, без правок. Возвращает
   * файлы с местами и общим числом вхождений (по тому же образцу, что и в файле).
   */
  'workspace.structuralSearch': { params: StructuralProjectOptions; result: StructuralProjectMatches };
  /** Замена по структуре по всему проекту: изменённые пути и число замен. */
  'workspace.structuralReplace': { params: StructuralProjectOptions; result: ReplaceFilesResult };
  /**
   * Где имя объявлено ЭКСПОРТОМ: разбор по языку (JS/TS и Python) без языкового сервера —
   * такого запроса в LSP нет. Возвращает файлы с местами (строка, вид экспорта).
   */
  'workspace.findExports': { params: ExportsQuery; result: ExportsResult };
  /**
   * Наследование имени по проекту: кто наследует (`subtypes`) или от кого наследует
   * (`supertypes`). Свой разбор строк (JS/TS и Python), без языкового сервера.
   */
  'workspace.findInheritance': { params: InheritanceQuery; result: InheritanceResult };
  'workspace.createFile': { params: { path: string; contents?: string }; result: { path: string } };
  'workspace.createDir': { params: { path: string }; result: { path: string } };
  'workspace.rename': { params: { from: string; to: string }; result: { path: string } };
  /**
   * Переписать импорты, ведущие на переименованный файл (или в переименованную
   * папку): относительные спецификаторы в файлах проекта переводятся на новый путь.
   */
  'workspace.updateImports': { params: { oldPath: string; newPath: string }; result: { files: string[] } };
  /** Копия файла или папки: существующий объект в цели не перетирается. */
  'workspace.copy': { params: { from: string; to: string }; result: { path: string } };
  'workspace.trash': { params: { path: string }; result: void };
  /**
   * Карта проекта: языки, манифесты, тесты и точки входа. Собирается обходом
   * имён без чтения содержимого — дёшево и без последствий для больших проектов.
   */
  'project.scan': { params: void; result: ProjectScan };
  /**
   * Настройки уровня проекта из `<root>/.chui_ide/`: редактор, дерево, запуск и
   * LSP. Лежат в самом проекте, чтобы их можно было версионировать вместе с кодом,
   * в отличие от userData. Макет панелей сюда не входит: он общий для всех проектов.
   */
  'project.config': { params: { root: string }; result: ProjectSettings };
  'project.updateSettings': { params: { root: string; patch: ProjectSettings }; result: ProjectSettings };

  /** Виртуальные окружения Python в проекте: главное — первым. */
  'python.environments': { params: void; result: PythonEnvironment[] };
  /** Интерпретаторы Python, найденные в системе: выбор версии при создании окружения. */
  'python.interpreters': { params: void; result: PythonInterpreter[] };
  /** Создать окружение, при желании поставив в него пакеты. Долгий вызов со событиями. */
  'python.createVenv': { params: CreateVenvOptions; result: CreateVenvResult };
  /**
   * Окружение по папке, которую указал человек: своё, созданное раньше, возможно вне
   * проекта. Возвращает окружение либо объяснение, почему папка не подошла.
   */
  'python.venvAt': { params: { path: string }; result: VenvLookup };
  /** Команда активации главного окружения для терминала; null — окружения нет. */
  'python.activateCommand': { params: void; result: { command: string | null } };
  /** Установленные пакеты главного окружения: имя и версия. */
  'python.packages': { params: void; result: InstalledPackage[] };
  /** Поставить пакеты или зависимости из requirements.txt. Долгий вызов со событиями. */
  'python.install': { params: PythonInstallOptions; result: PythonInstallResult };
  /** Список тестов проекта: `pytest --collect-only`. */
  'python.tests': { params: void; result: CollectedSuite };
  /** Что не так с окружениями проекта: битый `pyvenv.cfg`, нет pip, пропал базовый питон. */
  'python.envHealth': { params: void; result: EnvironmentHealth[] };
  /** Отформатировать текст файла инструментом окружения (ruff или black). */
  'python.format': { params: { path: string; text: string }; result: PythonFormatResult };
  /**
   * Профиль строк файла: свой профилировщик на стандартной библиотеке исполняет
   * скрипт и возвращает, сколько времени прошло на каждой строке.
   */
  'python.profileLines': { params: { path: string; args?: string[] }; result: PythonLineProfileResult };

  /** Окружение Node: версия Node и менеджер пакетов проекта. */
  'node.info': { params: void; result: NodeInfo };
  /** Установленные пакеты проекта: то, что лежит в `node_modules`. */
  'node.packages': { params: void; result: NodePackage[] };
  /** Что не так с окружением проекта: нет `node_modules`, версия Node не под `engines.node`. */
  'node.envHealth': { params: void; result: NodeEnvironmentHealth[] };
  /** Отформатировать текст файла инструментом проекта (prettier или biome). */
  'node.format': { params: { path: string; text: string }; result: NodeFormatResult };
  /** Список тестов проекта: `vitest list`, `jest --listTests` или файлы для `node --test`. */
  'node.tests': { params: void; result: NodeTestSuite };
  /**
   * Какие из импортированных модулей проект не видит: для Python — интерпретатор,
   * для JS/TS — `node_modules`. Пустой ответ — либо всё на месте, либо судить
   * не по чему (нет интерпретатора, не найден каталог пакетов).
   */
  'imports.missing': {
    params: { language: string; path: string; modules: string[]; locals: string[] };
    result: { missing: string[] };
  };
  /**
   * Пакеты проекта (монорепо): где лежат манифесты. Нужны панели изменений, чтобы
   * разложить правки по пакетам, а не показывать один общий список файлов.
   */
  'project.packages': { params: void; result: ProjectPackage[] };
  /**
   * Куда прогон с покрытием пишет отчёт. `path` — файл для pytest
   * (`--cov-report=json:…`), `dir` — каталог, куда раннеры Node (vitest, jest)
   * кладут свой `coverage-final.json`. Оба — во временном каталоге.
   */
  'project.coverageJsonPath': { params: void; result: { path: string; dir: string } };
  /**
   * Прочитать файл отчёта покрытия, который IDE сама попросила у раннера. Лежит
   * он во временном каталоге, куда `workspace.readFile` не пускает, — поэтому за
   * него отвечает main. Читает только СВОЙ файл: путь он вычисляет из корня.
   */
  'project.readCoverage': { params: { kind: 'pytest' | 'node' }; result: { text: string | null } };

  'git.status': { params: void; result: GitStatus };
  /**
   * Diff того, что попадёт в коммит: с индекса — индекс против HEAD, без него —
   * рабочее дерево против индекса. Нужен для сообщения коммита по diff.
   */
  'git.commitDiff': { params: void; result: GitCommitDiff };
  /** Блоки изменений файла: для действий прямо из жёлоба редактора. */
  'git.fileHunks': { params: { path: string }; result: GitFileHunks };
  /** Откатить ОДИН блок файла в рабочем дереве (обратный `git apply -R`). */
  'git.discardHunk': { params: { path: string; index: number }; result: GitStatus };
  /**
   * Сводка по всем корням рабочей области: какие папки — репозитории git, какие
   * в них ветки и сколько правок. Нужна панели изменений, чтобы видеть всю область
   * сразу, а не только активную папку (`shared/git-multiroot.ts`).
   */
  'git.summary': { params: void; result: GitRootSummary[] };
  'git.init': { params: void; result: GitStatus };
  'git.stage': { params: { paths: string[] }; result: GitStatus };
  'git.unstage': { params: { paths: string[] }; result: GitStatus };
  'git.discard': { params: { paths: string[] }; result: GitStatus };
  'git.commit': { params: { message: string; paths?: string[]; amend?: boolean }; result: GitCommitInfo };
  'git.diff': { params: { path: string; staged?: boolean; commit?: string }; result: GitDiff };
  'git.stageHunk': { params: { path: string; index: number }; result: GitStatus };
  'git.unstageHunk': { params: { path: string; index: number }; result: GitStatus };
  /**
   * Происхождение строк файла: кто, когда и каким коммитом их менял. Без
   * границ — весь файл; неотслеживаемый файл даёт пустой список, а не сбой.
   */
  'git.blame': { params: { path: string; startLine?: number; endLine?: number }; result: BlameLine[] };
  /** История коммитов: все или только трогавшие указанный файл. */
  'git.log': { params: { path?: string; limit?: number }; result: GitCommit[] };
  /**
   * Содержимое файла в HEAD — база для полосок изменений в жёлобе. `null` —
   * файл вне репозитория; пустая строка — файл новый или без коммитов.
   */
  'git.headText': { params: { path: string }; result: string | null };

  /* Отложенные изменения (stash): список, сохранить, применить, всплыть, удалить. */
  'git.stashList': { params: void; result: GitStashEntry[] };
  'git.stashSave': { params: { message?: string; includeUntracked?: boolean }; result: GitStatus };
  'git.stashApply': { params: { index: number }; result: GitStatus };
  'git.stashPop': { params: { index: number }; result: GitStatus };
  'git.stashDrop': { params: { index: number }; result: GitStatus };
  /** Полный патч записи — для просмотра содержимого. */
  'git.stashShow': { params: { index: number }; result: string };

  /* Отдельные коммиты и теги: перенос, откат, сброс и метки. */
  'git.cherryPick': { params: { commit: string }; result: GitStatus };
  'git.revert': { params: { commit: string }; result: GitStatus };
  'git.reset': { params: { mode: 'soft' | 'mixed' | 'hard'; commit: string }; result: GitStatus };
  /**
   * Интерактивный rebase последних `count` коммитов: список шагов задаёт вызывающий
   * (перестановка, склейка, переписывание сообщения, drop). Возвращает исход операции:
   * rebase может завершиться, остановиться на конфликте или на шаге `edit`.
   */
  'git.rebase': { params: { count: number; items: RebaseTodoItem[] }; result: GitRebaseResult };
  /** Продолжить остановленный rebase (после разрешённого конфликта или шага `edit`). */
  'git.rebaseContinue': { params: void; result: GitRebaseResult };
  /** Прервать rebase: ветка возвращается туда, где была до запуска. */
  'git.rebaseAbort': { params: void; result: GitStatus };
  /** Пропустить текущий коммит остановленного rebase. */
  'git.rebaseSkip': { params: void; result: GitRebaseResult };
  'git.tags': { params: void; result: GitTag[] };
  'git.createTag': { params: { name: string; message?: string; commit?: string }; result: GitStatus };
  'git.deleteTag': { params: { name: string }; result: GitStatus };
  'git.pushTag': { params: { name: string }; result: GitNetworkResult };

  /* Ветки, .gitignore и журнал ссылок (reflog). */
  'git.deleteBranch': { params: { name: string; force?: boolean }; result: GitStatus };
  'git.renameBranch': { params: { from: string; to: string }; result: GitStatus };
  'git.ignore': { params: { paths: string[] }; result: GitStatus };
  /** Подмодули репозитория: состояние нужно дереву, чтобы пометить папки. */
  'git.submodules': { params: void; result: GitSubmodule[] };
  /** Забрать код подмодулей (`update --init --recursive`). */
  'git.submoduleUpdate': { params: void; result: GitStatus };
  /* Дополнительные рабочие каталоги одного репозитория (worktree). */
  'git.worktrees': { params: void; result: GitWorktree[] };
  /** Добавить каталог: существующая ветка или новая; без них — отделённый указатель. */
  'git.worktreeAdd': { params: { path: string; branch?: string; newBranch?: string }; result: GitWorktree[] };
  /** Удалить каталог; `force` — когда в нём есть незакоммиченные правки. */
  'git.worktreeRemove': { params: { path: string; force?: boolean }; result: GitWorktree[] };
  /** Убрать записи о каталогах, которых уже нет на диске. */
  'git.worktreePrune': { params: void; result: GitWorktree[] };
  /**
   * Какие из путей игнорируются git (`.gitignore`). Спрашиваем только про видимые
   * в дереве пути: полный список игнорируемого читать незачем.
   */
  'git.checkIgnore': { params: { paths: string[] }; result: string[] };
  /** Журнал ссылок: чем можно откатить неудачный merge, rebase или reset. */
  'git.reflog': { params: { limit?: number }; result: GitReflogEntry[] };
  /** История в виде графа веток — текстом, как её рисует git. */
  'git.logGraph': { params: { limit?: number }; result: string };
  /**
   * Сравнение двух ссылок (веток, коммитов, тегов): список изменённых файлов
   * со статусом и счётчиком строк. Для просмотра различий между ветками.
   */
  'git.compareRefs': { params: { base: string; head: string }; result: GitRefDiff };
  /** Один файл между двумя ссылками: слева содержимое из `base`, справа из `head`. */
  'git.diffRefs': { params: { base: string; head: string; path: string }; result: GitDiff };
  /* Пошаговый поиск «багованного» коммита (bisect). */
  /** Текущее состояние поиска: идёт ли он, где стоит и сколько осталось. */
  'git.bisectState': { params: void; result: GitBisectState };
  /** Начать поиск; `bad` и `good` — известные плохой и хороший коммиты. */
  'git.bisectStart': { params: { bad?: string; good?: string }; result: GitBisectState };
  /** Пометить проверяемый коммит хорошим, плохим или пропустить его. */
  'git.bisectMark': { params: { mark: 'good' | 'bad' | 'skip' }; result: GitBisectState };
  /** Закончить поиск: ветка возвращается туда, где была до него. */
  'git.bisectReset': { params: void; result: GitStatus };
  /** Три версии конфликтного файла: общий предок и обе стороны. */
  'git.conflictParts': { params: { path: string }; result: GitConflictParts };
  /** Отметить конфликт решённым: содержимое файла уходит в индекс (`git add`). */
  'git.markResolved': { params: { path: string }; result: GitStatus };
  'git.branches': { params: void; result: GitBranch[] };
  'git.checkout': { params: { name: string; create?: boolean }; result: GitStatus };
  'git.remotes': { params: void; result: GitRemote[] };
  'git.fetch': { params: void; result: GitNetworkResult };
  /** `fetch` во всех корнях области: итог по каждой папке (`shared/git-multiroot.ts`). */
  'git.fetchRoots': { params: void; result: GitRootFetch[] };
  /** `mode` — как вливать (`merge`/`rebase`/`ff-only`); не задан — как настроено в git. */
  'git.pull': { params: { mode?: PullMode }; result: GitNetworkResult };
  'git.push': { params: { setUpstream?: boolean; force?: boolean }; result: GitNetworkResult };
  'git.clone': { params: { url: string; directory: string }; result: { path: string } };

  /* Площадка хостинга: запросы на слияние (PR/MR) через `gh`/`glab`. */
  /** Площадка репозитория, доступность клиента, вход и список запросов. */
  'git.forgeInfo': { params: { remote?: string }; result: ForgeInfo };
  /** Создать запрос на слияние из ветки. */
  'git.forgeCreate': {
    params: { title: string; body?: string; target?: string; source?: string; draft?: boolean };
    result: ForgeInfo;
  };
  /** Забрать ветку запроса в рабочий каталог (клиент делает fetch и checkout). */
  'git.forgeCheckout': { params: { number: number }; result: GitStatus };
  /** Комментарии запроса на слияние (обсуждение). */
  'git.forgeComments': { params: { number: number }; result: ForgeComment[] };
  /** Написать комментарий к запросу: возвращает обновлённое обсуждение. */
  'git.forgeComment': { params: { number: number; body: string }; result: ForgeComment[] };
  /** Задачи площадки (issues): список открытых и закрытых. */
  'git.forgeIssues': { params: void; result: ForgeIssue[] };
  /** Создать задачу: возвращает обновлённый список. */
  'git.forgeIssueCreate': { params: { title: string; body?: string }; result: ForgeIssue[] };
  /** Закрыть задачу: возвращает обновлённый список. */
  'git.forgeIssueClose': { params: { number: number }; result: ForgeIssue[] };
  /** Комментарии задачи (обсуждение). */
  'git.forgeIssueComments': { params: { number: number }; result: ForgeComment[] };
  /** Написать комментарий к задаче: возвращает обновлённое обсуждение. */
  'git.forgeIssueComment': { params: { number: number; body: string }; result: ForgeComment[] };
  /** Прогоны CI площадки (Actions/Pipelines): свежие сверху. */
  'git.forgePipelines': { params: void; result: ForgePipeline[] };
  /** Перезапустить прогон: возвращает обновлённый список. */
  'git.forgePipelineRerun': { params: { id: number }; result: ForgePipeline[] };
  /** Уведомления площадки (непрочитанные ветки / незакрытые дела). */
  'git.forgeNotifications': { params: void; result: ForgeNotification[] };
  /** Отметить уведомление прочитанным: возвращает обновлённый список. */
  'git.forgeNotificationRead': { params: { id: string }; result: ForgeNotification[] };
  /** Открыть ссылку в браузере системы (страницы площадки и запросов). */
  'shell.openExternal': { params: { url: string }; result: { ok: boolean } };
  /** Показать файл или папку в проводнике системы (выделить объект). */
  'shell.revealInOS': { params: { path: string }; result: { ok: boolean } };
  /** Открыть файл программой системы: внешний редактор, просмотрщик, что настроено. */
  'shell.openPath': { params: { path: string }; result: { ok: boolean } };
  /** Открыть терминал системы в папке. `ok: false` — подходящего терминала нет. */
  'shell.openTerminal': { params: { path: string }; result: { ok: boolean; command?: string } };

  /* Встроенный браузер: страница — вкладка в редакторе, рисует её WebContentsView.
     Место вложения задаётся числами, потому что оно не в DOM, а отдельным слоем
     окна; состояние вкладки приходит обратным событием `PushTopic.BrowserNav`. */
  /** Завести вложение для вкладки. Адрес приходит уже нормализованным. */
  'browser.viewCreate': { params: { id: string; url: string }; result: { ok: boolean; reason?: string } };
  /** Показать вложение на месте области редактора. */
  'browser.viewShow': { params: { id: string; rect: BrowserRect }; result: { ok: boolean } };
  /** Спрятать вложение: активна не страница (файл, чат, картинка). */
  'browser.viewHide': { params: void; result: { ok: boolean } };
  /** Область редактора переехала или изменилась — переставить вложение. */
  'browser.viewLayout': { params: { rect: BrowserRect }; result: { ok: boolean } };
  /** Действие над вкладкой: назад, вперёд, обновить, стоп, переход, DevTools. */
  'browser.viewCommand': {
    params: { id: string; action: BrowserAction; url?: string };
    result: { ok: boolean; reason?: string };
  };
  /** Закрыть вложение вкладки: она ушла из полосы. */
  'browser.viewClose': { params: { id: string }; result: { ok: boolean } };
  /** Закрыть все вложения сразу. */
  'browser.viewCloseAll': { params: void; result: { ok: boolean } };
  /** Поделиться вкладкой с ассистентом: агент работает в этой же странице и сессии. */
  'browser.viewShare': { params: { id: string }; result: { ok: boolean } };
  /** Отозвать общий доступ: агент снова заводит свою вкладку во временной сессии. */
  'browser.viewUnshare': { params: void; result: { ok: boolean } };
  /** Снимок страницы вкладки (data-URL): уходит в чат как вложение-картинка. */
  'browser.viewCapture': { params: { id: string }; result: { ok: boolean; dataUrl?: string; reason?: string } };
  /** Журнал консоли страницы вкладки: строки для вложения-контекста. */
  'browser.viewConsole': { params: { id: string }; result: { ok: boolean; lines: string[] } };
  /** Масштаб страницы: кнопки шапки и Ctrl+колесо. Возвращает получившийся масштаб. */
  'browser.viewZoom': {
    params: { id: string; mode: BrowserZoomMode };
    result: { ok: boolean; zoom?: number; reason?: string };
  };
  /**
   * Выбрать элемент страницы мышью (отмена — Esc). Возвращает его описание для чата
   * и снимок области элемента: подсветить элемент в DOM нельзя — страница не в DOM.
   */
  'browser.viewPick': {
    params: { id: string };
    result: { ok: boolean; element?: BrowserPickedElement; shot?: { dataUrl: string; bytes: number }; reason?: string };
  };

  /* Личность автора, подпись коммитов и ключи: настройки git, а не IDE. */
  /** Действующие имя, почта, подпись и хранилище паролей. */
  'git.identity': { params: void; result: GitIdentity };
  /** Записать настройки в локальный конфиг репозитория. */
  'git.setIdentity': { params: { values: Partial<GitIdentity> }; result: GitIdentity };
  /** Открытые ключи из `~/.ssh`: тип, комментарий и отпечаток. */
  'git.sshKeys': { params: void; result: GitSshKey[] };

  /* Git LFS: большие файлы в отдельном хранилище. */
  /** Что знает репозиторий: доступен ли git-lfs, шаблоны и файлы под LFS. */
  'git.lfsInfo': { params: void; result: GitLfsInfo };
  /** Взять шаблон под LFS (`git lfs track`) — строка уходит в `.gitattributes`. */
  'git.lfsTrack': { params: { pattern: string }; result: GitLfsInfo };
  /** Перестать вести шаблон через LFS (`git lfs untrack`). */
  'git.lfsUntrack': { params: { pattern: string }; result: GitLfsInfo };
  /** Подтянуть содержимое больших файлов (`git lfs pull`). */
  'git.lfsPull': { params: void; result: GitLfsInfo };
  /** Подготовить репозиторий к LFS: хуки `git lfs install --local`. */
  'git.lfsInstall': { params: void; result: GitLfsInfo };

  /* Разреженный рабочий каталог (sparse checkout): что из репозитория выложено на диск. */
  /** Включён ли режим и какие каталоги выбраны. */
  'git.sparseInfo': { params: void; result: GitSparseInfo };
  /** Задать набор каталогов целиком (`git sparse-checkout set --cone`). */
  'git.sparseSet': { params: { directories: string[] }; result: GitSparseInfo };
  /** Добавить каталог к текущему набору (`git sparse-checkout add`). */
  'git.sparseAdd': { params: { directory: string }; result: GitSparseInfo };
  /** Выключить разреженный режим: на диск возвращается весь репозиторий. */
  'git.sparseDisable': { params: void; result: GitSparseInfo };

  /* Замечания к коду (code review): хранятся в проекте, источник истины — renderer. */
  /** Замечания текущего проекта. */
  'review.load': { params: void; result: ReviewThread[] };
  /** Записать список замечаний целиком; возвращает то, что легло на диск. */
  'review.save': { params: { threads: ReviewThread[] }; result: ReviewThread[] };

  /* Локальная история файла: снимки содержимого, снятые при сохранении. */
  /** Снимки файла, новые в начале. */
  'history.list': { params: { path: string }; result: HistoryEntry[] };
  /** Содержимое одного снимка; ошибка, если снимка уже нет. */
  'history.read': { params: { path: string; id: string }; result: { text: string } };
  /** Убрать историю файла целиком. */
  'history.clear': { params: { path: string }; result: void };

  'terminal.create': { params: TerminalCreateOptions; result: TerminalSession };
  'terminal.write': { params: { id: string; data: string }; result: void };
  'terminal.resize': { params: { id: string; cols: number; rows: number }; result: void };
  'terminal.kill': { params: { id: string }; result: void };

  'window.getState': { params: void; result: WindowState };
  'window.minimize': { params: void; result: void };
  'window.toggleMaximize': { params: void; result: WindowState };
  'window.close': { params: void; result: void };
  /** Действие меню, которое умеет только main: буфер обмена, масштаб, окно. */
  'menu.role': { params: { role: MenuRole }; result: void };

  /* Стартовое окно: список недавних проектов и переход к IDE. */
  'app.recentProjects': { params: void; result: RecentProject[] };
  'app.openProject': { params: { path: string }; result: { root: string; name: string } };
  /**
   * Закрытие проекта: main поднимает стартовое окно со списком проектов, а окно IDE
   * закрывает сам renderer — закрытие в обработчике уничтожило бы отправителя до ответа.
   */
  'app.closeProject': { params: void; result: void };
  /**
   * Создать проект: папка с файлами-заготовками выбранного вида. Возвращает путь
   * новой папки — окно открывает его тем же путём, что и склонированный.
   */
  'app.createProject': {
    params: { name: string; directory: string; kind: ProjectKind };
    result: { path: string };
  };
  'app.forgetProject': { params: { path: string }; result: RecentProject[] };
  /** Корень, открытый в main: окно IDE забирает его при старте. */
  'workspace.current': { params: void; result: { root: string | null; roots: WorkspaceRoot[] } };
  /** Добавить папку в рабочую область: в одном окне может быть несколько корней. */
  'workspace.addRoot': { params: { path: string }; result: WorkspaceInfo };
  /** Убрать корень; активным становится первый оставшийся (`null` — область пуста). */
  'workspace.removeRoot': { params: { path: string }; result: WorkspaceInfo | null };
  /** Сделать корень активным — им отвечают git, поиск и запуск без явного файла. */
  'workspace.setActiveRoot': { params: { path: string }; result: WorkspaceInfo };

  'settings.get': { params: void; result: Settings };
  'settings.update': { params: SettingsPatch; result: Settings };
  'settings.revealFile': { params: void; result: { path: string } };

  /* Темы из файла: импорт, экспорт шаблона и снятие. */
  'theme.import': { params: void; result: { settings: Settings; name: string | null } };
  /** Импорт набора значков дерева из JSON-файла: правила «маска → значок». */
  'explorer.importBadges': { params: void; result: { settings: Settings; count: number } };
  'theme.export': { params: { contents: string; name: string }; result: { path: string | null } };
  'theme.clear': { params: void; result: Settings };

  /* Языковые серверы: синхронизация документа и перезапуск. */
  'lsp.open': { params: { path: string; languageId: string; text: string }; result: void };
  'lsp.change': { params: { path: string; text: string }; result: void };
  'lsp.close': { params: { path: string }; result: void };
  'lsp.restart': { params: void; result: LspStatus };
  'lsp.status': { params: void; result: LspStatus };
  /**
   * Прогреть серверы языков проекта, не дожидаясь открытия файлов (см. `LspService.prewarm`).
   * Языки приходят из карты проекта: у каждого должен быть сервер в настройках.
   */
  'lsp.prewarm': { params: { languages: string[] }; result: void };
  /** Символы проекта по запросу: классы, функции, переменные — «перейти к символу». */
  'lsp.symbols': { params: { query: string }; result: ProjectSymbol[] };
  /**
   * Состояние карты символов проекта (см. `main/symbols/indexer.ts`): собрана ли она,
   * сколько файлов и объявлений. Карта собирается в фоне при открытии проекта, и по
   * этому ответу видно, докуда она дошла. `warming` — поиск уже отвечает тем, что есть.
   */
  'index.status': { params: void; result: SymbolIndexStatus };
  /** Пересобрать карту символов в фоне: изменившиеся файлы разберутся заново. */
  'index.rebuild': { params: void; result: SymbolIndexStatus };
  /**
   * Поиск ТОЛЬКО по карте символов, без языковых серверов: им дополняются подсказки
   * при обычном наборе. `lsp.symbols` спрашивает ещё и серверы, а на каждую паузу
   * в наборе это слишком дорого — карта отвечает мгновенно.
   */
  'index.find': { params: { query: string }; result: ProjectSymbol[] };
  /**
   * Что тип умеет и от кого это унаследовано: члены самого типа и предков, без тел
   * и без языкового сервера. Ответ собирается по карте символов (см. `index.status`),
   * поэтому приходит сразу, а `phase` говорит, стоит ли переспросить позже.
   */
  'index.inherited': { params: { name: string }; result: InheritedResult };
  /** Найти в PATH известные языковые серверы и вернуть готовые конфигурации. */
  'lsp.detect': { params: void; result: LspServerConfig[] };
  /**
   * Прокси-запрос к языковому серверу открытого файла: подсказки, наведение,
   * переход к определению. Форму params/result задаёт LSP, детали — в renderer.
   */
  'lsp.request': { params: { path: string; method: string; params: unknown }; result: unknown };
  /**
   * Чем сервер готов открывать подсказки: знаки-триггеры, знаки «принять» и умение
   * доводить элемент отдельным запросом (см. `LspService.completionTriggers`). Renderer
   * открывает попап по знакам сервера, а не только по точке.
   */
  'lsp.capabilities': {
    params: { path: string };
    result: { triggerCharacters: string[]; allCommitCharacters: string[]; resolveProvider: boolean };
  };
  /**
   * Семантическая подсветка файла: точные роли от сервера (см. `LspService.semanticTokens`).
   * Ответ уже разобран в main (там легенда сервера) — renderer получает готовые участки.
   */
  'lsp.semanticTokens': { params: { path: string }; result: SemanticToken[] };
  /**
   * Отформатировать УЧАСТОК файла (`textDocument/rangeFormatting`): выделение или только
   * что вставленный кусок. Правки с позициями 1-based; пусто — сервер не умеет или менять
   * нечего. Инструмент проекта (ruff, prettier) так не умеет — он форматирует файл целиком.
   */
  'lsp.formatRange': {
    params: { path: string; startLine: number; startColumn: number; endLine: number; endColumn: number };
    result: TextEdit[];
  };

  /**
   * Словарь орфографии: слова из файла, найденного в системе (aspell, hunspell,
   * LibreOffice), и путь к нему. Пустой список и `null` — словаря в системе нет.
   */
  'spell.dictionary': { params: void; result: { words: string[]; source: string | null } };

  /* Отладчик: сессия debugpy по протоколу DAP. */
  /** Начать отладку файла интерпретатором окружения. */
  'debug.start': {
    params: { program: string; args?: string[]; env?: Record<string, string>; cwd?: string };
    result: { ok: boolean; message: string };
  };
  /**
   * Подключиться к уже запущенному процессу: он стартовал сам, и запускать его
   * заново нельзя — отлаживаем то, что работает.
   */
  'debug.attach': { params: DebugAttachOptions; result: { ok: boolean; message: string } };
  /** Точки останова файла: набор заменяется целиком, как в DAP. */
  'debug.setBreakpoints': {
    params: {
      path: string;
      breakpoints: Array<{ line: number; condition?: string; hitCondition?: string; logMessage?: string }>;
    };
    result: DebugBreakpoint[];
  };
  /**
   * Останов по исключению: какие исключения останавливают программу. Набор
   * заменяется целиком, как и точки останова.
   */
  'debug.setExceptionBreakpoints': { params: DebugExceptionFilters; result: void };
  'debug.continue': { params: void; result: void };
  'debug.step': { params: { kind: 'over' | 'into' | 'out' }; result: void };
  'debug.pause': { params: void; result: void };
  'debug.stop': { params: void; result: void };
  /** Области видимости кадра: локальные, глобальные. */
  'debug.scopes': { params: { frameId: number }; result: DebugScope[] };
  /** Значения области или раскрытого узла. */
  'debug.variables': { params: { reference: number }; result: DebugVariable[] };
  /**
   * Вычислить выражение в контексте кадра: панель «наблюдение».
   * Ошибка выражения — это результат, а не сбой: текст ошибки возвращается как значение.
   */
  'debug.evaluate': { params: { expression: string; frameId?: number }; result: DebugVariable };
  /**
   * Значение выражения для подсказки под курсором. Ошибку не показываем: `null`
   * означает «значения нет», и подсказка не появляется.
   */
  'debug.hover': { params: { expression: string; frameId?: number }; result: DebugVariable | null };
  /** Задать новое значение переменной или поля; `null` — отладчик не смог присвоить. */
  'debug.setVariable': { params: { reference: number; name: string; value: string }; result: DebugVariable | null };
  /** Задать значение произвольному выражению в кадре; `null` — присвоить не удалось. */
  'debug.setExpression': {
    params: { expression: string; value: string; frameId?: number };
    result: DebugVariable | null;
  };

  'ai.setApiKey': { params: { providerId: string; apiKey: string }; result: Settings };
  'ai.clearApiKey': { params: { providerId: string }; result: Settings };
  /** Ключ сервиса веб-поиска: отдельно от провайдеров — это не провайдер модели. */
  'ai.setWebSearchKey': { params: { apiKey: string }; result: Settings };
  'ai.clearWebSearchKey': { params: void; result: Settings };
  /**
   * Поднять серверы MCP из настроек и вернуть их инструменты. Нужно проверке в
   * настройках: без неё конфигурация сервера слепа — ошибку видно только в stderr.
   */
  'ai.mcpTools': { params: void; result: McpServerTools[] };
  /** Проверить адрес и ключ до сохранения провайдера. */
  'ai.test': {
    params: { baseUrl: string; apiKey?: string; providerId?: string };
    result: AiConnectionTestResult;
  };
  'ai.chat': { params: ChatRequest; result: ChatStreamDone };
  /**
   * Подсказка для inline-автодополнения: продолжить код в месте курсора.
   * Отдельно от `ai.chat` — это короткий запрос без истории и инструментов.
   */
  'ai.complete': { params: InlineCompletionRequest; result: InlineCompletionResult };
  /**
   * Сообщение коммита по diff: один запрос к модели без истории и инструментов.
   * Части промпта строит `shared/commit-message.ts` (обрезка diff, очистка ответа).
   */
  'ai.commitMessage': { params: CommitPromptParts; result: CommitMessageResult };
  /**
   * Тест к выделенному коду: один запрос без истории и инструментов, как сообщение
   * коммита. Промпт и очистка ответа — в `shared/test-generation.ts`.
   */
  'ai.generateTest': { params: TestPromptParts; result: TestGenerationResult };
  /**
   * Название беседы по первому обмену: один короткий запрос без истории и
   * инструментов, как у сообщения коммита. Пустое название — не ошибка.
   */
  'ai.chatTitle': { params: ChatTitleParts; result: ChatTitleResult };
  /**
   * Права доступа агента (кнопка в композере). Меняются и во время ответа:
   * main перечитывает их перед каждым действием, а не только в начале прогона.
   */
  'ai.setPermission': { params: { permission: PermissionPreset }; result: void };
  /** История бесед рабочей папки: renderer восстанавливает вкладки после запуска. */
  'ai.chats.load': { params: { root: string }; result: ChatHistory };
  /** Сохранение бесед: renderer — источник истины, main только пишет на диск. */
  'ai.chats.save': { params: { root: string; conversations: ChatConversation[]; activeUid?: string }; result: void };
  /**
   * Команды проекта (`.chui/commands`): готовые запросы для меню композера.
   * Список нужен интерфейсу, а не модели — в промпт он не идёт.
   */
  'ai.commands': { params: void; result: ProjectCommand[] };

  /**
   * Расписание задач проекта (`.chui/schedules.json`): когда ассистент
   * начинает ход сам. Список — источник истины для окна расписания.
   */
  'schedule.list': { params: void; result: TaskSchedule[] };
  /**
   * Завести или изменить задачу: `id` уже есть в списке — правка, иначе новая.
   * Возвращается весь список: окно не должно собирать его из догадок.
   */
  'schedule.save': { params: { schedule: TaskSchedule }; result: TaskSchedule[] };
  'schedule.remove': { params: { id: string }; result: TaskSchedule[] };
  /** Итог запуска: main пересчитывает следующее срабатывание и пишет его в файл. */
  'schedule.finish': { params: { id: string; result: ScheduleResult }; result: TaskSchedule[] };
}

export type MethodName = keyof ChuiMethods;
export type ParamsOf<M extends MethodName> = ChuiMethods[M]['params'];
export type ResultOf<M extends MethodName> = ChuiMethods[M]['result'];
