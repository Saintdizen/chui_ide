import type { AccountBalance } from '../balance';
import type { ToolPresetId } from '../tool-presets';
import type { McpServerConfig } from '../mcp';
import type { WebSearchProvider } from '../web-search';
import type { KeybindingSettings } from '../keybindings';
import type {
  AiInlineCompletionSettings,
  AiSettings,
  AiTelemetrySettings,
  AppearanceSettings,
  EditorSettings,
  ExplorerSettings,
  GitSettings,
  LayoutSettings,
  ReasoningEffort,
  RunSettings,
  WorkspaceSettings,
} from './settings';
import type { LspSettings } from './lsp';

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
  /** Свои параметры запроса: лимит ответа и температура зависят от модели, а не от ассистента. */
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  /** Пустая строка стирает метку пользователя. */
  userId?: string;
  strictTools?: boolean;
}

export interface AiSettingsPatch {
  /** Общий выключатель ассистента: `false` глушит AI целиком. */
  enabled?: boolean;
  activeProviderId?: string;
  activeModel?: string;
  temperature?: number;
  maxTokens?: number;
  /** Потолок расхода на беседу в долларах; 0 — бюджет выключен. */
  chatBudgetUsd?: number;
  /** Размер контекстного окна в токенах; 0 — вернуть автоопределение по модели. */
  contextWindow?: number;
  /** Абсолютный предел истории для автосжатия в токенах; 0 — только по окну модели. */
  compactAtTokens?: number;
  /** Сжимать каждые N ходов беседы; 0 — никогда (только по промаху кеша и по окну). */
  compactEveryTurns?: number;
  /** Модель для сжатия беседы; пусто — активная модель. */
  compactModel?: string;
  /** Модель для коротких подзадач (подсказка, коммит, тест, название); пусто — активная. */
  quickModel?: string;
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
  /** Набор инструментов по умолчанию (см. `shared/tool-presets.ts`). */
  toolPreset?: ToolPresetId;
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
  /** Журнал прогонов в файл: включение и выключение. */
  telemetry?: Partial<AiTelemetrySettings>;
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
  /**
   * Счёт у провайдера, если он его показывает. `null` — сервер баланса не знает
   * (локальные модели денег не стоят), `undefined` — не спрашивали или не вышло.
   * Ошибка баланса не делает проверку неудачной: связь-то есть.
   */
  balance?: AccountBalance | null;
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
 * Чтение страниц по ссылке (`web`, действие fetch). Отдельно от поиска: поиск находит, а
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
