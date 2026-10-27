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
  /** Проверка модели разрешила команду без человека: в ленте строка «разрешено проверкой». */
  ApprovalReview: 'approval:review',
  /** Список живых агентов изменился: панель подзадач обновляется. */
  Agents: 'agents:changed',
} as const;
