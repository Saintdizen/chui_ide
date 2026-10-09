/**
 * Единственный контракт между main- и renderer-процессами.
 *
 * Здесь: каналы IPC, доменные типы и таблица RPC-методов (ChuiMethods).
 * Файл попадает и в Node, и в браузер, поэтому импортировать сюда electron/node нельзя.
 */

import type { MenuRole } from './app-menu';
import type { ApplyResult, FileEdit } from './edits';
import type { ProjectScan } from './project-scan';
import type { NodeEnvironmentHealth, NodeInfo, NodePackage } from './node-env';
import type { NodeTestSuite } from './node-tests';
import type { PythonEnvironment, PythonInterpreter } from './python-env';
import type { InstalledPackage } from './python-packages';
import type { CollectedSuite } from './python-tests';
import type { EnvironmentHealth } from './python-health';
import type { ProjectSymbol } from './lsp-symbols';

/* ── Каналы IPC ─────────────────────────────────────────────────────────── */

export const RPC_CALL_CHANNEL = 'chui:rpc:call';
export const RPC_EVENT_CHANNEL = 'chui:rpc:event';
export const RPC_CANCEL_CHANNEL = 'chui:rpc:cancel';
export const PUSH_CHANNEL = 'chui:push';

/** Обратный вызов: main просит renderer выполнить действие и ждёт ответа. */
export const HOST_REQUEST_CHANNEL = 'chui:host:request';
export const HOST_REPLY_CHANNEL = 'chui:host:reply';

/** Темы широковещательных уведомлений main → renderer. */
export const PushTopic = {
  WorkspaceChanged: 'workspace:changed',
  GitChanged: 'git:changed',
  SettingsChanged: 'settings:changed',
  MenuCommand: 'menu:command',
  TerminalData: 'terminal:data',
  TerminalExit: 'terminal:exit',
  ThemeChanged: 'theme:changed',
  WindowStateChanged: 'window:state',
  LspDiagnostics: 'lsp:diagnostics',
  DebugState: 'debug:state',
  DebugStopped: 'debug:stopped',
  DebugOutput: 'debug:output',
} as const;

/* ── Транспорт ──────────────────────────────────────────────────────────── */

export interface RpcCall {
  id: string;
  method: string;
  params: unknown;
}

export interface RpcError {
  code: number;
  message: string;
  details?: string;
}

export type RpcResult =
  | { id: string; ok: true; value: unknown }
  | { id: string; ok: false; error: RpcError };

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

export type HostReply =
  | { id: string; ok: true; value: unknown }
  | { id: string; ok: false; error: RpcError };

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

export interface DirEntry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number;
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
}

export interface WorkspaceInfo {
  root: string;
  name: string;
  entries: DirEntry[];
}

export interface SearchOptions {
  query: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
  glob?: string;
  /** Только имена файлов с совпадением, без строк — обзор «где это встречается». */
  filesOnly?: boolean;
}

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  text: string;
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

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
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
  dockVisible: boolean;
  /** Какая вкладка нижней панели открыта: `terminal`, `search`, `git`. */
  dockActive?: string;
  sidebarVisible: boolean;
  rightVisible: boolean;
  /** Параметры запуска отладки: аргументы, окружение и рабочий каталог. */
  debugLaunch?: DebugLaunchOptions;
  /** Наблюдаемые в панели отладки выражения. */
  debugWatch?: string[];
  /** Останов по исключению: какие исключения останавливали программу. */
  debugExceptions?: DebugExceptionFilters;
  /** Точки останова отладки по файлам — их рабочее место помнит для проекта. */
  breakpoints?: BreakpointRecord[];
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

export interface GitDiff {
  /** С чем сравниваем: HEAD или индекс. */
  original: string;
  /** Что сравниваем: индекс или рабочее дерево. */
  modified: string;
}

export interface GitCommitInfo {
  hash: string;
  summary: string;
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
}

/** Как показывать невидимые символы. */
export type RenderWhitespace = 'none' | 'boundary' | 'selection' | 'trailing' | 'all';
/** Как мигает курсор. */
export type CursorBlinking = 'blink' | 'smooth' | 'phase' | 'expand' | 'solid';
/** Номера строк: обычные, относительные, скрытые. */
export type LineNumbersMode = 'on' | 'off' | 'relative' | 'interval';
/** Что подсвечивать в строке курсора. */
export type LineHighlightMode = 'none' | 'gutter' | 'line' | 'all';

export interface EditorSettings {
  tabSize: number;
  fontSize: number;
  wordWrap: boolean;
  minimap: boolean;
  /** Лигатуры шрифта: `=>`, `!==` и прочие связки JetBrains Mono. */
  fontLigatures: boolean;
  insertSpaces: boolean;
  /** Язык задаёт свои отступы: Python — 4 пробела, Makefile — символ табуляции. */
  languageIndent: boolean;
  renderWhitespace: RenderWhitespace;
  cursorBlinking: CursorBlinking;
  smoothScrolling: boolean;
  /** Разрешить прокрутку за последнюю строку (в PyCharm так по умолчанию). */
  scrollBeyondLastLine: boolean;
  lineNumbers: LineNumbersMode;
  renderLineHighlight: LineHighlightMode;
  /** Разноцветные парные скобки (в VS Code включено по умолчанию). */
  bracketPairColorization: boolean;
  /** Заголовок области видимости, прилипающий к верху (липкий скролл). */
  stickyScroll: boolean;
  /** Подсказки по мере ввода. */
  quickSuggestions: boolean;
  /** Подсвечивать неиспользуемые импорты и переменные в JS/TS. */
  showUnused: boolean;
  /** Форматировать документ при сохранении (ruff или black из окружения). */
  formatOnSave: boolean;
}

/** Плотность строк дерева проекта. */
export type TreeRowDensity = 'compact' | 'normal' | 'cozy';
/** Порядок детей в дереве. */
export type TreeSort = 'name' | 'type';

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
  /** Открывать файл одним кликом (иначе — двойным). */
  openOnSingleClick: boolean;
  /** Спрашивать подтверждение перед удалением. */
  confirmDelete: boolean;
  /** Шаблоны имён, которые не показываем в дереве (`*.min.js`, `coverage`). */
  exclude: string[];
}

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

/** Схема приложения: светлая, тёмная или системная. */
export type ThemeChoice = 'dark' | 'light' | 'system';
export interface AppearanceSettings {
  theme: ThemeChoice;
}

/** Что приложение помнит о работе: история открытых папок для стартового окна. */
export interface WorkspaceSettings {
  /** Недавние проекты, новые в начале списка. */
  recent: string[];
}

/* ── Python: окружения и создание venv ─────────────────────────────────── */

/** Уровень установки пакетов при создании окружения. */
export type VenvInstallPreset = 'empty' | 'pytest' | 'full';

export interface CreateVenvOptions {
  /** Имя каталога окружения от корня проекта. По умолчанию `.venv`. */
  name?: string;
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

/** Событие прогресса установки: тот же поток, что и у создания окружения. */
export type PythonInstallProgress = VenvProgressPayload;

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

/* ── LSP ───────────────────────────────────────────────────────────────── */

/** Один языковой сервер: язык, команда запуска и включён ли он. */
export interface LspServerConfig {
  /** Идентификатор языка (как в shared/languages.ts): python, typescript, … */
  language: string;
  command: string;
  args: string[];
  enabled: boolean;
}

export interface LspSettings {
  /** Общий выключатель: без него серверы не запускаются. */
  enabled: boolean;
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
}

/** Полезная нагрузка события `PushTopic.LspDiagnostics`. */
export interface LspDiagnosticsPayload {
  path: string;
  diagnostics: LspDiagnostic[];
}

/** Полезная нагрузка события `PushTopic.ThemeChanged`: выбор и фактическая схема. */
export interface ThemeChangedPayload {
  theme: ThemeChoice;
  scheme: 'dark' | 'light';
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
   * текста подставляет значение — как в VS Code и как понимает отладчик.
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
  lsp: LspSettings;
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
  systemPrompt?: string;
  reasoningEffort?: ReasoningEffort;
  /** Сколько шагов делает агент в обычном режиме (страховка от зацикливания). */
  maxSteps?: number;
  /** Сколько шагов делает агент при полном доступе (когда подтверждения не нужны). */
  maxAutopilotSteps?: number;
  /** Спрашивать ли при полном доступе перед необратимыми командами. */
  confirmDangerous?: boolean;
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

export interface SettingsPatch {
  ai?: AiSettingsPatch;
  editor?: Partial<EditorSettings>;
  explorer?: Partial<ExplorerSettings>;
  run?: Partial<RunSettings>;
  appearance?: Partial<AppearanceSettings>;
  lsp?: Partial<LspSettings>;
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
  kind: 'file' | 'selection' | 'problems' | 'note' | 'image';
  /** Короткая подпись для чипа в композере. */
  label: string;
  /** Заголовок блока в промпте: путь файла или описание. */
  title: string;
  text: string;
  /** Для kind='image': сама картинка — data-URL, уходит в модель как изображение. */
  dataUrl?: string;
  /** Размер картинки в байтах: показываем в чипе и проверяем предел. */
  bytes?: number;
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
   * Полный доступ: агент сам применяет правки и запускает команды, не спрашивая.
   * Опасные команды всё равно могут требовать подтверждения — решает main, не renderer.
   */
  autoApprove?: boolean;
  /**
   * Режим плана: агент только читает проект и составляет план, ничего не меняя.
   * Правки и команды в этом режиме не предлагаются и не исполняются.
   */
  planMode?: boolean;
  /** Дополнительный контекст от renderer: выделение, файл, ошибки. */
  attachments?: ChatAttachment[];
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

export interface ChatStreamDone {
  text: string;
  finishReason?: string;
  usage?: ChatUsage;
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
  messages: ChatMessage[];
  usage?: ChatUsage;
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
} as const;

export interface ChatDeltaPayload {
  text: string;
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
  /** Файлы, которых коснулся инструмент без правки документа (создание, удаление, перенос). */
  changes?: ToolFileChange[];
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
}

/** Аргументы `ai.confirmCommand`: команда, которую просит выполнить агент. */
export interface ConfirmCommandHostParams {
  command: string;
}

export interface ConfirmCommandHostResult {
  allowed: boolean;
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
  'ai.confirmCommand': { params: ConfirmCommandHostParams; result: ConfirmCommandHostResult };
  /** Пометки языка живут в Monaco, то есть в renderer. */
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
  'dialog.confirm': {
    params: { title: string; message: string; detail?: string; confirmLabel?: string };
    result: { confirmed: boolean };
  };
  /**
   * Выбор картинок системным диалогом. Читает файлы и отдаёт data-URL сам main:
   * renderer не имеет доступа к файловой системе и не должен его получать.
   */
  'dialog.pickImages': { params: void; result: PickedImage[] };

  'workspace.open': { params: { path: string }; result: WorkspaceInfo };
  'workspace.readDir': { params: { path: string }; result: DirEntry[] };
  'workspace.readFile': { params: { path: string }; result: FileContent };
  'workspace.writeFile': { params: { path: string; text: string }; result: { mtimeMs: number } };
  'workspace.stat': { params: { path: string }; result: FileStat };
  'workspace.search': { params: SearchOptions; result: SearchResult };
  /** Относительные (POSIX) пути всех файлов проекта — для быстрого открывателя. */
  'workspace.listFiles': { params: void; result: string[] };
  /** Сессия проекта: восстановление при открытии и сохранение изменений. */
  'session.load': { params: { root: string }; result: SessionState };
  'session.save': { params: { root: string; state: SessionState }; result: void };
  'workspace.replace': { params: ReplaceFilesOptions; result: ReplaceFilesResult };
  'workspace.createFile': { params: { path: string }; result: { path: string } };
  'workspace.createDir': { params: { path: string }; result: { path: string } };
  'workspace.rename': { params: { from: string; to: string }; result: { path: string } };
  'workspace.trash': { params: { path: string }; result: void };
  /**
   * Карта проекта: языки, манифесты, тесты и точки входа. Собирается обходом
   * имён без чтения содержимого — дёшево и без последствий для больших проектов.
   */
  'project.scan': { params: void; result: ProjectScan };

  /** Виртуальные окружения Python в проекте: главное — первым. */
  'python.environments': { params: void; result: PythonEnvironment[] };
  /** Интерпретаторы Python, найденные в системе: выбор версии при создании окружения. */
  'python.interpreters': { params: void; result: PythonInterpreter[] };
  /** Создать окружение, при желании поставив в него пакеты. Долгий вызов со событиями. */
  'python.createVenv': { params: CreateVenvOptions; result: CreateVenvResult };
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
  'imports.missing': { params: { language: string; modules: string[] }; result: { missing: string[] } };

  'git.status': { params: void; result: GitStatus };
  'git.init': { params: void; result: GitStatus };
  'git.stage': { params: { paths: string[] }; result: GitStatus };
  'git.unstage': { params: { paths: string[] }; result: GitStatus };
  'git.discard': { params: { paths: string[] }; result: GitStatus };
  'git.commit': { params: { message: string; paths?: string[] }; result: GitCommitInfo };
  'git.diff': { params: { path: string; staged?: boolean }; result: GitDiff };
  'git.branches': { params: void; result: GitBranch[] };
  'git.checkout': { params: { name: string; create?: boolean }; result: GitStatus };
  'git.clone': { params: { url: string; directory: string }; result: { path: string } };

  'terminal.create': { params: TerminalCreateOptions; result: TerminalSession };
  'terminal.write': { params: { id: string; data: string }; result: void };
  'terminal.resize': { params: { id: string; cols: number; rows: number }; result: void };
  'terminal.kill': { params: { id: string }; result: void };

  'window.getState': { params: void; result: WindowState };
  'window.minimize': { params: void; result: void };
  'window.toggleMaximize': { params: void; result: WindowState };
  'window.close': { params: void; result: void };
  'window.getBounds': { params: void; result: WindowBounds };
  'window.setBounds': { params: Partial<WindowBounds>; result: WindowBounds };
  /** Действие меню, которое умеет только main: буфер обмена, масштаб, окно. */
  'menu.role': { params: { role: MenuRole }; result: void };

  /* Стартовое окно: список недавних проектов и переход к IDE. */
  'app.recentProjects': { params: void; result: RecentProject[] };
  'app.openProject': { params: { path: string }; result: { root: string; name: string } };
  'app.forgetProject': { params: { path: string }; result: RecentProject[] };
  /** Корень, открытый в main: окно IDE забирает его при старте. */
  'workspace.current': { params: void; result: { root: string | null } };

  'settings.get': { params: void; result: Settings };
  'settings.update': { params: SettingsPatch; result: Settings };
  'settings.revealFile': { params: void; result: { path: string } };

  /* Языковые серверы: синхронизация документа и перезапуск. */
  'lsp.open': { params: { path: string; languageId: string; text: string }; result: void };
  'lsp.change': { params: { path: string; text: string }; result: void };
  'lsp.close': { params: { path: string }; result: void };
  'lsp.restart': { params: void; result: { running: string[] } };
  'lsp.status': { params: void; result: { running: string[] } };
  /** Символы проекта по запросу: классы, функции, переменные — «перейти к символу». */
  'lsp.symbols': { params: { query: string }; result: ProjectSymbol[] };
  /** Найти в PATH известные языковые серверы и вернуть готовые конфигурации. */
  'lsp.detect': { params: void; result: LspServerConfig[] };
  /**
   * Прокси-запрос к языковому серверу открытого файла: подсказки, наведение,
   * переход к определению. Форму params/result задаёт LSP, детали — в renderer.
   */
  'lsp.request': { params: { path: string; method: string; params: unknown }; result: unknown };

  /* Отладчик: сессия debugpy по протоколу DAP. */
  /** Начать отладку файла интерпретатором окружения. */
  'debug.start': { params: { program: string; args?: string[]; env?: Record<string, string>; cwd?: string }; result: { ok: boolean; message: string } };
  /**
   * Подключиться к уже запущенному процессу: он стартовал сам, и запускать его
   * заново нельзя — отлаживаем то, что работает.
   */
  'debug.attach': { params: DebugAttachOptions; result: { ok: boolean; message: string } };
  /** Точки останова файла: набор заменяется целиком, как в DAP. */
  'debug.setBreakpoints': {
    params: { path: string; breakpoints: Array<{ line: number; condition?: string; hitCondition?: string; logMessage?: string }> };
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
  'debug.setExpression': { params: { expression: string; value: string; frameId?: number }; result: DebugVariable | null };

  'ai.setApiKey': { params: { providerId: string; apiKey: string }; result: Settings };
  'ai.clearApiKey': { params: { providerId: string }; result: Settings };
  /** Проверить адрес и ключ до сохранения провайдера. */
  'ai.test': {
    params: { baseUrl: string; apiKey?: string; providerId?: string };
    result: AiConnectionTestResult;
  };
  'ai.chat': { params: ChatRequest; result: ChatStreamDone };
  /**
   * Права доступа агента (кнопка в композере). Меняются и во время ответа:
   * main перечитывает их перед каждым действием, а не только в начале прогона.
   */
  'ai.setPermission': { params: { autoApprove: boolean }; result: void };
  /** История бесед рабочей папки: renderer восстанавливает вкладки после запуска. */
  'ai.chats.load': { params: { root: string }; result: ChatHistory };
  /** Сохранение бесед: renderer — источник истины, main только пишет на диск. */
  'ai.chats.save': { params: { root: string; conversations: ChatConversation[]; activeUid?: string }; result: void };
}

export type MethodName = keyof ChuiMethods;
export type ParamsOf<M extends MethodName> = ChuiMethods[M]['params'];
export type ResultOf<M extends MethodName> = ChuiMethods[M]['result'];
