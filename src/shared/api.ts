/**
 * Единственный контракт между main- и renderer-процессами.
 *
 * Здесь: каналы IPC, доменные типы и таблица RPC-методов (ChuiMethods).
 * Файл попадает и в Node, и в браузер, поэтому импортировать сюда electron/node нельзя.
 */

/* ── Каналы IPC ─────────────────────────────────────────────────────────── */

export const RPC_CALL_CHANNEL = 'chui:rpc:call';
export const RPC_EVENT_CHANNEL = 'chui:rpc:event';
export const RPC_CANCEL_CHANNEL = 'chui:rpc:cancel';
export const PUSH_CHANNEL = 'chui:push';

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

export const RpcErrorCode = {
  Cancelled: -32800,
  InvalidParams: -32602,
  MethodNotFound: -32601,
  Internal: -32603,
  NotFound: -32001,
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

/** Полезная нагрузка события `CloneEvent.Progress`. */
export interface CloneProgressPayload {
  line: string;
}

/* ── Настройки ──────────────────────────────────────────────────────────── */

/** Провайдер в том виде, в каком его видит renderer: без ключа, только факт наличия. */
export interface AiProviderView {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  defaultModel?: string;
  hasApiKey: boolean;
}

export interface AiSettings {
  providers: AiProviderView[];
  activeProviderId?: string;
  activeModel?: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
}

export interface EditorSettings {
  tabSize: number;
  fontSize: number;
  wordWrap: boolean;
  minimap: boolean;
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

/** Полезная нагрузка события `PushTopic.ThemeChanged`: выбор и фактическая схема. */
export interface ThemeChangedPayload {
  theme: ThemeChoice;
  scheme: 'dark' | 'light';
}

export interface Settings {
  ai: AiSettings;
  editor: EditorSettings;
  appearance: AppearanceSettings;
  workspace: WorkspaceSettings;
}

export interface AiSettingsPatch {
  activeProviderId?: string;
  activeModel?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface SettingsPatch {
  ai?: AiSettingsPatch;
  editor?: Partial<EditorSettings>;
  appearance?: Partial<AppearanceSettings>;
}

/* ── AI ─────────────────────────────────────────────────────────────────── */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
}

export interface ChatRequest {
  providerId: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface ChatStreamDone {
  text: string;
  finishReason?: string;
  usage?: ChatUsage;
}

/** Имена событий стрима `ai.chat`. */
export const ChatStreamEvent = {
  Delta: 'delta',
} as const;

export interface ChatDeltaPayload {
  text: string;
}

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

  'workspace.open': { params: { path: string }; result: WorkspaceInfo };
  'workspace.readDir': { params: { path: string }; result: DirEntry[] };
  'workspace.readFile': { params: { path: string }; result: FileContent };
  'workspace.writeFile': { params: { path: string; text: string }; result: { mtimeMs: number } };
  'workspace.stat': { params: { path: string }; result: FileStat };
  'workspace.search': { params: SearchOptions; result: SearchResult };
  'workspace.createFile': { params: { path: string }; result: { path: string } };
  'workspace.createDir': { params: { path: string }; result: { path: string } };
  'workspace.rename': { params: { from: string; to: string }; result: { path: string } };
  'workspace.trash': { params: { path: string }; result: void };

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
  'terminal.list': { params: void; result: TerminalSession[] };

  'window.getState': { params: void; result: WindowState };
  'window.minimize': { params: void; result: void };
  'window.toggleMaximize': { params: void; result: WindowState };
  'window.close': { params: void; result: void };
  'window.getBounds': { params: void; result: WindowBounds };
  'window.setBounds': { params: Partial<WindowBounds>; result: WindowBounds };
  'app.showMenu': { params: void; result: void };

  /* Стартовое окно: список недавних проектов и переход к IDE. */
  'app.recentProjects': { params: void; result: RecentProject[] };
  'app.openProject': { params: { path: string }; result: { root: string; name: string } };
  'app.forgetProject': { params: { path: string }; result: RecentProject[] };
  /** Корень, открытый в main: окно IDE забирает его при старте. */
  'workspace.current': { params: void; result: { root: string | null } };

  'settings.get': { params: void; result: Settings };
  'settings.update': { params: SettingsPatch; result: Settings };
  'settings.revealFile': { params: void; result: { path: string } };

  'ai.setApiKey': { params: { providerId: string; apiKey: string }; result: Settings };
  'ai.clearApiKey': { params: { providerId: string }; result: Settings };
  'ai.models': { params: { providerId: string }; result: string[] };
  'ai.chat': { params: ChatRequest; result: ChatStreamDone };
}

export type MethodName = keyof ChuiMethods;
export type ParamsOf<M extends MethodName> = ChuiMethods[M]['params'];
export type ResultOf<M extends MethodName> = ChuiMethods[M]['result'];
