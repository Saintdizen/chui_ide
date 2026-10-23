import { app, BrowserWindow } from 'electron';
import type { AiService } from '../ai/service';
import type { ChatStore } from '../ai/chat-store';
import type { DebugService } from '../debug/debug';
import type { BrowserPanel } from '../browser/panel';
import type { LspService } from '../lsp/lsp';
import type { SymbolIndexer } from '../symbols/indexer';
import type { McpService } from '../mcp/mcp';
import type { SettingsStore } from '../settings';
import type { GitService } from '../git/git';
import type { SessionStore } from '../session-store';
import type { ProjectConfigStore } from '../project-config';
import type { ReviewStore } from '../project/review-store';
import type { HistoryStore } from '../project/history-store';
import type { TelemetryStore } from '../ai/telemetry';
import type { TerminalService } from '../terminal/terminal';
import type { WorkspaceService } from '../workspace/workspace';
import type { HostClient } from './host';
import type { RpcContext } from './router';
import { RpcErrorCode } from '../../shared/api';
import { pythonInterpreterFor } from '../python/environments';
import { RpcFailure } from './router';

export interface AppDependencies {
  settings: SettingsStore;
  workspace: WorkspaceService;
  ai: AiService;
  terminals: TerminalService;
  git: GitService;
  /** Обратные вызовы main → renderer (правки в документной модели). */
  host: HostClient;
  /** Встроенный браузер: страница — вкладка в редакторе (`WebContentsView`). */
  browserPanel?: BrowserPanel;
  /** Хранилище бесед. Необязательно: пробникам история чата не нужна. */
  chatStore?: ChatStore;
  /** Языковые серверы. Необязательно: пробникам LSP не нужен. */
  lsp?: LspService;
  /** Карта символов проекта: объявления всех файлов, собранные заранее. */
  index?: SymbolIndexer;
  /** Внешние инструменты (MCP). Необязательно: без серверов их и нет. */
  mcp?: McpService;
  /** Отладчик (DAP). Необязательно: пробникам он не нужен. */
  debug?: DebugService;
  /** Сессия проекта (вкладки, папки, панели). Необязательно для пробников. */
  sessions?: SessionStore;
  /** Настройки уровня проекта: `<root>/.chui_ide/` (см. ProjectConfigStore). */
  projectConfig?: ProjectConfigStore;
  /** Замечания к коду (`.chui_ide/review.json`). Необязательно: пробникам не нужны. */
  reviews?: ReviewStore;
  /** Локальная история файла (снимки в userData). Необязательно: пробникам не нужна. */
  history?: HistoryStore;
  /** Журнал прогонов (userData/telemetry). Необязательно: пробникам он не нужен. */
  telemetry?: TelemetryStore;
}

/**
 * Что получает каждый домен RPC: сервисы плюс два вопроса, которые у них
 * общие. Раньше это были замыкания внутри одной функции — домены до них не
 * дотягивались, и всё, что их спрашивало, лежало в одном файле.
 */
export interface RpcServices extends AppDependencies {
  /** Корень проекта или отказ: читать файлы без него нечего. */
  requireRoot(): string;
  /**
   * Интерпретатор для проверок: путь из настроек, иначе окружение проекта,
   * а в крайнем случае — системный. Тем же путём его выбирает и запуск кода:
   * проверять импорты чужим питоном значило бы врать про окружение.
   */
  resolvePython(root: string | null): string;
}

/** Собрать окружение домена из зависимостей приложения. */
export function rpcServices(deps: AppDependencies): RpcServices {
  return {
    ...deps,
    requireRoot: () => requireRoot(deps),
    resolvePython: (root) => resolvePython(deps, root),
  };
}

/** Корень проекта нужен методам, читающим файлы: без него им нечего сканировать. */
export function requireRoot(deps: AppDependencies): string {
  const root = deps.workspace.rootPath();
  if (!root) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Проект не открыт');
  return root;
}

export function resolvePython(deps: AppDependencies, root: string | null): string {
  const run = deps.settings.get().run;
  // Интерпретатор, выбранный для конкретного проекта, важнее общего: два
  // Python-проекта не должны подменять друг другу окружение.
  const perProject = (root ? run.pythonByRoot[root] : undefined)?.trim() ?? '';
  const configured = perProject || run.pythonPath;
  const byPath = pythonInterpreterFor(root, configured);
  if (byPath) return byPath;
  const bare = configured.trim();
  if (bare) return bare;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** Временный каталог: часть доменов работает через файлы. */
export function tempDir(): string {
  return app.getPath('temp');
}

/**
 * Окно, из которого пришёл вызов. Именно отправитель, а не «текущее окно»:
 * у приложения бывает несколько окон, и слушаться должно то, откуда зовут.
 * Нужно и окну, и диалогам, поэтому лежит в контексте.
 */
export function senderWindow(ctx: RpcContext): BrowserWindow {
  const window = BrowserWindow.fromWebContents(ctx.sender);
  if (!window) throw new RpcFailure(RpcErrorCode.NotFound, 'Окно не найдено');
  return window;
}
