import { createAiQueries } from './queries';
import {
  ChatStreamEvent,
  RpcErrorCode,
  type AiConnectionTestResult,
  type AiWebSearchSettings,
  type ApplyEditsHostResult,
  type ChatAttachment,
  type ChatMessage,
  type ChatRequest,
  type ChatRunTrace,
  type ChatStreamDone,
  type ChatUsage,
  type CommitMessageResult,
  type DiagnosticsHostResult,
  type InlineCompletionRequest,
  type InlineCompletionResult,
  type PlanStep,
  type PlanStepStatus,
  type ReasoningEffort,
  type TestGenerationResult,
  type ChatTitleResult,
} from '../../shared/api';
import type { FileEdit } from '../../shared/edits';
import type { PatchFile } from '../../shared/patch';
import { ageStaleResults, ageToolResults } from './age-results';
import { readCalibration, saveCalibration } from './token-calibration';
import { compressToolOutput } from '../../shared/output-compress';
import {
  modelCapabilities,
  contextWindow,
  findProviderPreset,
  betaBaseUrl,
  firstPositive,
  maxOutputTokens,
  reasoningEffortFor,
} from '../../shared/providers';
import type { ModelInfo } from '../../shared/model-info';
import type { AccountBalance } from '../../shared/balance';
import {
  AGENT_TOOLS,
  parseToolArguments,
  toOpenAiTools,
  type AgentToolSpec,
  type ExposedToolSpec,
} from '../../shared/tools';
import { PLAN_MODE_TOOLS, isReadOnlyCall, isCacheableReadCall, isWriteCall } from '../../shared/tool-policy';
import { canonicalCall } from '../../shared/tool-aliases';
import { canRunTool, canUseWebSearch, narrowToolSpec, type ToolAvailability } from './available-tools';
import {
  condenseAppliedCalls,
  condenseSupersededPlans,
  answerReserve,
  estimateMessagesTokens,
  estimateTextTokens,
  isContextOverflow,
  TokenCalibration,
  trimMessagesToFit,
} from '../../shared/context-fit';
import { agentPrompt } from '../../shared/agent-prompt';
import type { CommitPromptParts } from '../../shared/commit-message';
import type { TestPromptParts } from '../../shared/test-generation';
import type { ChatTitleParts } from '../../shared/chat-title';
import { sandboxNote } from '../../shared/sandbox';
import {
  confirmFile,
  coveredRequest,
  forgetChangedFiles,
  needsConfirm,
  rememberRead,
  restoreReads,
  snapshotReads,
  uncoverFiles,
  uncoveredRequest,
  pruneReads,
  liveSources,
  type ReadRange,
} from '../../shared/read-coverage';
import { callFlags } from '../../shared/step-counts';
import { renderSessionReferences } from '../../shared/session-context';
import {
  permissionFlags,
  permissionFromAutoApprove,
  sanitizePermission,
  type PermissionPreset,
} from '../../shared/permissions';
import { MAX_GOAL_CONTINUES, goalContinuePrompt, goalPrompt, parseGoalUpdate, sanitizeGoal } from '../../shared/goal';
import { isPlanExitCall, parsePlanExitArgs, planExitResult, type PlanExitDecision } from '../../shared/plan-exit';
import {
  MAX_RUN_CALLS_PER_STEP,
  MAX_RUN_STEPS,
  clampRunText,
  type ChatRunLog,
  type RunCallLog,
  type RunStepLog,
} from '../../shared/run-log';
import type { ReviewVerdict } from '../../shared/approval-review';
import { addUsage } from '../../shared/usage';
import {
  budgetMessage,
  budgetVerdict,
  contextHeavyMessage,
  contextTrimmedMessage,
  HEAVY_CONTEXT_TOKENS,
  midRunTrimDue,
  stepCost,
} from '../../shared/chat-budget';
import { pricingAt } from '../../shared/providers';
import { repairToolPairs } from '../../shared/chat-sanitize';
import { ProjectMemory } from './project-memory';
import { WorkspaceContext } from './workspace-context';
import type { TelemetryStore } from './telemetry';
import { createJobRegistry, type JobRegistry } from './jobs';
import type { SandboxService } from '../sandbox/sandbox';
import { RpcFailure } from '../ipc/router';
import type { SettingsStore } from '../settings';
import type { WorkspaceService } from '../workspace/workspace';
import { selectMcpTools, type McpToolInfo } from '../../shared/mcp';
import { runTool } from './agent-tools';
import { stepOutputChars } from './output-budget';
import { failureText } from './tool-rules';
import type {
  BrowserTools,
  Linter,
  McpRunner,
  SessionSearchRunner,
  SymbolSearch,
  TerminalAgent,
  TestRunner,
  ToolContext,
  ToolOutcome,
} from './tool-context';
import { AnthropicProvider } from './anthropic';
import { searchWeb, webSearchProviderLabel } from './web-search';
import { fetchPage } from './web-fetch';
import { assertChatImages } from './images';
import { createReadImageRunner } from './read-image';
import { OpenAiCompatibleProvider } from './openai-compatible';
import type { AiProvider } from './provider';
import {
  sanitizeToolPreset,
  toolPresetAllows,
  toolPresetNote,
  toolPresetSpec,
  isRosterTool,
  WIDENED_TOOLS,
} from '../../shared/tool-presets';

/**
 * Сколько раз пробуем спасти шаг, если провайдер ответил «запрос не влез».
 * Оценка контекста дешёвая, но неточная (символов на токен мы не знаем точно),
 * поэтому истине верим не расчёту, а самому отказу. Двух попыток хватает.
 */
const OVERFLOW_RETRIES = 2;

/** Во сколько раз ужимаем бюджет окна на каждом повторе после переполнения. */
const OVERFLOW_SHRINK = 0.7;

/**
 * Заметка на месте обрезанной истории. Агент должен знать, что начало беседы
 * убрано, иначе будет ссылаться на то, чего в запросе уже нет.
 */
const TRIM_MARKER =
  'Часть ранней истории беседы опущена: она не помещалась в окно модели. Если нужны детали — перечитай их инструментами.';

/**
 * Пометка для сокращения посреди прогона. Другая причина — другой текст: здесь
 * дело не в окне (до него далеко), а в цене: каждый шаг вёз историю заново.
 */
const MIDRUN_TRIM_MARKER =
  'Ранняя часть истории прогона опущена: она ехала в каждом шаге и стоила дороже, чем перечитать её при нужде. Свежие шаги целы, опущенное можно прочитать инструментами.';

/**
 * Сколько последних сообщений оставить неприкосновенными при сокращении посреди
 * прогона. Четыре — это текущий ход и предыдущий: по ним модель понимает, что
 * уже сделано, а что ещё нет.
 */
const MIDRUN_KEEP_TURNS = 4;

// Лимиты шагов «модель → инструмент → модель» живут в настройках
// (`ai.maxSteps` и `ai.maxAutopilotSteps`): значения по умолчанию — там же.

/**
 * Сколько последних сообщений не сворачиваем: свежий шаг нужен целиком.
 *
 * Дюжина — это примерно шесть шагов (вызов и ответ на каждый) плюс запас на
 * размышления. Меньше — и агент примется перечитывать то, на что ещё опирается;
 * больше — экономия начнётся слишком поздно, чтобы её заметить.
 */
const STALE_KEEP_RECENT = 12;
/**
 * Свёртка истории, когда контекст шага перевалил за `HEAVY_CONTEXT_TOKENS`.
 * Держим меньше свежих результатов, сворачиваем короткие и по одному за шаг:
 * так освобождается заметно больше, а каждая свёртка всё равно происходит
 * ровно один раз — по возрасту, а не задним числом.
 */
const STALE_KEEP_RECENT_HEAVY = 6;
const STALE_MIN_CHARS_HEAVY = 900;
const STALE_BATCH_HEAVY = 1;

/** Дописывается, когда включён полный доступ: подтверждения не нужны. */
const AUTO_APPROVE_PROMPT = [
  'Полный доступ: правки применяются сразу, команды выполняются без подтверждения.',
  'Работай до результата: прочитай нужное, сделай правки, проверь себя и только потом отвечай.',
  'Опасные команды могут требовать подтверждения — учитывай это, но не жди вопросов там, где их не будет.',
].join('\n');

/**
 * Дописывается в режиме «План»: агент изучает проект и составляет план, ничего
 * не меняя. Правки и команды ему недоступны — не предлагай их и не вызывай.
 */
const PLAN_PROMPT = [
  'Режим плана: сначала изучи проект доступными инструментами чтения, затем составь план через mind (action: steps).',
  'Ничего не меняй: правки файлов и запуск команд в этом режиме недоступны и не выполнятся.',
  'План готов — заверши его вызовом mind (action: exit_plan): человек утвердит его или вернёт замечание.',
  'В конце объясни план словами: что предлагаешь сделать, в каком порядке и почему.',
].join('\n');

/**
 * Дописывается, когда инструменты выключены (режим «Вопрос»). Без этого модель
 * может попытаться вызвать инструмент, а разметка вызова выльется в ответ
 * обычным текстом — пользователь увидит служебные токены вместо ответа.
 */
const ASK_PROMPT = [
  'Инструменты в этом режиме выключены: они тебе недоступны.',
  'Отвечай обычным текстом и не вызывай инструменты — их вызов не выполнится.',
].join('\n');

/**
 * Возможности, которые живут только в renderer: документная модель (ревью правок)
 * и интерфейс подтверждений. Нет моста — соответствующие инструменты вообще не
 * предлагаются модели: меньше инструментов лучше, чем заведомо битый.
 */
export interface ChatHostBridge {
  applyEdits(edits: FileEdit[], autoApprove: boolean): Promise<ApplyEditsHostResult>;
  /** Правки по якорю: позиции считает renderer, у него есть текст документа. */
  applyPatches(patches: PatchFile[], autoApprove: boolean): Promise<ApplyEditsHostResult>;
  /** Спросить у пользователя разрешение на запуск команды. */
  confirmCommand(command: string): Promise<boolean>;
  /** Спросить разрешение на действие в браузере (переход, клик, ввод, скрипт). */
  confirmBrowser(action: string): Promise<boolean>;
  /** Задать человеку вопрос и дождаться ответа: инструмент `ask`. Пустая строка — ответа не будет. */
  ask(question: string, options?: readonly string[]): Promise<string>;
  /**
   * Отдать план на утверждение (`mind`, действие `exit_plan`). Режим переключает
   * renderer: только он знает, что человек выбрал в композере.
   */
  exitPlan(plan: string): Promise<PlanExitDecision>;
  /** Пометки языка: они живут в renderer (в редакторе). */
  getDiagnostics(path?: string): Promise<DiagnosticsHostResult>;
  /** Показать файл в редакторе на нужной позиции. */
  openFile(path: string, line?: number, column?: number): Promise<boolean>;
}

/**
 * AI-слой. Умеет стримить ответ модели в renderer и — если включён
 * `useTools` — крутить агентный цикл: модель просит вызвать инструмент,
 * тот исполняется (read-only в main, правки — в renderer) и результат
 * возвращается в диалог, пока модель не ответит текстом.
 */
export class AiService {
  /**
   * Короткие запросы к модели (подсказка, коммит, тест, название, второе мнение
   * о команде). Лениво: создаётся при первом таком запросе.
   */
  private queriesInstance: ReturnType<typeof createAiQueries> | null = null;
  /** Терминальные сессии тоже приходят снаружи: без них terminal_* не предлагаем. */
  private terminals?: TerminalAgent;
  /** Поиск символов проекта: без него search (action code) ищет только текстом. */
  private symbols?: SymbolSearch;
  /** Линтер проекта: без него действие lint инструмента checks модели не предлагаем. */
  private linter?: Linter;
  /** Команда тестов проекта: без неё инструмент run_tests модели не предлагаем. */
  private tests?: TestRunner;
  /** Внешние инструменты (MCP): нет сервиса — внешних инструментов не предлагаем. */
  private mcp?: McpRunner;
  /** Прошлые беседы проекта: без хранилища действие `sessions` не предлагаем. */
  private sessions?: SessionSearchRunner;
  /** Журнал прогонов в файл: пишет только при включённой настройке. */
  private telemetry?: TelemetryStore;
  /** Браузер: без него инструменты `browser_*` не предлагаем. */
  private browser?: BrowserTools;
  /** Песочница: без неё команды и тесты идут на хосте, как раньше. */
  private sandbox?: SandboxService;
  /**
   * Задания (`terminal` с `action: run` и `background: true`): реестр один на окно, поэтому задание переживает
   * шаг и даже ход — его можно дочитать следующим запросом.
   */
  private readonly jobs: JobRegistry = createJobRegistry();

  /**
   * Каталог для полных копий длинного вывода (`ai/spill.ts`). Не задан —
   * обрезаем без копии, как раньше: обещать модели путь к файлу, которого не
   * появится, нельзя.
   */
  private spillDir?: string;
  /**
   * Права доступа текущего прогона (выбор в композере). Храним на сервисе, а не
   * снимком в запросе: renderer может сменить их прямо во время ответа агента.
   * Сервис один на окно, а активный агентский прогон в окне один — этого хватает.
   */
  private livePermission: PermissionPreset = 'ask';

  /**
   * Поправка к оценке токенов, выученная по `usage` провайдера: сколько наши
   * символы на токен врут для конкретной модели. Ключ — провайдер и модель.
   * См. `TokenCalibration` и `streamStep`.
   */
  private readonly calibration = new TokenCalibration();
  /**
   * Паспорта моделей, полученные от сервера при проверке подключения
   * (`GET /models`). Ключ — «провайдер:модель». Хранится в памяти окна: это
   * подсказка для расчёта окна и предела ответа, а не настройка.
   */
  private readonly modelInfos = new Map<string, ModelInfo>();

  /** Запомнить паспорта, полученные при проверке подключения. */
  private rememberModelInfos(providerId: string | undefined, infos: readonly ModelInfo[]): void {
    if (!providerId) return;
    for (const info of infos) this.modelInfos.set(`${providerId}:${info.id}`, info);
  }

  /** Паспорт модели, если этот сервер его уже присылал. */
  private modelInfo(providerId: string | undefined, model: string): ModelInfo | undefined {
    if (!providerId) return undefined;
    const known = this.modelInfos.get(`${providerId}:${model}`);
    if (known) return known;
    // Модель могли переименовать на стороне сервера — сверяем без учёта регистра.
    const wanted = model.trim().toLowerCase();
    for (const [key, info] of this.modelInfos) {
      if (key.startsWith(`${providerId}:`) && info.id.trim().toLowerCase() === wanted) return info;
    }
    return undefined;
  }

  /**
   * Память проекта: заметки агента, переживающие беседу. Она нужна и для промпта,
   * и для инструментов. Хранилище можно подменить (проверки пишут в temp-каталог,
   * а не в userData разработчика), поэтому приходит параметром.
   */
  private readonly memory: ProjectMemory;

  /**
   * Карта проекта, память и правила проекта для системного блока. Держим
   * объектом, а не набором методов: внутри кэш карты, и он должен переживать
   * шаги беседы.
   */
  private readonly contextBlocks: WorkspaceContext;

  constructor(
    private readonly settings: SettingsStore,
    private readonly workspace: WorkspaceService,
    memory?: ProjectMemory,
  ) {
    this.memory = memory ?? new ProjectMemory();
    this.contextBlocks = new WorkspaceContext(this.workspace, this.memory);
    // Поправки оценки токенов переживают перезапуск: без них первые шаги снова
    // промахиваются мимо окна, пока калибровка не наберёт замеры заново.
    this.calibration.load(readCalibration(this.settings.file()));
  }

  /**
   * Куда складывать полные копии длинного вывода. Каталог — рядом с настройками,
   * в userData: файлы переживают перезапуск, но и не мешают проекту.
   */
  attachSpillDir(dir: string): void {
    this.spillDir = dir;
  }

  /** Подключить терминалы: включает инструменты terminal_start/read/write/stop. */
  attachTerminals(terminals: TerminalAgent): void {
    this.terminals = terminals;
  }

  /**
   * Подключить поиск символов (языковой сервер): включает инструмент
   * search (action code). Без него инструмент не предлагаем — текстовый поиск уже
   * есть отдельно (`search`), и дублировать его незачем.
   */
  attachSymbols(symbols: SymbolSearch): void {
    this.symbols = symbols;
  }

  /**
   * Подключить линтер проекта: включает действие `lint` инструмента `checks`. Движок и запуск
   * живут в main (`project/lint.ts`) — сервису передаётся готовый вызов.
   */
  attachLinter(linter: Linter): void {
    this.linter = linter;
  }

  /**
   * Подключить резолвер команды тестов: включает инструмент `run_tests`. Чем
   * гонять тесты, решает main (`project/tests.ts`) — агенту это знать незачем.
   */
  attachTests(tests: TestRunner): void {
    this.tests = tests;
  }

  /**
   * Подключить внешние инструменты (MCP): их список сервис берёт у серверов из
   * настроек. Без подключения агент работает только своими инструментами.
   */
  attachMcp(mcp: McpRunner): void {
    this.mcp = mcp;
  }

  /**
   * Подключить поиск по прошлым беседам — включает действие `sessions`.
   * Хранилище бесед знает рабочие папки, поэтому поиск приходит готовым.
   */
  attachSessions(sessions: SessionSearchRunner): void {
    this.sessions = sessions;
  }

  /**
   * Подключить журнал прогонов (`ai/telemetry.ts`). Без него трасса живёт только в
   * памяти беседы, как и раньше; с ним — ещё и строкой в файле.
   */
  attachTelemetry(telemetry: TelemetryStore): void {
    this.telemetry = telemetry;
  }

  /**
   * Подключить браузер: включает инструменты `browser_*`. Сам браузер поднимается
   * лениво, при первом действии, — и только если настройка включена: держать
   * процесс Chromium ради выключенной возможности незачем.
   */
  attachBrowser(browser: BrowserTools): void {
    this.browser = browser;
  }

  /**
   * Подключить песочницу: команды и тесты пойдут в контейнер вместо хоста.
   * Режим задаёт человек настройкой — агент его не переключает.
   */
  attachSandbox(sandbox: SandboxService): void {
    this.sandbox = sandbox;
  }

  /**
   * Обновить права доступа агента. Вызывается выбором в композере — в том числе
   * пока агент работает: следующее действие возьмёт уже новые права.
   */
  setPermission(preset: PermissionPreset): void {
    this.livePermission = sanitizePermission(preset);
  }

  /**
   * «Проверить подключение»: пробуем получить список моделей по указанному
   * адресу. Ошибки возвращаем текстом — это часть интерфейса, а не сбой.
   */
  async testConnection(
    params: { baseUrl: string; apiKey?: string; providerId?: string },
    signal?: AbortSignal,
  ): Promise<AiConnectionTestResult> {
    const baseUrl = params.baseUrl.trim();
    if (!baseUrl) return { ok: false, models: [], message: 'Не указан адрес сервера' };

    const apiKey =
      params.apiKey?.trim() || (params.providerId ? this.settings.resolveApiKey(params.providerId) : undefined);
    if (!apiKey && !isLocalEndpoint(baseUrl)) {
      return {
        ok: false,
        models: [],
        message: 'Нужен API-ключ: без него провайдер отклонит запрос',
      };
    }

    // Проверка идёт тем же протоколом, что и рабочий запрос: у Anthropic он свой.
    const preset = params.providerId ? findProviderPreset(params.providerId) : undefined;
    const provider: AiProvider =
      preset?.protocol === 'anthropic'
        ? new AnthropicProvider({
            id: 'test',
            label: 'Проверка',
            baseUrl,
            apiKey,
          })
        : new OpenAiCompatibleProvider({
            id: 'test',
            label: 'Проверка',
            baseUrl,
            apiKey,
          });
    try {
      // Заодно запоминаем паспорта моделей: сервер сам говорит, сколько у них
      // окно и предел ответа, — и эти числа точнее догадок по имени модели.
      const infos = provider.listModelInfos
        ? await provider.listModelInfos(signal)
        : (await provider.listModels(signal)).map((id) => ({ id }));
      this.rememberModelInfos(params.providerId, infos);
      const models = infos.map((info) => info.id);
      // Баланс — отдельный вызов и необязательный: сервер может его не знать, а
      // связь при этом рабочая. Ошибку молча превращаем в «нет данных».
      const balance = await provider
        .getBalance?.(signal)
        .then((value) => value ?? null)
        .catch(() => null);
      return {
        ok: true,
        models,
        ...(balance ? { balance } : {}),
        message:
          models.length > 0
            ? `Подключение работает · доступно моделей: ${models.length}`
            : 'Сервер ответил, но список моделей пуст',
      };
    } catch (error) {
      return { ok: false, models: [], message: describeConnectionError(error) };
    }
  }

  /**
   * Остаток на счёте у активного провайдера. `null` — не знает сервер или не
   * умеет провайдер: попап просто не рисует строку про деньги. Список моделей
   * не трогаем — цифра спрашивается при каждом открытии окна.
   */
  async accountBalance(signal?: AbortSignal): Promise<AccountBalance | null> {
    const providerId = this.settings.get().ai.activeProviderId;
    if (!providerId) return null;
    let provider: AiProvider;
    try {
      provider = this.createProvider(providerId);
    } catch {
      return null;
    }
    if (!provider.getBalance) return null;
    return provider
      .getBalance(signal)
      .then((value) => value ?? null)
      .catch(() => null);
  }

  /**
   * Подсказка для inline-автодополнения: продолжить код в месте курсора.
   *
   * В отличие от `chat` здесь нет ни истории, ни инструментов — только контекст
   * вокруг курсора и короткий ответ. Модель берём дешёвую (`quickModel`), а
   * без неё — активную: отдельной настройки для подсказок не заводим.
   */
  async completeInline(request: InlineCompletionRequest, signal: AbortSignal): Promise<InlineCompletionResult> {
    return this.queries().completeInline(request, signal);
  }

  /**
   * Проверка команды перед подтверждением: второе мнение модели.
   *
   * Обычный режим прав спрашивает обо всём, и на безобидных командах человек
   * начинает нажимать не читая. Этот запрос отвечает на один вопрос: можно ли
   * выполнить команду без спроса. Разбор ответа — в `shared/approval-review.ts`,
   * и он склонён к вопросу: непонятный ответ, таймаут и ошибка сети означают
   * «спросить человека», а не «разрешить».
   *
   * `null` — проверять нечем или незачем (нет провайдера, нет модели, не
   * дождались). Это не отказ и не разрешение: решение остаётся за человеком,
   * и вызывающий просто показывает карточку.
   */
  async reviewCommand(command: string, cwd: string | null, signal: AbortSignal): Promise<ReviewVerdict | null> {
    return this.queries().reviewCommand(command, cwd, signal);
  }

  /**
   * Сообщение коммита по diff.
   *
   * Один запрос — один короткий ответ, как у inline-подсказок: ни истории, ни
   * инструментов, ни карты проекта. Сообщение коммита — это не беседа, и платить
   * за беседу здесь незачем. Модель берём дешёвую (`quickModel`), а без неё —
   * активную: отдельной настройки для сообщений не заводим.
   */
  async commitMessage(request: CommitPromptParts, signal: AbortSignal): Promise<CommitMessageResult> {
    return this.queries().commitMessage(request, signal);
  }

  /**
   * Тест к выделенному коду.
   *
   * Один запрос — один ответ, как у inline-подсказок и сообщения коммита: ни истории,
   * ни инструментов, ни карты проекта — платить за беседу тут незачем. Модель
   * берём дешёвую (`quickModel`), а без неё — активную.
   */
  async generateTest(request: TestPromptParts, signal: AbortSignal): Promise<TestGenerationResult> {
    return this.queries().generateTest(request, signal);
  }

  /**
   * Название беседы по первому обмену.
   *
   * Один короткий запрос без истории, инструментов и карты проекта — как у
   * подсказок, сообщения коммита и генерации теста: название это строка, а не
   * разговор. Модель берём активную (выбранную в панели AI), отдельной настройки
   * для названий не заводим.
   *
   * Ошибку наверх не отдаём: не получилось — вкладка останется с заголовком по
   * вопросу, и это нормальный вид, а не сбой.
   */
  async suggestTitle(request: ChatTitleParts, signal: AbortSignal): Promise<ChatTitleResult> {
    return this.queries().suggestTitle(request, signal);
  }

  async chat(
    request: ChatRequest,
    emit: (event: string, payload: unknown) => void,
    signal: AbortSignal,
    host?: ChatHostBridge,
  ): Promise<ChatStreamDone> {
    const settings = this.settings.get();
    const webSearch = settings.ai.webSearch;
    const sandboxSettings = settings.ai.sandbox;
    const provider = this.createProvider(request.providerId);
    // Подключение целиком нужно раньше сборки инструментов: от него зависят
    // строгая схема, метка пользователя и параметры запроса.
    const connection = settings.ai.providers.find((item) => item.id === request.providerId);
    const useTools = request.useTools ?? false;
    const planMode = request.planMode ?? false;
    // Набор инструментов: запрос может сузить его сам (пробы, скрипты), иначе — из
    // настроек. Набор только сужает: кого вообще можно позвать, решают canRun,
    // режим плана и права.
    const toolPreset = sanitizeToolPreset(request.toolPreset ?? settings.ai.toolPreset);
    // В режиме плана менять ничего нельзя, поэтому права не в счёт: там «спрашивать».
    const permission = planMode
      ? 'ask'
      : request.permission
        ? sanitizePermission(request.permission)
        : permissionFromAutoApprove(request.autoApprove);
    const flags = permissionFlags(permission);
    // Цель работы приходит из беседы, а не от модели: это то, что человек поручил.
    // Пустая — цели нет; длинную обрезаем, она едет в каждый запрос.
    const requestGoal = sanitizeGoal(request.goal);
    // Текущие права запоминаем на сервисе: дальше их можно менять на лету.
    this.livePermission = permission;

    const messages: ChatMessage[] = [];
    const systemPrompt = request.systemPrompt ?? settings.ai.systemPrompt;
    if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt });

    // Карта проекта нужна там, где агент работает с проектом; в «Вопросе»
    // инструментов нет, и обход дерева за наши деньги был бы лишним.
    const context = await this.contextBlocks.build(useTools || planMode);
    if (context) messages.push({ role: 'system', content: context });
    // Контекст, который пользователь приложил сам (выделение, файл, ошибки),
    // едет отдельным сообщением: в самом вопросе он мешал бы его читать.
    const attachments = request.attachments ?? [];
    const images = attachments.filter((item) => item.kind === 'image' && item.dataUrl);
    const texts = attachments.filter((item) => item.kind !== 'image');
    // Справка из прошлой беседы едет отдельным сообщением и размеченным блоком:
    // внутри может стоять текст, который человек получил от модели, — включая
    // «забудь предыдущие указания». Отдельная разметка (`session-reference` с
    // trust="untrusted", ссылкой и байтами) отличает её от присланного файла,
    // который человек приложил осознанно и как задание.
    const notes = texts.filter((item) => item.kind !== 'session');
    const references = texts.filter((item) => item.kind === 'session');
    if (notes.length > 0) messages.push({ role: 'system', content: renderAttachments(notes) });
    if (references.length > 0) {
      messages.push({
        role: 'system',
        content: renderSessionReferences(references),
      });
    }
    if (images.length > 0) {
      messages.push({ role: 'system', content: renderImageNote(images) });
    }
    // Песочница меняет то, где выполняются команды, поэтому агенту об этом
    // говорят прямо: иначе он будет искать инструменты хоста в контейнере и
    // удивляться, почему установленные пакеты исчезли.
    const sandboxed = sandboxSettings.enabled && this.sandbox !== undefined;
    const sandboxPrompt = sandboxed ? sandboxNote(sandboxSettings, this.sandbox!.available) : '';

    if (planMode)
      messages.push({
        role: 'system',
        content: `${agentPrompt(toolPreset, { confirm: false })}\n${PLAN_PROMPT}`,
      });
    else if (useTools)
      messages.push({
        role: 'system',
        content: [
          agentPrompt(toolPreset, { confirm: permission !== 'full' }),
          permission === 'full' ? AUTO_APPROVE_PROMPT : '',
          sandboxPrompt,
        ]
          .filter(Boolean)
          .join('\n'),
      });
    else messages.push({ role: 'system', content: ASK_PROMPT });
    // Суженный набор называется вслух: иначе агент ищет обходной путь там, где
    // нужно попросить человека вернуть инструмент.
    if (useTools && !planMode) {
      const presetNote = toolPresetNote(toolPreset);
      if (presetNote) messages.push({ role: 'system', content: presetNote });
    }
    // Цель — часть рамки запроса, а не текущего вопроса: она едет в системном
    // сообщении, чтобы модель отличала «чего от меня хотят вообще» от «о чём
    // спросили сейчас». В «Вопросе» и «Плане» её нет: там нечего доводить до конца.
    if (requestGoal && useTools && !planMode) messages.push({ role: 'system', content: goalPrompt(requestGoal) });

    // История приходит из файла беседы, а там возможен обрыв пары вызов-ответ
    // (приложение закрыли посреди прогона). Провайдер отвечает на такую пару
    // HTTP 400, и беседа перестаёт работать целиком — поэтому чиним её здесь,
    // на последнем рубеже перед проводом, а не надеемся на источник.
    messages.push(...repairToolPairs(request.messages));

    // Сами картинки идут частями ПОСЛЕДНЕГО сообщения пользователя: отдельным
    // system-сообщением их не примет почти ни один провайдер — изображение
    // допустимо только в сообщении пользователя.
    if (images.length > 0)
      attachImages(
        messages,
        images.map((item) => item.dataUrl!),
      );

    // Предлагаем модели только то, что реально может исполнить эта сборка.
    // `narrowToolSpec` — второй шаг того же правила: инструмент жив, но не все его
    // действия (у `web` выключенный поиск), и мёртвое действие уходит из `enum`,
    // чтобы модель не платила шагом за вызов, который не может пройти.
    const toolEnv = this.toolEnv(host);
    const available = useTools
      ? AGENT_TOOLS.filter(
          (tool) =>
            this.canRun(tool, host) &&
            // Набор даёт права, а ростер и `WIDENED_TOOLS` — что из них едет
            // схемой: первое видно строкой ростера, второе — ничего не видно,
            // пока не позовут (схему тогда докачивает `widenTools`).
            (planMode || !isRosterTool(toolPreset, tool.name)) &&
            (planMode || !WIDENED_TOOLS.includes(tool.name)) &&
            (planMode ? PLAN_MODE_TOOLS.has(tool.name) : true),
        ).map((tool) => narrowToolSpec(tool, toolEnv))
      : [];

    // Внешние инструменты (MCP) добавляем к нашим. В режиме плана их нет: что
    // делает чужой инструмент, мы не знаем, а план ничего менять не должен.
    const external = useTools && !planMode && this.mcp ? await this.externalTools(host) : [];
    // Ресурсы MCP — тоже чтение, поэтому они есть и в режиме плана: план и
    // составляют по документам сервера. Список ресурсов знает только подключение,
    // поэтому схемы добавляются здесь, а не статическим отбором.
    const resourceTools = useTools && this.mcp ? await this.resourceTools() : [];
    const offered = [...available, ...external, ...resourceTools];
    // `let`: набор схем пересобирается, если человек утвердил план посреди прогона
    // (см. `widen` ниже).
    let tools = offered.length > 0 ? toOpenAiTools(offered, { strict: connection?.strictTools === true }) : undefined;
    /** План утверждён человеком посреди прогона: ограничения плана больше не действуют. */
    let planApproved = false;
    // Полный доступ: и правки, и команды без подтверждений.
    // Страховка — из настроек: по умолчанию выключена, включает пользователь.
    const toolContext: ToolContext = {
      workspace: this.workspace,
      signal,
      autoApprove: flags.autoApprove,
      allowAll: flags.allowAll,
      confirmDangerous: settings.ai.confirmDangerous === true,
    };
    // Сжатие вывода — только для контекста модели: человек в карточке инструмента
    // видит текст как он есть (см. `compressToolOutput`).
    const compressOutput = settings.ai.compressOutput !== false;
    if (this.terminals) toolContext.terminals = this.terminals;
    if (this.symbols) toolContext.symbols = this.symbols;
    if (this.linter) toolContext.linter = this.linter;
    if (this.tests) toolContext.tests = this.tests;
    if (this.sessions) toolContext.sessions = this.sessions;
    toolContext.memory = {
      remember: (text, scope) => this.memory.remember(this.workspace.rootPath(), text, scope),
      forget: (query, scope) => this.memory.forget(this.workspace.rootPath(), query, scope),
      notes: (scope) => this.memory.list(this.workspace.rootPath(), scope),
    };
    if (this.mcp && external.length > 0) toolContext.mcp = this.mcp;
    // Картинки для модели: чтение и уменьшение файлов живут в main, инструмент
    // только просит. Права не спрашиваем — это чтение внутри проекта.
    toolContext.readImage = createReadImageRunner(this.workspace);
    // Чтение страницы по ссылке: своя настройка-разрешение, потому что это тоже
    // ход наружу. Адрес проверяется до запроса, а тело читается с потолком.
    if (settings.ai.webFetch?.enabled) {
      toolContext.webFetch = {
        fetch: (url, options) =>
          fetchPage(url, {
            signal: options?.signal,
            maxChars: options?.maxChars,
          }),
      };
    }

    // Веб-поиск читает настройки на каждый прогон: человек может включить его
    // посреди работы, и следующее действие должно это увидеть. Ключ тоже берём
    // в момент вызова: он мог появиться уже после старта приложения.
    if (canUseWebSearch({ webSearch, webSearchKey: this.webSearchKey(webSearch) })) {
      toolContext.webSearch = {
        search: (query, limit, callSignal) =>
          searchWeb(
            query,
            {
              provider: webSearch.provider,
              endpoint: webSearch.endpoint,
              apiKey: this.webSearchKey(webSearch),
            },
            limit,
            callSignal,
          ).then((hits) => ({
            hits,
            providerLabel: webSearchProviderLabel(webSearch.provider),
          })),
      };
    }
    // Браузер читает настройку на каждый прогон, как и веб-поиск: человек может
    // включить его посреди работы, и следующее действие это должно увидеть.
    if (this.browser && settings.ai.browser.enabled) toolContext.browser = this.browser;
    // Песочница: команды и тесты идут в контейнер. Подключена она или нет, решает
    // настройка: агент этот режим не переключает и не может «выйти» из него.
    if (sandboxSettings.enabled && this.sandbox) toolContext.sandbox = this.sandbox;
    if (this.spillDir) toolContext.spillDir = this.spillDir;
    toolContext.jobs = this.jobs;
    if (host) {
      toolContext.applyEdits = (edits, auto) => host.applyEdits(edits, auto);
      toolContext.applyPatches = (patches, auto) => host.applyPatches(patches, auto);
      toolContext.confirmCommand = (command) => host.confirmCommand(command);
      toolContext.confirmBrowser = (action) => host.confirmBrowser(action);
      toolContext.ask = (question, options) => host.ask(question, options);
      toolContext.diagnostics = (path) => host.getDiagnostics(path);
      toolContext.openFile = (path, line, column) => host.openFile(path, line, column);
    }

    // Лимит шагов: у полного доступа свой, повышенный — он и есть «автопилот».
    const steps = permission === 'full' ? settings.ai.maxAutopilotSteps : settings.ai.maxSteps;

    // Что из параметров генерации модель вообще принимает: o-серия отвергает
    // temperature, обычные модели не знают reasoning_effort. Лишнее поле в теле
    // запроса — это либо 400, либо молча проигнорированная настройка.
    const capabilities = modelCapabilities(request.model);
    // Порядок: явный запрос → параметры подключения → общее в разделе AI.
    // Подключение важнее общего: температура и лимит ответа — свойства модели,
    // и одно общее число не годится сразу и локальной 8K-модели, и облачной 128K.
    const temperature = capabilities.temperature
      ? (request.temperature ?? connection?.temperature ?? settings.ai.temperature)
      : undefined;
    // Паспорт от сервера точнее любой таблицы: он называет окно и предел ответа
    // именно этой модели. Таблица остаётся запасным вариантом, пока подключение
    // не проверяли и паспорта нет.
    const passport = this.modelInfo(request.providerId, request.model);
    // 0 или пусто — предел самой модели: ответ ограничивает модель, а не общая константа.
    const maxTokens = maxOutputTokens(
      request.model,
      firstPositive(request.maxTokens, connection?.maxTokens, settings.ai.maxTokens, passport?.maxOutputTokens),
    );
    // Потолок беседы в долларах: 0 — бюджета нет, поведение прежнее.
    const budgetUsd = settings.ai.chatBudgetUsd;
    const requestedEffort = request.reasoningEffort ?? connection?.reasoningEffort ?? settings.ai.reasoningEffort;
    const reasoningEffort = reasoningEffortFor(request.model, requestedEffort);
    // У модели, которая думает всегда, «без размышлений» надо ещё и выключить —
    // молчание в запросе означает «думай по умолчанию», а не «не думай».
    const thinking = capabilities.thinkingToggle
      ? reasoningEffort !== undefined || (requestedEffort !== undefined && requestedEffort !== 'off')
      : undefined;

    // Предохранитель от переполнения окна посреди цикла: renderer проверил
    // контекст перед отправкой, но шаги агента копят историю уже здесь, и
    // сжатие, которое живёт в renderer, до этого места не достаёт.
    const windowTokens = contextWindow(
      request.model,
      firstPositive(settings.ai.contextWindow, passport?.contextWindow),
    );
    // Состав строки важен: описания инструментов — кириллица, а она в токенах
    // дороже латиницы примерно вдвое. estimateTokens видит только длину и занижал
    // вес схем на четверть — предохранитель пропускал то, что провайдер отвергнет.
    let toolsTokens = tools ? estimateTextTokens(JSON.stringify(tools)) : 0;

    // Отказ вместо пустого прогона: если описания инструментов (или вместе с
    // запасом под ответ) уже не влезают в окно, шага не получится вовсе —
    // запрос отвергнет сам провайдер, а причина осталась бы невидимой. Числа
    // называем прямо, чтобы человек знал, что делать: взять модель с окном
    // побольше или выключить лишние наборы инструментов.
    if (tools && windowTokens - toolsTokens - maxTokens <= 0) {
      throw new RpcFailure(
        RpcErrorCode.InvalidParams,
        `Инструменты не помещаются в окно модели: окно ${windowTokens} токенов, описания инструментов — ` +
          `${toolsTokens}${maxTokens > 0 ? `, запас под ответ — ${maxTokens}` : ''}. ` +
          'Возьмите модель с большим окном (или увеличьте «Контекстное окно» в настройках), ' +
          'либо выключите лишние наборы инструментов: браузер, веб-поиск или серверы MCP.',
      );
    }

    /**
     * Набор расширяется сам (пресет «Авто»). Скрытый инструмент скрыт ради
     * токенов, а не ради прав: его вызов по имени открывает его в наборе.
     * Список живёт весь прогон — открытое не закрывается назад.
     */
    const onDemandTools = new Set<string>();
    const widensOnDemand = toolPresetSpec(toolPreset).widen === true;

    /**
     * План утвердили посреди прогона: ограничений плана больше нет — набор схем
     * пересобирается, чтобы модель могла выполнить одобренное. Внешние (MCP) в
     * пересчёт не входят: в плане их не было.
     */
    const widenTools = (): void => {
      const widened = AGENT_TOOLS.filter(
        (tool) =>
          this.canRun(tool, host) &&
          // Ростер отсекаем и здесь: расширение — про то, чего в наборе не было,
          // а не про то, что нарочно спрятано в строку.
          !isRosterTool(toolPreset, tool.name) &&
          // Разница между ростором и `WIDENED_TOOLS`: у первого имя видно строкой
          // и схема не появится никогда, у второго схемы не видно вовсе — и она
          // докачивается, как только инструмент позвали. Провал кэша префикса
          // тут один, а строка подсказки стоила бы на каждом шаге.
          (!WIDENED_TOOLS.includes(tool.name) || onDemandTools.has(tool.name)) &&
          (toolPresetAllows(toolPreset, tool.name) || onDemandTools.has(tool.name)),
      ).map((tool) => narrowToolSpec(tool, toolEnv));
      const next = [...widened, ...external, ...resourceTools];
      tools = next.length > 0 ? toOpenAiTools(next) : undefined;
      toolsTokens = tools ? estimateTextTokens(JSON.stringify(tools)) : 0;
    };

    // Вся ветка, порождённая этим вызовом. Renderer дописывает её в историю —
    // поэтому в следующем вопросе модель помнит, что успела прочитать.
    const produced: ChatMessage[] = [];
    let text = '';
    let reasoning = '';
    let usage: ChatUsage | undefined;
    let finishReason: string | undefined;
    // Расход за весь прогон: провайдер сообщает его по шагу, а стоимость нужна за
    // прогон целиком — иначе виден только последний шаг и она занижена.
    let runUsage: ChatUsage = {};
    /** Модель, которой идёт работа: деградирует при исчерпании бюджета. */
    let workModel = request.model;
    /** Бюджет уже объявлен человеку: повторять на каждом шаге незачем. */
    let budgetDeclared = false;
    /** О тяжёлом контексте сказано: повторять на каждом шаге незачем. */
    let contextDeclared = false;
    let runSteps = 0;
    let runToolCalls = 0;
    /**
     * Трасса прогона: шаги, их вызовы и время. Собирается здесь, потому что только
     * main знает настоящие системные сообщения, состав инструментов и сколько
     * заняла каждая остановка модели. Renderer покажет её окном «Прогон».
     */
    const runStartedAt = Date.now();
    const runStepLogs: RunStepLog[] = [];
    /**
     * Схемы инструментов, которые ушли модели, по имени. Пишем при первом вызове
     * инструмента: схема за прогон не меняется, а копия в каждом вызове раздула
     * бы трассу в разы. Внешние (MCP) схемы тоже здесь — иначе человек не увидит
     * нигде, с какой формой аргументов агент имел дело.
     */
    const runSchemas: Record<string, string> = {};
    const rememberSchema = (name: string): void => {
      if (runSchemas[name] !== undefined) return;
      const spec = tools?.find((item) => item.function.name === name);
      if (spec) runSchemas[name] = clampRunText(JSON.stringify(spec.function.parameters));
    };

    /**
     * След прогона для наблюдаемости: сколько шагов, вызовов и токенов он стоил.
     * Вес описаний инструментов отдаём здесь же — renderer без него оценивал бы
     * по всему списку и ошибался бы в обе стороны (лишние выключенные плюс
     * неучтённые внешние).
     */
    const trace = (): ChatRunTrace => ({
      steps: runSteps,
      toolCalls: runToolCalls,
      usage: runUsage,
      toolsTokens,
    });

    /**
     * Трасса на момент окончания. `finished` — почему прогон кончился: ответом,
     * лимитом шагов или обрывом. Без этого «почему в ленте нет ответа» пришлось бы
     * выяснять по последней строке текста.
     */
    const runLog = (finished: ChatRunLog['finished']): ChatRunLog => ({
      startedAt: runStartedAt,
      ms: Date.now() - runStartedAt,
      steps: runStepLogs,
      system: {
        ...(systemPrompt.trim() ? { instructions: clampRunText(systemPrompt) } : {}),
        ...(context ? { context: clampRunText(context) } : {}),
        ...(attachments.length > 0
          ? {
              attachments: attachments.map((item) => `${item.kind}: ${item.title}`.trim()),
            }
          : {}),
        provider: request.providerId,
        model: request.model,
        mode: planMode ? 'plan' : useTools ? 'agent' : 'question',
        permission,
        tools: tools?.length ?? 0,
        toolsTokens,
        ...(requestGoal ? { goal: requestGoal } : {}),
      },
      ...(Object.keys(runSchemas).length > 0 ? { schemas: runSchemas } : {}),
      finished,
      trace: trace(),
    });

    /**
     * Трасса на выходе и запись в журнал: одно место на все концы прогона (ответ,
     * лимит шагов, обрыв), поэтому журнал не может разойтись с тем, что человек
     * видит в ленте. Ошибку записи никто не ждёт: журнал — диагностика.
     */
    const finishRun = (finished: ChatRunLog['finished']): ChatRunLog => {
      const log = runLog(finished);
      const project = this.workspace.rootPath();
      void this.telemetry
        ?.record(log, {
          ...(request.conversationUid ? { conversation: request.conversationUid } : {}),
          ...(project ? { project } : {}),
        })
        .catch(() => undefined);
      // Счётчик шагов — без согласия: в нём нет ни инструкций, ни ответов.
      void this.telemetry
        ?.recordCounts(log, {
          ...(request.conversationUid ? { conversation: request.conversationUid } : {}),
        })
        .catch(() => undefined);
      return log;
    };

    // Дедупликация вызовов в рамках одной ветки: одинаковый read-only вызов
    // не исполняется дважды, а если шаг целиком состоит из повторов — цикл
    // останавливается. Правка/команда сбрасывает кэш: состояние могло измениться.
    const executed = new Map<string, ToolOutcome>();
    let stallSteps = 0;

    // Прочитанные диапазоны по файлам: повтор уже прочитанного места не исполняем.
    // Карта поднимается из беседы (`ChatConversation.reads`), а не заводится пустой:
    // иначе в новом ходе агент заново читал то, что уже видел. Замер по истории —
    // 23,5 тыс. токенов на 71 тыс. чтений пришлось на перекрытие, треть всех чтений.
    const coveredReads = request.reads ? restoreReads(request.reads) : new Map<string, ReadRange[]>();
    // Покрытие из беседы живёт дольше ветки: после сжатия, удалённого хода или
    // перегенерации текст-источник выпал, а запись осталась. Оставляем только куски,
    // чей вызов ещё лежит в истории целым (`src`), иначе заглушка «уже прочитано»
    // сошлётся на пустоту. После свёртки по возрасту внутри прогона — та же сверка.
    pruneReads(coveredReads, liveSources(messages));
    // Тот же учёт — командам-читалкам в терминале: `cat` поверх уже прочитанного
    // отвечает строкой, а не второй копией текста.
    toolContext.coveredReads = coveredReads;

    /**
     * Цель прогона: ставится человеком (в запросе) или моделью (`update_goal`)
     * и живёт дольше одного хода. Пока она открыта, законченный ход — не финал:
     * прогон продолжает сам, но не больше `MAX_GOAL_CONTINUES` раз, иначе
     * недостижимая цель жгла бы токены в петле.
     */
    let goalText = requestGoal ?? '';
    let goalDone = false;
    let goalContinues = 0;
    /** Работа в этом прогоне шла: без неё продолжать нечего. */
    let didWork = false;
    /**
     * Сколько подряд шло чтение через шелл (`cat`, `grep`, `sed`) вместо `read`.
     * После второго добавляем строку подсказки: такие вызовы в замере — 23 из 90,
     * а `read` дешевле и помнит уже прочитанное.
     */
    let shellReads = 0;
    /**
     * Чтения `read` по одному файлу за шаг — подряд. Замер (`counts.jsonl`):
     * 1 227 чтений и всего 6 из них пачкой (`paths`), а шагов с 2+ вызовами — 15%.
     * После третьего одиночного чтения говорим один раз на прогон: пачка — тот же
     * вывод за один шаг, а шаг — это вся история заново.
     */
    let singleReads = 0;
    let pathsHinted = false;

    for (let step = 0; step < steps; step += 1) {
      if (signal.aborted) break;

      // Шаг трассы: время, текст модели и её вызовы. `commit` один на шаг —
      // вызывается на каждом выходе из итерации, повторный вызов ничего не делает.
      const stepStartedAt = Date.now();
      const stepLog: RunStepLog = {
        index: runStepLogs.length + 1,
        ms: 0,
        calls: [],
        outputTokens: 0,
      };
      let stepCommitted = false;
      const commitStep = (note?: string): void => {
        if (stepCommitted) return;
        stepCommitted = true;
        stepLog.ms = Date.now() - stepStartedAt;
        if (note) stepLog.note = note;
        if (runStepLogs.length < MAX_RUN_STEPS) runStepLogs.push(stepLog);
      };
      /** Вызов в трассу: сверх потолка считаем числом, а не копим. */
      const logCall = (call: RunCallLog): void => {
        rememberSchema(call.name);
        if (stepLog.calls.length < MAX_RUN_CALLS_PER_STEP) stepLog.calls.push(call);
        else stepLog.hiddenCalls = (stepLog.hiddenCalls ?? 0) + 1;
      };
      /**
       * Сколько токенов шаг отдал модели результатами инструментов.
       *
       * Считаем там, где сообщение кладётся в `messages`, а не по трассе: в трассе
       * поля обрезаны потолками и вышло бы заниженное число.
       */
      const countOutput = (content: string): void => {
        stepLog.outputTokens = (stepLog.outputTokens ?? 0) + estimateTextTokens(content);
      };
      /**
       * Сократить историю прогона до порога `HEAVY_CONTEXT_TOKENS`.
       *
       * Переписывает префикс запроса, поэтому зовётся только когда оставшихся
       * шагов хватает, чтобы промах кеша окупился (`midRunTrimDue`).
       * Рамка запроса и свежие ходы целы: `trimMessagesToFit` режет по парам
       * «вызов → результат» и не оставляет висячих `toolCallId`.
       */
      const trimHistory = (): number => {
        const trimmed = trimMessagesToFit(messages, {
          limitTokens: HEAVY_CONTEXT_TOKENS,
          overheadTokens: toolsTokens,
          reserveTokens: answerReserve(maxTokens, HEAVY_CONTEXT_TOKENS),
          keepRecent: MIDRUN_KEEP_TURNS,
          marker: MIDRUN_TRIM_MARKER,
        });
        if (trimmed.dropped === 0) return 0;
        messages.splice(0, messages.length, ...trimmed.messages);
        // Вместе с ходами из ветки ушёл и текст прочитанного: запись о покрытии
        // без своего вызова — обещание, которого в контексте нет.
        pruneReads(coveredReads, liveSources(messages));
        return trimmed.dropped;
      };

      // Окно модели говорит, сколько влезет, но не сколько это стоит: контекст
      // едет в каждом шаге прогона.
      const contextTokens = estimateMessagesTokens(messages) + toolsTokens;
      const stepsLeft = Math.max(0, steps - runSteps);
      // Сокращаем посреди прогона, но не на каждом шаге: разрыв кеша стоит
      // дорого, и пока впереди мало шагов, он не окупится (`midRunTrimDue`).
      const trimmedNow = midRunTrimDue({
        tokens: contextTokens,
        stepsLeft,
        pricing: pricingAt(workModel),
      })
        ? trimHistory()
        : 0;
      const heavy = contextTokens > HEAVY_CONTEXT_TOKENS;
      if (heavy && !contextDeclared) {
        contextDeclared = true;
        emit(ChatStreamEvent.Delta, {
          text: `\n\n${
            trimmedNow > 0 ? contextTrimmedMessage(contextTokens, trimmedNow) : contextHeavyMessage(contextTokens)
          }`,
        });
      }
      // Каждый шаг сверяемся с окном: результаты инструментов копятся, и
      // длинный прогон легко переполняет контекст. Режем старые ходы целиком,
      // не трогая ни рамку запроса, ни пару «вызов → результат». Промах оценки
      // ловит сам `streamStep` — по настоящему отказу провайдера.
      //
      // Старые результаты уходят в копию с адресом до переполнения, а не после:
      // иначе один прочитанный файл едет целиком на каждом шаге прогона, хотя он
      // давно отработал. Граница по возрасту, а не «сколько надо освободить»:
      // каждое сообщение пересекает её один раз, и префикс запроса не меняется
      // задним числом — кэш провайдера цел.
      const aged = ageStaleResults(messages, {
        keepRecent: heavy ? STALE_KEEP_RECENT_HEAVY : STALE_KEEP_RECENT,
        ...(heavy ? { minChars: STALE_MIN_CHARS_HEAVY, batchSize: STALE_BATCH_HEAVY } : {}),
        ...(this.spillDir ? { spillDir: this.spillDir } : {}),
      });
      // Свёрнутый результат — уже не текст, а адрес: покрытие по нему станет врать.
      if (aged.aged > 0) pruneReads(coveredReads, liveSources(messages));
      const done = await this.streamStep(provider, {
        model: workModel,
        messages,
        tools,
        temperature,
        maxTokens,
        reasoningEffort,
        ...(thinking === undefined ? {} : { thinking }),
        ...(connection?.userId ? { userId: connection.userId } : {}),
        signal,
        windowTokens,
        toolsTokens,
        calibrationKey: `${request.providerId}::${request.model}`,
        onDelta: (delta) => {
          text += delta;
          stepLog.text = ((stepLog.text ?? '') + delta).slice(0, 20_000);
          emit(ChatStreamEvent.Delta, { text: delta });
        },
        onReasoning: (delta) => {
          reasoning += delta;
          stepLog.reasoning = ((stepLog.reasoning ?? '') + delta).slice(0, 20_000);
          emit(ChatStreamEvent.Reasoning, { text: delta });
        },
      });

      runSteps += 1;
      if (done.usage) {
        usage = done.usage;
        runUsage = addUsage(runUsage, done.usage);
        // Расход шага — в трассу: без него не видно, на каком именно шаге кеш
        // слетел и сколько стоила промахнувшаяся часть.
        stepLog.usage = done.usage;
      }
      // Бюджет беседы: шаги ограничивают длину, но не цену. Считаем после
      // каждого шага; потолок пройден — дальше идём дешёвой моделью.
      if (budgetUsd > 0 || budgetDeclared) {
        const spent = stepCost(runUsage, workModel) ?? 0;
        const verdict = budgetVerdict(
          { limitUsd: budgetUsd, spentUsd: spent },
          {
            canDegrade: Boolean(settings.ai.quickModel) && settings.ai.quickModel !== workModel,
          },
        );
        if (verdict.action !== 'ok' && !budgetDeclared) {
          budgetDeclared = true;
          const degrade = verdict.action === 'degrade';
          emit(ChatStreamEvent.Delta, {
            text: `\n\n${budgetMessage(verdict, degrade)}`,
          });
          if (degrade) workModel = settings.ai.quickModel as string;
        }
        if (verdict.action === 'stop') {
          finishReason = finishReason ?? 'length';
          commitStep('бюджет беседы исчерпан');
          break;
        }
      }
      if (done.finishReason) finishReason = done.finishReason;

      const calls = done.toolCalls ?? [];
      runToolCalls += calls.length;
      if (calls.length === 0) {
        const answer: ChatMessage = { role: 'assistant', content: done.text };
        produced.push(answer);
        // Цель открыта, а ход кончился без инструментов: модель решила, что
        // закончила. Цель — это условие окончания, а не пожелание, поэтому
        // говорим прямо, что работа не закрыта, и даём следующий шаг. Человека
        // в историю не подмешиваем: это служебная реплика прогона, а не его ход.
        // Шаг напоследок не тратим: продолжение без запаса шагов кончилось бы
        // обрывом «достигнут лимит шагов», а не работой.
        if (goalText && !goalDone && didWork && !planMode && goalContinues < MAX_GOAL_CONTINUES && step + 1 < steps) {
          goalContinues += 1;
          messages.push(answer);
          messages.push({
            role: 'user',
            content: goalContinuePrompt(goalText, goalContinues, MAX_GOAL_CONTINUES),
          });
          emit(ChatStreamEvent.Goal, {
            goal: { text: goalText, done: false },
            continued: goalContinues,
            limit: MAX_GOAL_CONTINUES,
          });
          // Шаг кончился ответом, но прогон идёт дальше ради цели: в трассе это
          // не финал, а шаг с пометкой — иначе показалось бы, что модель дважды
          // ответила на один вопрос без причины.
          commitStep('продолжение по цели');
          continue;
        }
        commitStep();
        return {
          text,
          finishReason,
          usage,
          trace: trace(),
          run: finishRun('answer'),
          reads: snapshotReads(coveredReads),
          agentMessages: produced,
          ...(reasoning ? { reasoning } : {}),
        };
      }

      // Модель попросила инструменты: сохраняем её ход, исполняем по очереди
      // и возвращаем результаты — иначе протокол вызова считается нарушенным.
      const assistant: ChatMessage = {
        role: 'assistant',
        content: done.text,
        toolCalls: calls,
        // Размышления шага едут вместе с вызовами: провайдер, который их прислал,
        // ждёт их обратно (DeepSeek отвечает 400 на запрос с tools без них).
        ...(done.reasoning ? { reasoning: done.reasoning } : {}),
      };
      messages.push(assistant);
      produced.push(assistant);

      let didNewWork = false;
      /** Вызовы, чьи правки уже в файлах: тела правок из истории можно убрать. */
      const appliedCalls = new Set<string>();
      /** Последний план шага: прежние версии в истории заменяются пометкой. */
      let planCallId: string | undefined;
      // Бюджет вывода на шаг, общий для всех его вызовов: предел на вызов этой
      // задачи не отвечает — три чтения подряд дают 180 000 символов, и обрезка
      // истории выбрасывает уже потраченный шаг целиком.
      toolContext.stepBudget = { left: stepOutputChars(windowTokens) };
      for (const raw of calls) {
        // Старое имя из сохранённой беседы приводим к нынешнему ДО всех проверок:
        // иначе набор скажет «такого нет», хотя инструмент есть под другим именем.
        const mapped = canonicalCall(raw.name, raw.arguments);
        const call = mapped.renamed ? { ...raw, name: mapped.name, arguments: mapped.arguments } : raw;
        // План — не вызов инструмента в привычном смысле, а обновление чек-листа:
        // рисуем его отдельным событием, но модели всё равно отвечаем role:'tool'.
        if (call.name === 'mind' && planActionOf(call.arguments) === 'steps') {
          const steps = parsePlanSteps(call.arguments);
          if (steps.length > 0) {
            emit(ChatStreamEvent.Plan, { steps });
            planCallId = call.id;
          }
          const toolMessage: ChatMessage = {
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: steps.length > 0 ? `План обновлён: шагов — ${steps.length}` : 'План не изменён',
          };
          messages.push(toolMessage);
          produced.push(toolMessage);
          didNewWork = true;
          logCall({
            id: call.id,
            name: call.name,
            args: clampRunText(call.arguments),
            ok: steps.length > 0,
            summary: steps.length > 0 ? `план: шагов — ${steps.length}` : 'план не изменён',
            note: 'служебный: меняет чек-лист, а не проект',
          });
          continue;
        }

        // Цель — не вызов инструмента, а состояние беседы (как план). Модель
        // может поставить её сама, когда задача оказалась многошаговой, и закрыть,
        // когда работа кончилась: закрытие видит человек, и оно останавливает
        // автопродолжение.
        if (call.name === 'mind' && planActionOf(call.arguments) === 'goal') {
          const update = parseGoalUpdate(call.arguments);
          let note = 'Цель не изменена: нечего применять.';
          if (update?.text) {
            goalText = update.text;
            goalDone = update.done === true;
            note = goalDone ? `Цель закрыта: ${goalText}` : `Цель поставлена: ${goalText}`;
            emit(ChatStreamEvent.Goal, {
              goal: { text: goalText, done: goalDone },
            });
          } else if (update?.done !== undefined && goalText) {
            goalDone = update.done;
            note = goalDone ? `Цель закрыта: ${goalText}` : `Цель снова открыта: ${goalText}`;
            emit(ChatStreamEvent.Goal, {
              goal: { text: goalText, done: goalDone },
            });
          }
          const toolMessage: ChatMessage = {
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: note,
          };
          messages.push(toolMessage);
          produced.push(toolMessage);
          didWork = true;
          logCall({
            id: call.id,
            name: call.name,
            args: clampRunText(call.arguments),
            ok: true,
            summary: clampRunText(note, 200),
            note: 'служебный: ставит или закрывает цель',
          });
          continue;
        }

        // «Утвердить план»: человек решает, работать ли по нему. Ответ переключает
        // режим в renderer (он один знает композер), а прогон продолжается уже без
        // ограничений плана — иначе одобренное было бы нечем выполнить.
        if (isPlanExitCall(call.name, call.arguments)) {
          emit(ChatStreamEvent.ToolStart, {
            id: call.id,
            name: call.name,
            args: call.arguments,
          });
          const asked = parsePlanExitArgs(call.arguments);
          const decision: PlanExitDecision = host
            ? await host.exitPlan(asked)
            : {
                approved: false,
                note: 'окно чата не подключено — утвердить план некому',
              };
          if (decision.approved) {
            planApproved = true;
            widenTools();
          }
          const content = planExitResult(decision);
          const toolMessage: ChatMessage = {
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content,
          };
          messages.push(toolMessage);
          produced.push(toolMessage);
          didNewWork = true;
          logCall({
            id: call.id,
            name: call.name,
            args: clampRunText(call.arguments),
            ok: decision.approved,
            summary: decision.approved ? 'план утверждён' : 'план не утверждён',
            note: 'служебный: меняет режим работы, а не проект',
          });
          emit(ChatStreamEvent.ToolResult, {
            id: call.id,
            name: call.name,
            ok: decision.approved,
            summary: decision.approved ? 'план утверждён' : 'план не утверждён',
            detail: content,
          });
          continue;
        }

        // Отказ до исполнения: режим плана и суженный набор. Модель могла позвать
        // инструмент, которого ей не предлагали, — по памяти прошлых ходов или по
        // совету из чужого текста. Он не выполнится, и об этом надо сказать прямо:
        // молчаливый отказ читается как «такого не бывает» и уводит в тупик.
        //
        // Набор «Авто» расширяется на месте: инструмент скрыт ради цены, а не
        // ради прав — исполняем его и берём в набор со следующего шага.
        let widenedNow = false;
        const hiddenByPreset = !toolPresetAllows(toolPreset, call.name);
        // Схемы не будет и у инструмента ВНЕ `except`, если он в `WIDENED_TOOLS`:
        // там его тоже докачиваем после первого вызова (см. `widenTools`).
        const shownAsSchema = !isRosterTool(toolPreset, call.name) && !WIDENED_TOOLS.includes(call.name);
        // Инструменты из ростера (`except`) выполняются по имени, но в набор не
        // возвращаются. Причина — цена: схема, добавленная один раз, едет в
        // КАЖДОМ следующем запросе прогона (у `terminal` это 344 токена на
        // каждом шаге до конца), да ещё и меняет префикс, который кэширует
        // провайдер. Ростер даёт имя и обязательные аргументы, свой вызов модель
        // уже видела — повторный вызов по имени обойдётся дешевле.
        const rosterOnly = isRosterTool(toolPreset, call.name);
        // `deny` — запрет по существу (живой MCP-сервер в наборе чтения): такой
        // инструмент не докачивается, иначе запрет обходится первым вызовом.
        const forbidden = (toolPresetSpec(toolPreset).deny ?? []).includes(call.name);
        if (!forbidden && (hiddenByPreset || !shownAsSchema) && widensOnDemand && (!planMode || planApproved)) {
          const known = AGENT_TOOLS.find((tool) => tool.name === call.name);
          if (known && this.canRun(known, host)) {
            // Пометка и пересборка набора — только когда инструмент появляется
            // впервые. Иначе «подключён в набор» едет в каждом ответе до конца
            // прогона: замер на живом прогоне дал 91 пометку в 91 ответе
            // (`terminal` не входит в группы «Авто», поэтому условие «скрыт
            // набором» верно для него всегда). Модель читает это
            // как «набор всё время меняется», а человек — как рост на каждом шаге.
            const first = !onDemandTools.has(call.name);
            onDemandTools.add(call.name);
            if (!rosterOnly && first) {
              widenedNow = true;
              widenTools();
            }
          }
        }
        const denied =
          planMode && !planApproved && (!PLAN_MODE_TOOLS.has(call.name) || isWriteCall(call.name, call.arguments))
            ? {
                content: `Режим плана: инструмент «${call.name}» недоступен. Ничего не меняй — составь план доступными средствами чтения.`,
                summary: 'режим плана: изменение недоступно',
              }
            : hiddenByPreset && !onDemandTools.has(call.name)
              ? {
                  content: `Набор инструментов «${toolPresetSpec(toolPreset).label}»: «${call.name}» в него не входит. Скажи человеку, какой инструмент нужен, — он сменит набор в композере.`,
                  summary: `набор «${toolPresetSpec(toolPreset).label}»: инструмент недоступен`,
                }
              : undefined;
        if (denied) {
          emit(ChatStreamEvent.ToolStart, {
            id: call.id,
            name: call.name,
            args: call.arguments,
          });
          const refused: ChatMessage = {
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: denied.content,
          };
          messages.push(refused);
          produced.push(refused);
          emit(ChatStreamEvent.ToolResult, {
            id: call.id,
            name: call.name,
            ok: false,
            summary: denied.summary,
          });
          logCall({
            id: call.id,
            name: call.name,
            args: clampRunText(call.arguments),
            ok: false,
            summary: denied.summary,
            note: 'не исполнялся',
          });
          continue;
        }

        // Права перечитываем перед каждым действием: человек мог сменить их
        // выбором в композере, пока агент отвечал. В «Плане» менять нечего.
        // Утвердив план, человек одобрил и работу: дальше права — обычные.
        const liveFlags = permissionFlags(planMode && !planApproved ? 'ask' : this.livePermission);
        toolContext.autoApprove = liveFlags.autoApprove;
        toolContext.allowAll = liveFlags.allowAll;

        const key = `${call.name}:${call.arguments}`;
        // Только ли читает вызов — вопрос не имени, а имени с действием: у слитых
        // инструментов (`terminal`) чтение вывода и запуск команды — один инструмент.
        const readOnly = isReadOnlyCall(call.name, call.arguments);
        const cacheable = isCacheableReadCall(call.name, call.arguments);
        const repeated = cacheable ? executed.get(key) : undefined;
        // Версию сверяем и перед частичным сужением: иначе изменившееся начало
        // файла можно ошибочно выкинуть из нового чтения.
        const readArgs = call.name === 'read' ? parseToolArguments(call.arguments) : undefined;
        const readPath = readArgs?.ok ? readArgs.value.path : undefined;
        if (typeof readPath === 'string' && needsConfirm(coveredReads, readPath)) {
          confirmFile(coveredReads, readPath, await this.contextBlocks.versionOf(readPath));
        }
        // Повтор чтения уже прочитанного диапазона: текст есть выше, не дублируем.
        // После непрозрачного вызова (`terminal`) куски помечены сомнительными: сверяем
        // версию файла с диском — не менялся — «уже прочитано» держится, менялся — забыт.
        let covered = repeated ? undefined : coveredRequest(call.name, call.arguments, coveredReads);
        if (covered && needsConfirm(coveredReads, covered.path)) {
          const stamp = await this.contextBlocks.versionOf(covered.path);
          if (!confirmFile(coveredReads, covered.path, stamp)) covered = undefined;
        }
        // Перекрытие — не повтор, но и не весь текст заново: просят `1–250`, а
        // `1–120` уже выше — читаем только хвост.
        // Пачка (`paths`) сужается отдельно: у `uncoveredRequest` форма только с одним
        // `path`, и повтор пачки, куда добавили один файл, оплачивал старые заново.
        const batch =
          covered || repeated || call.name !== 'read' ? undefined : uncoverFiles(call.arguments, coveredReads);
        const narrowed = covered || repeated ? undefined : uncoveredRequest(call.name, call.arguments, coveredReads);

        emit(ChatStreamEvent.ToolStart, {
          id: call.id,
          name: call.name,
          args: call.arguments,
        });
        let outcome: ToolOutcome;
        // Замер шага: карточка показывает имена и аргументы, а стоило ли это
        // секунду или пять минут — раньше видно не было.
        const startedAt = Date.now();
        if (repeated) {
          outcome = {
            ok: false,
            summary: `повтор вызова «${call.name}» — пропущен`,
            detail:
              'Точно такой вызов уже был в этой ветке. Повтор не нужен: используй уже полученный результат или смени подход.',
          };
        } else if (covered) {
          outcome = {
            ok: true,
            summary: `${covered.path}: строки ${covered.from}–${covered.to} уже прочитаны`,
            detail: 'Этот диапазон уже есть выше в текущей ветке. Возьми текст оттуда, не читай повторно.',
          };
        } else {
          const args = narrowed?.arguments ?? (batch ? JSON.stringify(batch.args) : call.arguments);
          outcome = await runTool(toolContext, call.name, args);
          if (batch) {
            const head = `В пачке ${batch.paths.length} файл(ов) частично уже прочитаны — читаю только непрочитанное.`;
            outcome = {
              ...outcome,
              detail: outcome.detail ? `${head}\n${outcome.detail}` : head,
            };
          }
          if (narrowed) {
            const head = `Начало файла (строки ${narrowed.from - 1} и выше) уже есть в ветке — читаю с ${narrowed.from}.`;
            outcome = {
              ...outcome,
              detail: outcome.detail ? `${head}\n${outcome.detail}` : head,
            };
          }
          // `src` — id вызова: результат ляжет в ветку сообщением с тем же `toolCallId`.
          // Без этой связи покрытие потом не отличить от следа выпавшего хода.
          if (outcome.read) rememberRead(coveredReads, outcome.read, call.id);
          // Пачечное чтение (`paths`) тоже покрывает файлы: без этого каждое имя в
          // нём потом читалось бы заново целиком (3 вызова за мерило — 12 тыс. ток.).
          for (const read of outcome.reads ?? []) rememberRead(coveredReads, read, call.id);
          if (readOnly) {
            if (cacheable) executed.set(key, outcome);
          } else {
            // Изменяющий вызов: прочитанное об изменившихся файлах устарело. Раньше
            // здесь чистилось ВСЁ, и одна правка в одном файле заставляла модель
            // перечитывать всё остальное, что она уже держала в контексте, — лишние
            // шаги на ровном месте. Забываем только затронутое; там, где задетое
            // назвать нельзя (команда, массовая замена по маске), куски помечаются
            // сомнительными и сверяются с диском при следующем чтении (`versionOf`).
            forgetChangedFiles({ executed, coveredReads }, call.name, call.arguments, outcome.changes);
          }
          didNewWork = true;
          didWork = true;
        }
        const callMs = Date.now() - startedAt;
        emit(ChatStreamEvent.ToolResult, {
          id: call.id,
          name: call.name,
          ok: outcome.ok,
          summary: outcome.summary,
          detail: outcome.detail,
          changes: outcome.changes,
          ms: callMs,
          // Картинка и в карточке: человек видит, что именно смотрел агент.
          ...(outcome.images?.length ? { images: outcome.images } : {}),
          // Файлы-результаты: в ленте карточка с кнопками «Открыть».
          ...(outcome.presented?.length ? { presented: [...outcome.presented] } : {}),
        });
        // В трассу попадает тот же вызов, что видит человек в карточке, плюс
        // время: по нему и понятно, на что ушла минута прогона.
        logCall({
          id: call.id,
          name: call.name,
          args: clampRunText(call.arguments),
          ok: outcome.ok,
          summary: clampRunText(outcome.summary, 400),
          ...(outcome.detail ? { detail: clampRunText(outcome.detail) } : {}),
          ms: callMs,
          startedAt,
          ...(repeated ? { note: 'повтор: не исполнялся' } : covered ? { note: 'диапазон уже прочитан' } : {}),
        });

        const result = outcome.ok ? (outcome.detail ?? outcome.summary) : failureText(outcome);
        // Шелл-чтение вместо `read`: после второго подряд — одна строка подсказки.
        // Первый раз молчим: модель могла проверять, что в файле вообще есть. В замере
        // 23 из 90 вызовов `terminal` — чтение через `cat`/`grep`/`sed`, почти всегда с
        // ведущим `cd … &&`: они не попадают в память чтений и ломают её по частям.
        if (call.name === 'read') shellReads = 0;
        else if (call.name === 'terminal' && callFlags(call.name, call.arguments).includes('shell-read'))
          shellReads += 1;
        // Очередь одиночных чтений вместо пачки: считаем подряд и один раз на прогон
        // говорим, что было дешевле. Пачку (`paths`) уже увидели — молчим.
        if (call.name === 'read' || call.name === 'read_file') {
          if (callFlags(call.name, call.arguments).includes('paths')) {
            singleReads = 0;
            pathsHinted = true;
          } else singleReads += 1;
        }
        const pathsNote =
          !pathsHinted && singleReads === 3
            ? '\n(несколько файлов — read с paths одним вызовом: это шаг, а не три)'
            : '';
        if (pathsNote) pathsHinted = true;
        // Один раз на серию, а не в каждом ответе: повторённая строка сама станет шумом.
        const shellReadNote =
          call.name === 'terminal' && shellReads === 2
            ? '\n(файл в проекте дешевле читать «read»: он отдаёт нужный диапазон и не повторяет уже прочитанное)'
            : '';
        // Подключение называем вслух: иначе модель не понимает, почему инструмент
        // раньше не был виден, а человек — почему набор вырос.
        const widenedNote = widenedNow ? `\n(«${call.name}» подключён в набор)` : '';
        const toolMessage: ChatMessage = {
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          // Единая точка сжатия для всех инструментов: в контекст модели уходит
          // текст без оформления, а человек в карточке (событие выше) видит полный.
          content: (compressOutput ? compressToolOutput(result) : result) + widenedNote + shellReadNote + pathsNote,
        };
        countOutput(toolMessage.content ?? '');
        messages.push(toolMessage);
        produced.push(toolMessage);
        // Картинку из результата положить в tool-сообщение нельзя (у OpenAI там
        // допустим только текст), поэтому она едет следующим сообщением
        // пользователя. Живёт оно только внутри прогона: в ветку беседы не идёт —
        // иначе base64 висел бы в истории каждого следующего запроса, а картинку
        // всегда можно прочитать заново.
        if (outcome.images?.length) {
          messages.push({
            role: 'user',
            content: `Изображение из «${call.name}»: ${outcome.summary}`,
            images: outcome.images,
          });
        }
        // Правки записаны — тела правок в контексте больше не нужны: текст лежит
        // в файле, а в истории он висел бы до конца беседы и пересылался на каждом
        // шаге (правка на 200 строк — это около двух тысяч токенов).
        if (outcome.applied) appliedCalls.add(call.id);
      }

      // Меняем только сообщение, которое уходит провайдеру: в `produced` (его
      // видит человек, и оно ложится в файл беседы) остаётся исходный текст.
      // Делаем это сразу после шага, а не перед отправкой: аргументы прошлых
      // ходов — часть префикса запроса, а префикс кеширует провайдер. Сжали один
      // раз — и дальше префикс стабилен, кеш не слетает на каждом шаге.
      if (appliedCalls.size > 0) {
        const at = messages.lastIndexOf(assistant);
        if (at >= 0) messages[at] = condenseAppliedCalls(assistant, appliedCalls);
      }

      // План в истории — только актуальный: `update_plan` присылает список целиком,
      // поэтому прежние версии — повтор того же текста, и он едет в каждом шаге.
      // Сжимаем так же: сразу после шага и только в том, что уходит провайдеру.
      if (planCallId) {
        for (let index = 0; index < messages.length; index += 1) {
          const current = messages[index];
          if (current) messages[index] = condenseSupersededPlans(current, planCallId);
        }
      }

      commitStep();

      // Целый шаг из повторов — модель ходит по кругу. После двух таких шагов
      // останавливаемся: дальше это только сожжёт токены без прогресса.
      stallSteps = didNewWork ? 0 : stallSteps + 1;
      if (stallSteps >= 2) {
        const note = '\n\n[агент остановлен: повторяющиеся вызовы не дают нового результата]';
        text += note;
        emit(ChatStreamEvent.Delta, { text: note });
        produced.push({ role: 'assistant', content: note.trim() });
        commitStep('остановлен: повторяющиеся вызовы');
        return {
          text,
          finishReason,
          usage,
          trace: trace(),
          run: finishRun('limit'),
          reads: snapshotReads(coveredReads),
          agentMessages: produced,
          ...(reasoning ? { reasoning } : {}),
        };
      }
    }

    // Отмена (например, пока пользователь решал судьбу правок) — это не
    // «лимит шагов»: возвращаем то, что успели, без лишней приписки.
    if (signal.aborted) {
      produced.push({ role: 'assistant', content: text });
      return {
        text,
        finishReason,
        usage,
        trace: trace(),
        run: finishRun('aborted'),
        reads: snapshotReads(coveredReads),
        agentMessages: produced,
        ...(reasoning ? { reasoning } : {}),
      };
    }

    const note = '\n\n[агент остановлен: достигнут лимит шагов]';
    text += note;
    emit(ChatStreamEvent.Delta, { text: note });
    produced.push({ role: 'assistant', content: note.trim() });
    return {
      text,
      finishReason,
      usage,
      trace: trace(),
      run: finishRun('limit'),
      reads: snapshotReads(coveredReads),
      agentMessages: produced,
      ...(reasoning ? { reasoning } : {}),
    };
  }

  /**
   * Один шаг обращения к провайдеру с реакцией на переполнение контекста.
   *
   * Бюджет окна считаем сами, но оценка грубая: символов на токен мы не знаем
   * точно, и на русском тексте или незнакомой модели она легко занижает. Поэтому
   * истине верим не расчёту, а самому провайдеру: если он отказал «запрос не влез»,
   * ужимаем бюджет и повторяем тот же шаг. Предсказание может врать — восстановление
   * остаётся, и человек не видит ошибку там, где хватало просто обрезать историю.
   *
   * Оценку подтягиваем к правде: после каждого ответа сверяем наш расчёт с
   * настоящим `usage.promptTokens` и запоминаем поправку (см. `TokenCalibration`).
   * Повторяем, пока есть что резать: если обрезка больше ничего не убирает,
   * крутиться бессмысленно — тогда ошибку отдаём наверх как есть.
   */
  private async streamStep(
    provider: AiProvider,
    params: {
      model: string;
      messages: ChatMessage[];
      tools: readonly unknown[] | undefined;
      temperature: number | undefined;
      maxTokens: number;
      reasoningEffort: ReasoningEffort | undefined;
      /** `false` — выключить размышление явно; `undefined` — не упоминать его. */
      thinking?: boolean;
      /** Метка пользователя для провайдера (`user_id`). */
      userId?: string;
      signal: AbortSignal;
      windowTokens: number;
      toolsTokens: number;
      /** Ключ калибровки оценки (провайдер + модель), см. `TokenCalibration`. */
      calibrationKey: string;
      onDelta: (delta: string) => void;
      onReasoning: (delta: string) => void;
    },
  ): Promise<ChatStreamDone> {
    // Поправка оценки (см. `TokenCalibration`): если провайдер обычно показывает
    // больше токенов, чем мы насчитали, окно для обрезки берём во столько же раз
    // меньше — тогда расчёт не пропустит запрос, который у провайдера не влезет.
    const scale = this.calibration.scaleFor(params.calibrationKey);
    const windowTokens = Math.max(1, Math.floor(params.windowTokens / scale));

    const budget = (factor: number, keepRecent: number): { messages: ChatMessage[]; dropped: number } => {
      // Сначала свёртка старых результатов, и только потом выбрасывание ходов:
      // текст уходит в файл с адресом, а пара «вызов — ответ» остаётся целой.
      const limitTokens = Math.floor(windowTokens * factor);
      const reserveTokens = answerReserve(params.maxTokens, windowTokens);
      ageToolResults(params.messages, {
        keepRecent: keepRecent * 2 + 2,
        needTokens: estimateMessagesTokens(params.messages) - (limitTokens - params.toolsTokens - reserveTokens),
        ...(this.spillDir ? { spillDir: this.spillDir } : {}),
      });
      return trimMessagesToFit(params.messages, {
        limitTokens,
        overheadTokens: params.toolsTokens,
        reserveTokens,
        keepRecent,
        marker: TRIM_MARKER,
      });
    };

    let wire = budget(1, 2);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const done = await provider.streamChat(
          {
            model: params.model,
            messages: wire.messages,
            temperature: params.temperature,
            maxTokens: params.maxTokens,
            reasoningEffort: params.reasoningEffort,
            ...(params.thinking === undefined ? {} : { thinking: params.thinking }),
            ...(params.userId ? { userId: params.userId } : {}),
            tools: params.tools,
          },
          { onDelta: params.onDelta, onReasoning: params.onReasoning },
          params.signal,
        );
        // Факт против оценки: провайдер сам сказал, сколько входных токенов взял.
        // Сравниваем с оценкой того же запроса и запоминаем поправку на будущее —
        // следующим шагам она уже не даст промахнуться мимо окна.
        // Сравниваем с ВСЕМ входом: провайдер с кешем называет кешированное
        // отдельным полем, а провайдеры приводятся к одному смыслу так, что
        // `promptTokens` его включает (см. AnthropicProvider). Иначе при
        // попадании в кеш оценка выглядела бы вдесятеро больше факта и обучила
        // бы калибровку врать.
        if (done.usage?.promptTokens !== undefined) {
          const estimated = estimateMessagesTokens(wire.messages) + params.toolsTokens;
          this.calibration.observe(params.calibrationKey, estimated, done.usage.promptTokens);
          saveCalibration(this.settings.file(), this.calibration.snapshot());
        }
        // Диагностика: разбивка оценки по секциям — видно, что реально занимает окно
        // (чат, результаты инструментов, фиксированные схемы). Включается переменной
        // окружения, в обычном режиме молчит.
        if (process.env.CHUI_TRACE_CONTEXT) {
          const results = estimateMessagesTokens(wire.messages.filter((m) => m.role === 'tool'));
          const chat = estimateMessagesTokens(wire.messages.filter((m) => m.role !== 'tool'));
          console.debug('[context]', {
            key: params.calibrationKey,
            chat,
            tools: params.toolsTokens,
            results,
            dropped: wire.dropped,
          });
        }
        return done;
      } catch (error) {
        // Промах оценки: провайдер сам сказал, что не влезло. Режем жёстче — но
        // лишь пока есть что резать, иначе повтор бессмыслен.
        if (!isContextOverflow(error) || attempt >= OVERFLOW_RETRIES) throw error;
        const tighter = budget(OVERFLOW_SHRINK ** (attempt + 1), 1);
        if (tighter.dropped === 0) throw error;
        wire = tighter;
      }
    }
  }

  /**
   * Может ли эта сборка исполнить инструмент. Файловые операции живут в
   * main; правки, диагностика и открытие вкладки — в renderer, поэтому зависят
   * от того, подключён ли мост. Лишний инструмент хуже отсутствующего: модель
   * потратит шаг на вызов, который заведомо не сработает.
   */
  /**
   * Внешние инструменты (MCP) в том виде, в каком они уходят модели.
   *
   * Инструмент, который меняет состояние, требует подтверждения — значит, без
   * подключённого окна он заведомо не сработает, и предлагать его нельзя. Такие
   * отсеиваем сразу: лишний инструмент стоит токенов в каждом запросе.
   */
  private async externalTools(host: ChatHostBridge | undefined): Promise<ExposedToolSpec[]> {
    if (!this.mcp) return [];
    let tools: readonly McpToolInfo[] = [];
    try {
      tools = await this.mcp.list();
    } catch {
      // Серверы недоступны — работаем без внешних инструментов, а не падаем.
      return [];
    }

    // Сперва отсеиваем то, что заведомо не сработает без подтверждения, затем
    // применяем потолки: описание каждого инструмента уходит в КАЖДЫЙ запрос, и
    // один сервер с парой сотен инструментов съел бы окно сам по себе.
    const usable = tools.filter((tool) => tool.readOnly || host?.confirmCommand !== undefined);
    return selectMcpTools(usable).offered.map((tool) => ({
      name: tool.exposedName,
      // Описание даёт сервер, но может его и не дать: пустое описание модель
      // прочитает как «непонятно что», поэтому подставляем своё.
      description: tool.description || `Внешний инструмент «${tool.toolName}» сервера «${tool.serverId}» (MCP)`,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Схемы инструментов ресурсов MCP — или пусто, если ни один сервер ресурсов не
   * объявил.
   *
   * Пустой каталог не стоит ни одного лишнего токена: инструмент, который заведомо
   * ответит «ресурсов нет», модели предлагать незачем. Цена вопроса — один запрос к
   * уже поднятому серверу на прогон.
   */
  private async resourceTools(): Promise<ExposedToolSpec[]> {
    if (!this.mcp) return [];
    try {
      if ((await this.mcp.resources()).length === 0) return [];
    } catch {
      return [];
    }
    return AGENT_TOOLS.filter((tool) => tool.name === 'mcp').map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Ключ для поиска. Свой ключ поиска главнее; у поиска DeepSeek запасной
   * вариант — ключ самого подключения DeepSeek: это один и тот же аккаунт, и
   * требовать вводить его второй раз незачем.
   */
  private webSearchKey(search: AiWebSearchSettings): string | undefined {
    const own = this.settings.resolveWebSearchKey();
    if (own) return own;
    if (search.provider === 'deepseek') return this.settings.resolveApiKey('deepseek');
    return undefined;
  }

  private canRun(tool: AgentToolSpec, host: ChatHostBridge | undefined): boolean {
    return canRunTool(tool, this.toolEnv(host));
  }

  /**
   * Окружение доступности одним значением.
   *
   * Отдельным методом, а не двумя копиями полей: `canRunTool` решает, ехать ли
   * схеме, `narrowToolSpec` — что в ней оставить. Два разных набора полей
   * разошлись бы молча: инструмент остался бы в списке, а действие из него
   * выпало бы не то.
   */
  private toolEnv(host: ChatHostBridge | undefined): ToolAvailability {
    const ai = this.settings.get().ai;
    return {
      host,
      terminals: this.terminals,
      tests: this.tests,
      linter: this.linter,
      symbols: this.symbols,
      browser: this.browser,
      browserEnabled: ai.browser.enabled,
      webSearch: ai.webSearch,
      webFetchEnabled: ai.webFetch?.enabled === true,
      webSearchKey: this.webSearchKey(ai.webSearch),
    };
  }

  /**
   * Короткие запросы к модели: подсказка, коммит, тест, название, второе мнение о
   * команде. Лениво и только один раз: провайдер спрашивается по требованию, а
   * настройки читаются свежими при каждом запросе — сервис уже так живёт.
   */
  private queries(): ReturnType<typeof createAiQueries> {
    this.queriesInstance ??= createAiQueries({
      quickModel: () => this.pickModel(undefined),
      reviewModel: () => this.pickModel(this.settings.get().ai.reviewModel),
      provider: (providerId) => this.createProvider(providerId),
    });
    return this.queriesInstance;
  }

  /**
   * Модель для короткого ответа: названная в настройке, а без неё — активная.
   * `null`, когда активной нет вовсе: короткому запросу нечем отвечать.
   */
  private pickModel(named: string | undefined): { providerId: string; model: string } | null {
    const ai = this.settings.get().ai;
    const providerId = ai.activeProviderId;
    if (!providerId) return null;
    const model = named?.trim() || ai.quickModel?.trim() || ai.activeModel;
    if (!model) return null;
    return { providerId, model };
  }

  private createProvider(providerId: string): AiProvider {
    const provider = this.settings.get().ai.providers.find((item) => item.id === providerId);
    if (!provider) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `Провайдер не найден: ${providerId}`);
    }

    const apiKey = this.settings.resolveApiKey(providerId);
    if (!apiKey && !isLocalEndpoint(provider.baseUrl)) {
      throw new RpcFailure(
        RpcErrorCode.InvalidParams,
        `Не задан API-ключ для «${provider.label}». Укажите его в панели AI или в settings.json`,
      );
    }

    if (provider.protocol === 'anthropic') {
      return new AnthropicProvider({
        id: provider.id,
        label: provider.label,
        baseUrl: provider.baseUrl,
        apiKey,
      });
    }

    return new OpenAiCompatibleProvider({
      id: provider.id,
      label: provider.label,
      // Строгая схема у DeepSeek живёт только в beta: адрес переписываем здесь,
      // а не в настройках, чтобы человек не держал два адреса в голове.
      baseUrl: betaBaseUrl(provider.baseUrl, provider.strictTools === true),
      apiKey,
    });
  }
}

/** Собирает блоки вложений в одно системное сообщение. */
function renderAttachments(attachments: readonly ChatAttachment[]): string {
  const blocks = attachments.map((item) => `### ${item.title}\n${item.text}`);
  return ['Контекст, который приложил пользователь:', ...blocks].join('\n\n');
}

/**
 * Изображения едут не текстом, а частями контента, но модели полезно знать,
 * что именно к ней приложили — особенно тем, кто картинки не понимает: тогда
 * в ответе будет понятная реакция, а не молчание.
 */
function renderImageNote(images: readonly ChatAttachment[]): string {
  const list = images.map((item) => item.label).join(', ');
  return [
    `К вопросу приложены изображения: ${list}.`,
    'Считай их частью вопроса: если на них есть код, схема или ошибка — отвечай по ним.',
  ].join('\n');
}

/**
 * Прикрепить картинки к последнему сообщению пользователя.
 * Пределы проверяем здесь, а не только в интерфейсе: данные вложения собирает
 * renderer (вставка из буфера, перетаскивание), поэтому он не источник истины.
 */
function attachImages(messages: ChatMessage[], images: readonly string[]): void {
  assertChatImages(images);

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== 'user') continue;
    message.images = images;
    return;
  }

  // Сообщения пользователя нет (например, вопрос пришёл только вложениями):
  // тогда картинкам нужен свой контейнер.
  messages.push({ role: 'user', content: 'Изображения к вопросу', images });
}

/**
 * Что именно делает `mind`: `steps` (план), `goal` (цель) или `other`.
 *
 * План и цель — два состояния беседы, поэтому у них один инструмент с полем
 * `action`. Действие решает, какой из двух разборов применить: без действия
 * (и при неразборчивом JSON) считаем шагами — так звали `plan`. Остальные
 * действия общего инструмента (`remember`, `ask`, `forget`…) перехвату не подлежат:
 * иначе память молча не запишется.
 */
function planActionOf(raw: string): 'steps' | 'goal' | 'other' {
  try {
    const value = JSON.parse(raw) as unknown;
    const action = (value as { action?: unknown } | null)?.action;
    if (action === undefined || action === 'steps') return 'steps';
    if (action === 'goal') return 'goal';
    return 'other';
  } catch {
    return 'steps';
  }
}

/**
 * Разбор аргументов плана. Модель — недоверенный источник, поэтому
 * шаги проверяем: пустые гасим, статус приводим к известному, длину ограничиваем.
 */
function parsePlanSteps(raw: string): PlanStep[] {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  const list = (value as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(list)) return [];

  const allowed: PlanStepStatus[] = ['pending', 'in_progress', 'done'];
  return list
    .slice(0, 40)
    .map((item): PlanStep | null => {
      if (typeof item !== 'object' || item === null) return null;
      const text = (item as { text?: unknown }).text;
      if (typeof text !== 'string' || text.trim().length === 0) return null;
      const status = (item as { status?: unknown }).status;
      return {
        text: text.trim().slice(0, 300),
        status: allowed.includes(status as PlanStepStatus) ? (status as PlanStepStatus) : 'pending',
      };
    })
    .filter((step): step is PlanStep => step !== null);
}

function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(url.hostname);
  } catch {
    return false;
  }
}

function describeConnectionError(error: unknown): string {
  // Node прячет причину в `cause`: у `fetch` в сообщении только «fetch failed»,
  // а настоящий код (ECONNREFUSED, ENOTFOUND) лежит уровнем глубже.
  const parts: string[] = [];
  let node: unknown = error;
  for (let depth = 0; depth < 4 && node; depth += 1) {
    const message = node instanceof Error ? node.message : String(node);
    if (message) parts.push(message);
    const code = (node as { code?: unknown }).code;
    if (typeof code === 'string') parts.push(code);
    node = (node as { cause?: unknown }).cause;
  }
  const raw = parts.join(' · ');

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return 'Адрес не найден — проверьте написание сервера';
  if (/ECONNREFUSED/i.test(raw)) return 'Сервер не отвечает — он запущен и слушает этот порт?';
  if (/HTTP 401|HTTP 403/.test(raw)) return 'Ключ отклонён — проверьте, что он актуален';
  if (/HTTP 404/.test(raw)) return 'По этому адресу нет API — возможно, забыт суффикс /v1';
  if (/HTTP 429/.test(raw)) return 'Слишком много запросов — подождите и повторите';
  if (/abort/i.test(raw)) return 'Проверка отменена';
  // Всё остальное с «fetch failed» — тоже проблема связи, а не конфигурации.
  if (/fetch failed/i.test(raw)) return 'Сервер не отвечает — он запущен и слушает этот порт?';
  return raw || 'Не удалось подключиться';
}
