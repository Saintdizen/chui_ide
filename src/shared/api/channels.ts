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
  /** Пометки, снятые обходом проекта: сервер смотрит и закрытые файлы. */
  LspProjectDiagnostics: 'lsp:project-diagnostics',
  LspProgress: 'lsp:progress',
  /** Состав серверов изменился: поднялся, исчез или упал — чип в статусбаре обновляется сам. */
  LspServers: 'lsp:servers',
  DebugState: 'debug:state',
  DebugStopped: 'debug:stopped',
  DebugOutput: 'debug:output',
  BrowserNav: 'browser:nav',
  /** Проверка модели разрешила команду без человека: в ленте строка «разрешено проверкой». */
  ApprovalReview: 'approval:review',
  /**
   * Пауза прогона принята или снята — сразу, не дожидаясь границы шага.
   * Событие `paused` внутри стрима приходит позже, когда цикл дошёл до границы,
   * а до тех пор человек не знает, приняли ли нажатие: кнопка выглядела нажатой
   * и только.
   */
  AiPaused: 'ai:paused',
} as const;
