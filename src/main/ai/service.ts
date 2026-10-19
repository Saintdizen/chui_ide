import { promises as fs, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
import { compressToolOutput } from '../../shared/output-compress';
import { formatShortMap } from '../../shared/project-map';
import { modelCapabilities, contextWindow, findProviderPreset, reasoningEffortFor } from '../../shared/providers';
import { AGENT_TOOLS, toOpenAiTools, type AgentToolSpec, type ExposedToolSpec } from '../../shared/tools';
import {
  estimateMessagesTokens,
  estimateTokens,
  isContextOverflow,
  TokenCalibration,
  trimMessagesToFit,
} from '../../shared/context-fit';
import { formatMemory } from '../../shared/memory';
import { formatSkillCatalog } from '../../shared/skills';
import {
  cleanCompletion,
  INLINE_MAX_CHARS,
  INLINE_MAX_TOKENS,
  INLINE_SYSTEM_PROMPT,
  renderInlinePrompt,
} from '../../shared/inline-ai';
import {
  buildCommitPrompt,
  cleanCommitMessage,
  COMMIT_MAX_CHARS,
  COMMIT_MAX_TOKENS,
  COMMIT_SYSTEM_PROMPT,
  type CommitPromptParts,
} from '../../shared/commit-message';
import {
  buildTestPrompt,
  cleanTestCode,
  TEST_MAX_CHARS,
  TEST_MAX_TOKENS,
  TEST_SYSTEM_PROMPT,
  type TestPromptParts,
} from '../../shared/test-generation';
import {
  buildTitlePrompt,
  cleanChatTitle,
  CHAT_TITLE_MAX_TOKENS,
  CHAT_TITLE_SYSTEM_PROMPT,
  type ChatTitleParts,
} from '../../shared/chat-title';
import { sandboxNote } from '../../shared/sandbox';
import { coveredRequest, rememberRead } from '../../shared/read-coverage';
import {
  permissionFlags,
  permissionFromAutoApprove,
  sanitizePermission,
  type PermissionPreset,
} from '../../shared/permissions';
import { addUsage } from '../../shared/usage';
import { ProjectMemory } from './project-memory';
import { createSkillLibrary, type SkillLibrary } from './skills';
import type { SandboxService } from '../sandbox/sandbox';
import { RpcFailure } from '../ipc/router';
import { scanProject } from '../project/scan';
import type { SettingsStore } from '../settings';
import type { WorkspaceService } from '../workspace/workspace';
import { selectMcpTools, type McpToolInfo } from '../../shared/mcp';
import {
  runTool,
  type BrowserTools,
  type GitTools,
  type Linter,
  type McpRunner,
  type SymbolSearch,
  type SkillTools,
  type TerminalAgent,
  type TestRunner,
  type ToolContext,
  type ToolOutcome,
} from './agent-tools';
import { AnthropicProvider } from './anthropic';
import { searchWeb, webSearchNeedsKey, webSearchProviderLabel } from './web-search';
import { assertChatImages } from './images';
import { OpenAiCompatibleProvider } from './openai-compatible';
import type { AiProvider } from './provider';

/**
 * Файлы с правилами проекта — подмешиваются в системный промпт. Читаются все,
 * а не первый найденный: имена разные не потому, что это варианты одного файла,
 * а потому, что так их называют разные инструменты, и в проекте их заводит
 * каждый свой. `.ai_rules` — наше имя, оно читается первым: если человек завёл
 * его, его правила должны стоять выше чужих.
 *
 * Порядок в списке = порядок в промпте: сначала общие правила проекта, потом
 * уточнения инструментов.
 */
const INSTRUCTION_FILES = ['.ai_rules', 'AGENTS.md', 'CHUI.md', 'CLAUDE.md'];
/** Потолок на один файл: правила не должны вытеснять саму беседу из окна. */
const MAX_INSTRUCTIONS_BYTES = 8000;
/**
 * Потолок на все файлы вместе. Файлы подмешиваются в каждый запрос, поэтому
 * четыре разных по 8 КБ — это уже половина скромного окна под одни правила.
 */
const MAX_INSTRUCTIONS_TOTAL_BYTES = 20_000;

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

// Лимиты шагов «модель → инструмент → модель» живут в настройках
// (`ai.maxSteps` и `ai.maxAutopilotSteps`): значения по умолчанию — там же.

/**
 * Инструменты режима «План»: только чтение проекта и ведение плана. Всё, что
 * меняет мир (правки, файловые операции, команды), здесь и не предлагается,
 * и не исполняется — даже если модель вызовет такой инструмент по имени.
 */
const PLAN_MODE_TOOLS = new Set<string>([
  'list_dir',
  'read_file',
  'read_files',
  'search',
  'codebase_search',
  'search_docs',
  'read_skill',
  'find_references',
  'go_to_definition',
  'project_map',
  'file_outline',
  'run_linter',
  'web_search',
  'find_files',
  'get_diagnostics',
  'git_status',
  'git_log',
  'git_diff',
  'git_blame',
  'open_file',
  'update_plan',
  'ask',
  'task',
]);

/**
 * Инструменты, которые только читают состояние. Их повтор без нового
 * результата — признак зацикливания, и повторный вызов можно не исполнять.
 * Правки и команды сюда не входят: они меняют мир, и повторить их бывает нужно.
 */
const READ_ONLY_TOOLS = new Set([
  'list_dir',
  'read_file',
  'read_files',
  'search',
  'codebase_search',
  'search_docs',
  'read_skill',
  'find_references',
  'go_to_definition',
  'project_map',
  'file_outline',
  'run_linter',
  'find_files',
  'get_diagnostics',
  'git_status',
  'git_log',
  'git_blame',
  // Подзадача тоже только читает — а стоит дорого, поэтому повтор пропускаем.
  'task',
  // Снимок страницы читает её состояние. После действия (клик, переход, ввод)
  // кэш всё равно сбрасывается: те инструменты меняют мир.
  'browser_snapshot',
]);

/**
 * Инструменты подзадачи (`task`): только чтение. Правки и команды остаются за
 * основным агентом — он показывает ревью и спрашивает пользователя. Так подзадача
 * выходит дешёвой и безопасной: контекст тратится на чтение, а назад едет выжимка.
 */
const SUBAGENT_TOOLS = new Set<string>([
  'list_dir',
  'read_file',
  'read_files',
  'search',
  'codebase_search',
  'search_docs',
  'read_skill',
  'find_references',
  'go_to_definition',
  'project_map',
  'file_outline',
  'run_linter',
  'find_files',
  'get_diagnostics',
  'git_status',
  'git_log',
  'git_diff',
  'git_blame',
  'web_search',
]);

/** Шагов подзадаче меньше, чем основному агенту: её дело — собрать факты, а не работать. */
const SUBAGENT_MAX_STEPS = 16;

/** Потолок отчёта подзадачи: это выжимка для основного агента, а не второй контекст. */
const SUBAGENT_REPORT_CHARS = 8000;

/** Дописывается в системный промпт, когда агентный режим включён. */
const AGENT_PROMPT = [
  'Когда ради одного ответа нужно перечитать много файлов, делегируй это подзадаче (`task`): её чтения твою беседу не раздувают, а назад придёт готовый отчёт.',
  'Работай с проектом инструментами, а не по догадке: назначение и аргументы у каждого инструмента описаны отдельно — читай их.',
  'Устройство проекта видно по карте в начале беседы: не обходи дерево и не читай манифесты, чтобы понять, что это за проект. Подробнее — project_map.',
  'Не выдумывай содержимое файлов: то, чего не знаешь, читай инструментами.',
  'Прежде чем читать файл целиком, найди место: codebase_search — где объявлен символ, find_references — где он используется, search — где встречается текстом, find_files — какие файлы есть.',
  'У search есть context (как -A/-B у grep): с ним рядом с совпадением видно соседние строки. Часто этого хватает, и отдельный read_file не нужен — бери context=2–3, когда важно окружение совпадения.',
  'Вопрос о том, как проект устроен или как что-то сделать, сперва задай документации (search_docs): там готовый ответ, а не вывод по коду. Запрос можно писать словами.',
  'Устройство файла видно по скелету (file_outline): объявления с номерами строк. Дальше читай этим диапазоном, а не файл целиком.',
  'Большие файлы читай диапазоном строк и не перечитывай одно и то же много раз.',
  'Задачу из нескольких шагов начинай с update_plan и обновляй план по ходу.',
  'Перед тем как чинить код, посмотри get_diagnostics — так видно настоящую ошибку, а не догадку.',
  'Для правок по умолчанию бери apply_patch: там не нужно называть строки и столбцы — ты даёшь точный фрагмент, который надо заменить, а позиции IDE считает сама. Позиционный apply_edit уместен, когда место уже посчитано тобой точно.',
  'Если apply_edit ответил «не совпало с текстом документа» — перечитай файл и повтори правку, а не меняй формулировку наугад.',
  'Если apply_patch ответил, что фрагмент не найден или найден несколько раз — перечитай файл и возьми якорь дословно и шире (с соседней строкой или именем функции), а не меняй формулировку наугад.',
  'Правки и команды пользователь подтверждает — не считай их сделанными, пока не получил ответ инструмента.',
  'Договорённости и предпочтения, важные надолго, записывай в память проекта (`remember`): она переживает беседу и её сжатие. Разовый контекст в память не пиши.',
].join('\n');

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
  'Режим плана: сначала изучи проект доступными инструментами чтения, затем составь план через update_plan.',
  'Ничего не меняй: правки файлов и запуск команд в этом режиме недоступны и не выполнятся.',
  'В конце объясни план словами: что предлагаешь сделать, в каком порядке и почему. Жди решения пользователя.',
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
 * Системная инструкция подзадачи (`task`). Подзадача не видит беседу и не
 * продолжает её: её единственный результат — отчёт, по которому основной агент
 * действует, не перечитывая всё сам.
 */
const SUBAGENT_PROMPT = [
  'Ты — подзадача (sub-agent) внутри IDE. У тебя свой контекст: основной агент не видит твоих шагов и получит только твой итоговый отчёт.',
  'Исследуй проект доступными инструментами чтения и верни КРАТКИЙ, но конкретный отчёт: файлы и номера строк, имена символов, нужные фрагменты, вывод команд — то, по чему можно действовать, не читая всё заново.',
  'Пиши по делу: что нашёл, где именно (путь:строка) и что это значит. Не пересказывай задание и не извиняйся.',
  'Инструменты только для чтения: менять проект ты не можешь.',
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
  /** Спросить разрешение на действие git (коммит, отправка, переключение ветки, откат). */
  confirmGit(action: string): Promise<boolean>;
  /** Спросить разрешение на действие в браузере (переход, клик, ввод, скрипт). */
  confirmBrowser(action: string): Promise<boolean>;
  /** Задать человеку вопрос и дождаться ответа: инструмент `ask`. Пустая строка — ответа не будет. */
  ask(question: string, options?: readonly string[]): Promise<string>;
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
  /** Git подключается снаружи (registerIpc): без него git-инструменты не предлагаем. */
  private git?: GitTools;
  /** Терминальные сессии тоже приходят снаружи: без них terminal_* не предлагаем. */
  private terminals?: TerminalAgent;
  /** Поиск символов проекта: без него codebase_search ищет только текстом. */
  private symbols?: SymbolSearch;
  /** Линтер проекта: без него инструмент run_linter модели не предлагаем. */
  private linter?: Linter;
  /** Команда тестов проекта: без неё инструмент run_tests модели не предлагаем. */
  private tests?: TestRunner;
  /** Внешние инструменты (MCP): нет сервиса — внешних инструментов не предлагаем. */
  private mcp?: McpRunner;
  /** Браузер: без него инструменты `browser_*` не предлагаем. */
  private browser?: BrowserTools;
  /** Песочница: без неё команды и тесты идут на хосте, как раньше. */
  private sandbox?: SandboxService;
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
   * Карта проекта для промпта. Скан обходит дерево, поэтому держим результат до
   * смены папки: в каждом запросе обходить проект заново — платить за одно и то
   * же. Числа поэтому могут отстать от жизни (агент что-то создал) — за свежими
   * он идёт в `project_map`, который сканирует на каждый вызов.
   */
  private mapCache: { root: string; text: string } | null = null;

  /**
   * Память проекта: заметки агента, переживающие беседу. Она нужна и для промпта,
   * и для инструментов. Хранилище можно подменить (проверки пишут в temp-каталог,
   * а не в userData разработчика), поэтому приходит параметром.
   */
  private readonly memory: ProjectMemory;

  constructor(
    private readonly settings: SettingsStore,
    private readonly workspace: WorkspaceService,
    memory?: ProjectMemory,
  ) {
    this.memory = memory ?? new ProjectMemory();
    // Поправки оценки токенов переживают перезапуск: без них первые шаги снова
    // промахиваются мимо окна, пока калибровка не наберёт замеры заново.
    this.calibration.load(readCalibration(this.settings.file()));
  }

  /** Подключить git рабочей папки: включает инструменты git_status и git_diff. */
  attachGit(git: GitTools): void {
    this.git = git;
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
   * codebase_search. Без него инструмент не предлагаем — текстовый поиск уже
   * есть отдельно (`search`), и дублировать его незачем.
   */
  attachSymbols(symbols: SymbolSearch): void {
    this.symbols = symbols;
  }

  /**
   * Подключить линтер проекта: включает инструмент `run_linter`. Движок и запуск
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
      return { ok: false, models: [], message: 'Нужен API-ключ: без него провайдер отклонит запрос' };
    }

    // Проверка идёт тем же протоколом, что и рабочий запрос: у Anthropic он свой.
    const preset = params.providerId ? findProviderPreset(params.providerId) : undefined;
    const provider: AiProvider =
      preset?.protocol === 'anthropic'
        ? new AnthropicProvider({ id: 'test', label: 'Проверка', baseUrl, apiKey })
        : new OpenAiCompatibleProvider({ id: 'test', label: 'Проверка', baseUrl, apiKey });
    try {
      const models = await provider.listModels(signal);
      return {
        ok: true,
        models,
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
   * Подсказка для inline-автодополнения: продолжить код в месте курсора.
   *
   * В отличие от `chat` здесь нет ни истории, ни инструментов — только контекст
   * вокруг курсора и короткий ответ. Модель берём активную (ту, что выбрана в
   * панели AI): отдельной настройки для подсказок не заводим.
   */
  async completeInline(request: InlineCompletionRequest, signal: AbortSignal): Promise<InlineCompletionResult> {
    const ai = this.settings.get().ai;
    const providerId = ai.activeProviderId;
    const model = ai.activeModel;
    if (!providerId || !model) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, 'Не выбрана модель для подсказок (панель AI)');
    }
    const provider = this.createProvider(providerId);

    const messages: ChatMessage[] = [
      { role: 'system', content: INLINE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: renderInlinePrompt({
          language: request.language,
          relativePath: request.path,
          prefix: request.prefix,
          suffix: request.suffix,
        }),
      },
    ];

    let text = '';
    try {
      await provider.streamChat(
        { model, messages, temperature: 0.1, maxTokens: INLINE_MAX_TOKENS },
        {
          onDelta: (piece) => {
            // Потолок по символам: `maxTokens` — просьба, а не гарантия.
            if (text.length < INLINE_MAX_CHARS) text += piece;
          },
        },
        signal,
      );
    } catch (error) {
      // Отмена — это человек печатает дальше, а не сбой. Отдаём пусто: подсказка
      // не нужна, а ошибку в редакторе показывать негде.
      if (signal.aborted) return { text: '' };
      throw error;
    }

    return { text: cleanCompletion(text) };
  }

  /**
   * Сообщение коммита по diff.
   *
   * Один запрос — один короткий ответ, как у inline-подсказок: ни истории, ни
   * инструментов, ни карты проекта. Сообщение коммита — это не беседа, и платить
   * за беседу здесь незачем. Модель берём активную (выбранную в панели AI):
   * отдельной настройки для сообщений не заводим.
   */
  async commitMessage(request: CommitPromptParts, signal: AbortSignal): Promise<CommitMessageResult> {
    const ai = this.settings.get().ai;
    const providerId = ai.activeProviderId;
    const model = ai.activeModel;
    if (!providerId || !model) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, 'Не выбрана модель (панель AI)');
    }
    const provider = this.createProvider(providerId);

    const messages: ChatMessage[] = [
      { role: 'system', content: COMMIT_SYSTEM_PROMPT },
      { role: 'user', content: buildCommitPrompt(request) },
    ];

    let text = '';
    await provider.streamChat(
      { model, messages, temperature: 0.2, maxTokens: COMMIT_MAX_TOKENS },
      {
        onDelta: (piece) => {
          // Потолок по символам: `maxTokens` — просьба, а не гарантия.
          if (text.length < COMMIT_MAX_CHARS) text += piece;
        },
      },
      signal,
    );

    return { message: cleanCommitMessage(text) };
  }

  /**
   * Тест к выделенному коду.
   *
   * Один запрос — один ответ, как у inline-подсказок и сообщения коммита: ни истории,
   * ни инструментов, ни карты проекта — платить за беседу тут незачем. Модель берём
   * активную (выбранную в панели AI).
   */
  async generateTest(request: TestPromptParts, signal: AbortSignal): Promise<TestGenerationResult> {
    const ai = this.settings.get().ai;
    const providerId = ai.activeProviderId;
    const model = ai.activeModel;
    if (!providerId || !model) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, 'Не выбрана модель (панель AI)');
    }
    const provider = this.createProvider(providerId);

    const messages: ChatMessage[] = [
      { role: 'system', content: TEST_SYSTEM_PROMPT },
      { role: 'user', content: buildTestPrompt(request) },
    ];

    let text = '';
    await provider.streamChat(
      { model, messages, temperature: 0.2, maxTokens: TEST_MAX_TOKENS },
      {
        onDelta: (piece) => {
          // Потолок по символам: `maxTokens` — просьба, а не гарантия.
          if (text.length < TEST_MAX_CHARS) text += piece;
        },
      },
      signal,
    );

    return { code: cleanTestCode(text) };
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
    const ai = this.settings.get().ai;
    const providerId = ai.activeProviderId;
    const model = ai.activeModel;
    if (!providerId || !model) return { title: '' };

    let text = '';
    try {
      const provider = this.createProvider(providerId);
      const messages: ChatMessage[] = [
        { role: 'system', content: CHAT_TITLE_SYSTEM_PROMPT },
        { role: 'user', content: buildTitlePrompt(request) },
      ];
      await provider.streamChat(
        { model, messages, temperature: 0.2, maxTokens: CHAT_TITLE_MAX_TOKENS },
        {
          onDelta: (piece) => {
            // Потолок по символам: `maxTokens` — просьба, а не гарантия.
            if (text.length < 400) text += piece;
          },
        },
        signal,
      );
    } catch {
      // Молча: название — украшение, а не работа. Отменённый прогон тоже здесь.
      return { title: '' };
    }

    return { title: cleanChatTitle(text) };
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
    const useTools = request.useTools ?? false;
    const planMode = request.planMode ?? false;
    // В режиме плана менять ничего нельзя, поэтому права не в счёт: там «спрашивать».
    const permission = planMode
      ? 'ask'
      : request.permission
        ? sanitizePermission(request.permission)
        : permissionFromAutoApprove(request.autoApprove);
    const flags = permissionFlags(permission);
    // Текущие права запоминаем на сервисе: дальше их можно менять на лету.
    this.livePermission = permission;

    const messages: ChatMessage[] = [];
    const systemPrompt = request.systemPrompt ?? settings.ai.systemPrompt;
    if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt });

    // Карта проекта нужна там, где агент работает с проектом; в «Вопросе»
    // инструментов нет, и обход дерева за наши деньги был бы лишним.
    // Навыки читаются один раз на прогон: каталог нужен и в промпте, и инструменту.
    const skills = createSkillLibrary(this.workspace.rootPath());
    const context = await this.buildWorkspaceContext(useTools || planMode, skills);
    if (context) messages.push({ role: 'system', content: context });
    // Контекст, который пользователь приложил сам (выделение, файл, ошибки),
    // едет отдельным сообщением: в самом вопросе он мешал бы его читать.
    const attachments = request.attachments ?? [];
    const images = attachments.filter((item) => item.kind === 'image' && item.dataUrl);
    const texts = attachments.filter((item) => item.kind !== 'image');
    if (texts.length > 0) messages.push({ role: 'system', content: renderAttachments(texts) });
    if (images.length > 0) {
      messages.push({ role: 'system', content: renderImageNote(images) });
    }
    // Песочница меняет то, где выполняются команды, поэтому агенту об этом
    // говорят прямо: иначе он будет искать инструменты хоста в контейнере и
    // удивляться, почему установленные пакеты исчезли.
    const sandboxed = sandboxSettings.enabled && this.sandbox !== undefined;
    const sandboxPrompt = sandboxed ? sandboxNote(sandboxSettings, this.sandbox!.available) : '';

    if (planMode) messages.push({ role: 'system', content: `${AGENT_PROMPT}\n${PLAN_PROMPT}` });
    else if (useTools)
      messages.push({
        role: 'system',
        content: [AGENT_PROMPT, permission === 'full' ? AUTO_APPROVE_PROMPT : '', sandboxPrompt]
          .filter(Boolean)
          .join('\n'),
      });
    else messages.push({ role: 'system', content: ASK_PROMPT });

    messages.push(...request.messages);

    // Сами картинки идут частями ПОСЛЕДНЕГО сообщения пользователя: отдельным
    // system-сообщением их не примет почти ни один провайдер — изображение
    // допустимо только в сообщении пользователя.
    if (images.length > 0)
      attachImages(
        messages,
        images.map((item) => item.dataUrl!),
      );

    // Предлагаем модели только то, что реально может исполнить эта сборка.
    // Навыки спрашиваем заранее: read_skill без единого навыка — шаг впустую.
    const hasSkills = useTools && (await skills.list()).length > 0;
    const available = useTools
      ? AGENT_TOOLS.filter(
          (tool) => this.canRun(tool, host, hasSkills) && (!planMode || PLAN_MODE_TOOLS.has(tool.name)),
        )
      : [];

    // Внешние инструменты (MCP) добавляем к нашим. В режиме плана их нет: что
    // делает чужой инструмент, мы не знаем, а план ничего менять не должен.
    const external = useTools && !planMode && this.mcp ? await this.externalTools(host) : [];
    const offered = [...available, ...external];
    const tools = offered.length > 0 ? toOpenAiTools(offered) : undefined;
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
    if (this.git) toolContext.git = this.git;
    if (this.terminals) toolContext.terminals = this.terminals;
    if (this.symbols) toolContext.symbols = this.symbols;
    if (this.linter) toolContext.linter = this.linter;
    if (this.tests) toolContext.tests = this.tests;
    toolContext.memory = {
      remember: (text, scope) => this.memory.remember(this.workspace.rootPath(), text, scope),
      forget: (query, scope) => this.memory.forget(this.workspace.rootPath(), query, scope),
    };
    if (this.mcp && external.length > 0) toolContext.mcp = this.mcp;
    if (hasSkills) toolContext.skills = skills;
    // Веб-поиск читает настройки на каждый прогон: человек может включить его
    // посреди работы, и следующее действие должно это увидеть. Ключ тоже берём
    // в момент вызова: он мог появиться уже после старта приложения.
    if (this.canUseWebSearch(webSearch)) {
      toolContext.webSearch = {
        search: (query, limit, callSignal) =>
          searchWeb(
            query,
            { provider: webSearch.provider, endpoint: webSearch.endpoint, apiKey: this.settings.resolveWebSearchKey() },
            limit,
            callSignal,
          ).then((hits) => ({ hits, providerLabel: webSearchProviderLabel(webSearch.provider) })),
      };
    }
    // Браузер читает настройку на каждый прогон, как и веб-поиск: человек может
    // включить его посреди работы, и следующее действие это должно увидеть.
    if (this.browser && settings.ai.browser.enabled) toolContext.browser = this.browser;
    // Песочница: команды и тесты идут в контейнер. Подключена она или нет, решает
    // настройка: агент этот режим не переключает и не может «выйти» из него.
    if (sandboxSettings.enabled && this.sandbox) toolContext.sandbox = this.sandbox;
    if (this.spillDir) toolContext.spillDir = this.spillDir;
    if (host) {
      toolContext.applyEdits = (edits, auto) => host.applyEdits(edits, auto);
      toolContext.applyPatches = (patches, auto) => host.applyPatches(patches, auto);
      toolContext.confirmCommand = (command) => host.confirmCommand(command);
      toolContext.confirmGit = (action) => host.confirmGit(action);
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
    const temperature = capabilities.temperature ? (request.temperature ?? settings.ai.temperature) : undefined;
    const maxTokens = request.maxTokens ?? settings.ai.maxTokens;
    const reasoningEffort = reasoningEffortFor(request.model, request.reasoningEffort ?? settings.ai.reasoningEffort);

    // Предохранитель от переполнения окна посреди цикла: renderer проверил
    // контекст перед отправкой, но шаги агента копят историю уже здесь, и
    // сжатие, которое живёт в renderer, до этого места не достаёт.
    const windowTokens = contextWindow(request.model, settings.ai.contextWindow);
    const toolsTokens = tools ? estimateTokens(JSON.stringify(tools).length) : 0;

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
    let runSteps = 0;
    let runToolCalls = 0;
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

    // Дедупликация вызовов в рамках одной ветки: одинаковый read-only вызов
    // не исполняется дважды, а если шаг целиком состоит из повторов — цикл
    // останавливается. Правка/команда сбрасывает кэш: состояние могло измениться.
    const executed = new Map<string, ToolOutcome>();
    let stallSteps = 0;

    // Подзадача (`task`): отдельный агент со своим контекстом. Его расход и шаги
    // прибавляем к прогону — иначе наблюдаемость показала бы только шаги основного
    // агента, а токены подзадачи выпали бы из итога беседы.
    toolContext.subagent = {
      run: async ({ description, prompt }) => {
        const sub = await this.runSubAgent({
          description,
          prompt,
          providerId: request.providerId,
          provider,
          model: request.model,
          temperature,
          maxTokens,
          reasoningEffort,
          signal,
          host,
          context,
          windowTokens,
          // Подзадача видит тот же контекст (с каталогом навыков) и может читать тело.
          skills,
        });
        runUsage = addUsage(runUsage, sub.usage);
        runSteps += sub.steps;
        runToolCalls += sub.toolCalls;
        return sub.outcome;
      },
    };
    // Прочитанные диапазоны по файлам: повтор уже прочитанного места не исполняем.
    const coveredReads = new Map<string, Array<{ from: number; to: number }>>();

    for (let step = 0; step < steps; step += 1) {
      if (signal.aborted) break;

      // Каждый шаг сверяемся с окном: результаты инструментов копятся, и
      // длинный прогон легко переполняет контекст. Режем старые ходы целиком,
      // не трогая ни рамку запроса, ни пару «вызов → результат». Промах оценки
      // ловит сам `streamStep` — по настоящему отказу провайдера.
      const done = await this.streamStep(provider, {
        model: request.model,
        messages,
        tools,
        temperature,
        maxTokens,
        reasoningEffort,
        signal,
        windowTokens,
        toolsTokens,
        calibrationKey: `${request.providerId}::${request.model}`,
        onDelta: (delta) => {
          text += delta;
          emit(ChatStreamEvent.Delta, { text: delta });
        },
        onReasoning: (delta) => {
          reasoning += delta;
          emit(ChatStreamEvent.Reasoning, { text: delta });
        },
      });

      runSteps += 1;
      if (done.usage) {
        usage = done.usage;
        runUsage = addUsage(runUsage, done.usage);
      }
      if (done.finishReason) finishReason = done.finishReason;

      const calls = done.toolCalls ?? [];
      runToolCalls += calls.length;
      if (calls.length === 0) {
        produced.push({ role: 'assistant', content: done.text });
        return {
          text,
          finishReason,
          usage,
          trace: trace(),
          agentMessages: produced,
          ...(reasoning ? { reasoning } : {}),
        };
      }

      // Модель попросила инструменты: сохраняем её ход, исполняем по очереди
      // и возвращаем результаты — иначе протокол вызова считается нарушенным.
      const assistant: ChatMessage = { role: 'assistant', content: done.text, toolCalls: calls };
      messages.push(assistant);
      produced.push(assistant);

      let didNewWork = false;
      for (const call of calls) {
        // План — не вызов инструмента в привычном смысле, а обновление чек-листа:
        // рисуем его отдельным событием, но модели всё равно отвечаем role:'tool'.
        if (call.name === 'update_plan') {
          const steps = parsePlanSteps(call.arguments);
          if (steps.length > 0) emit(ChatStreamEvent.Plan, { steps });
          const toolMessage: ChatMessage = {
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: steps.length > 0 ? `План обновлён: шагов — ${steps.length}` : 'План не изменён',
          };
          messages.push(toolMessage);
          produced.push(toolMessage);
          didNewWork = true;
          continue;
        }

        // Режим плана: исполняем только чтение. Если модель всё же позовёт
        // изменяющий инструмент — он не выполнится, отвечаем ей отказом.
        if (planMode && !PLAN_MODE_TOOLS.has(call.name)) {
          emit(ChatStreamEvent.ToolStart, { id: call.id, name: call.name, args: call.arguments });
          const refused: ChatMessage = {
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: `Режим плана: инструмент «${call.name}» недоступен. Ничего не меняй — составь план доступными средствами чтения.`,
          };
          messages.push(refused);
          produced.push(refused);
          emit(ChatStreamEvent.ToolResult, {
            id: call.id,
            name: call.name,
            ok: false,
            summary: 'режим плана: изменение недоступно',
          });
          continue;
        }

        // Права перечитываем перед каждым действием: человек мог сменить их
        // выбором в композере, пока агент отвечал. В «Плане» менять нечего.
        const liveFlags = permissionFlags(planMode ? 'ask' : this.livePermission);
        toolContext.autoApprove = liveFlags.autoApprove;
        toolContext.allowAll = liveFlags.allowAll;

        const key = `${call.name}:${call.arguments}`;
        const repeated = READ_ONLY_TOOLS.has(call.name) ? executed.get(key) : undefined;
        // Повтор чтения уже прочитанного диапазона: текст есть выше, не дублируем.
        const covered = repeated ? undefined : coveredRequest(call.name, call.arguments, coveredReads);

        emit(ChatStreamEvent.ToolStart, { id: call.id, name: call.name, args: call.arguments });
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
          outcome = await runTool(toolContext, call.name, call.arguments);
          if (outcome.read) rememberRead(coveredReads, outcome.read);
          if (READ_ONLY_TOOLS.has(call.name)) executed.set(key, outcome);
          else {
            executed.clear(); // правка/команда изменили состояние — прежние чтения устарели
            coveredReads.clear();
          }
          didNewWork = true;
        }
        emit(ChatStreamEvent.ToolResult, {
          id: call.id,
          name: call.name,
          ok: outcome.ok,
          summary: outcome.summary,
          detail: outcome.detail,
          changes: outcome.changes,
          ms: Date.now() - startedAt,
        });

        const result = outcome.ok ? (outcome.detail ?? outcome.summary) : `Ошибка: ${outcome.summary}`;
        const toolMessage: ChatMessage = {
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          // Единая точка сжатия для всех инструментов: в контекст модели уходит
          // текст без оформления, а человек в карточке (событие выше) видит полный.
          content: compressOutput ? compressToolOutput(result) : result,
        };
        messages.push(toolMessage);
        produced.push(toolMessage);
      }

      // Целый шаг из повторов — модель ходит по кругу. После двух таких шагов
      // останавливаемся: дальше это только сожжёт токены без прогресса.
      stallSteps = didNewWork ? 0 : stallSteps + 1;
      if (stallSteps >= 2) {
        const note = '\n\n[агент остановлен: повторяющиеся вызовы не дают нового результата]';
        text += note;
        emit(ChatStreamEvent.Delta, { text: note });
        produced.push({ role: 'assistant', content: note.trim() });
        return {
          text,
          finishReason,
          usage,
          trace: trace(),
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
        agentMessages: produced,
        ...(reasoning ? { reasoning } : {}),
      };
    }

    const note = '\n\n[агент остановлен: достигнут лимит шагов]';
    text += note;
    emit(ChatStreamEvent.Delta, { text: note });
    produced.push({ role: 'assistant', content: note.trim() });
    return { text, finishReason, usage, trace: trace(), agentMessages: produced, ...(reasoning ? { reasoning } : {}) };
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

    const budget = (factor: number, keepRecent: number): { messages: ChatMessage[]; dropped: number } =>
      trimMessagesToFit(params.messages, {
        limitTokens: Math.floor(windowTokens * factor),
        overheadTokens: params.toolsTokens,
        reserveTokens: params.maxTokens,
        keepRecent,
        marker: TRIM_MARKER,
      });

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
            tools: params.tools,
          },
          { onDelta: params.onDelta, onReasoning: params.onReasoning },
          params.signal,
        );
        // Факт против оценки: провайдер сам сказал, сколько входных токенов взял.
        // Сравниваем с оценкой того же запроса и запоминаем поправку на будущее —
        // следующим шагам она уже не даст промахнуться мимо окна.
        if (done.usage?.promptTokens !== undefined) {
          const estimated = estimateMessagesTokens(wire.messages) + params.toolsTokens;
          this.calibration.observe(params.calibrationKey, estimated, done.usage.promptTokens);
          this.saveCalibration();
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
   * Подзадача: тот же агентный цикл, но в своём контексте. Основной агент её
   * шагов не видит — до него доезжает только отчёт, поэтому длинное чтение не
   * раздувает беседу. Инструменты только для чтения (`SUBAGENT_TOOLS`): правки и
   * команды остаются за основным агентом, который показывает ревью и спрашивает
   * пользователя. Расход и число шагов возвращаем наверх — основной прогон
   * прибавляет их к своим, иначе токены подзадачи выпали бы из итога беседы.
   */
  private async runSubAgent(params: {
    description: string;
    prompt: string;
    providerId: string;
    provider: AiProvider;
    model: string;
    temperature: number | undefined;
    maxTokens: number;
    reasoningEffort: ReasoningEffort | undefined;
    signal: AbortSignal;
    host: ChatHostBridge | undefined;
    context: string | null;
    windowTokens: number;
    /** Навыки прогона: каталог подзадача видит, тело читает инструментом. */
    skills?: SkillTools;
  }): Promise<{ outcome: ToolOutcome; steps: number; toolCalls: number; usage: ChatUsage }> {
    const settings = this.settings.get();
    const compressOutput = settings.ai.compressOutput !== false;

    // Свой контекст: инструкция подзадачи и карта проекта (с памятью), но без
    // истории беседы. Задание — одно сообщение.
    const messages: ChatMessage[] = [{ role: 'system', content: SUBAGENT_PROMPT }];
    if (params.context) messages.push({ role: 'system', content: params.context });
    messages.push({ role: 'user', content: `Подзадача «${params.description}»:\n\n${params.prompt}` });

    const available = AGENT_TOOLS.filter(
      (tool) => SUBAGENT_TOOLS.has(tool.name) && this.canRun(tool, params.host, params.skills !== undefined),
    );
    const tools = available.length > 0 ? toOpenAiTools(available) : undefined;
    const toolsTokens = tools ? estimateTokens(JSON.stringify(tools).length) : 0;

    // Контекст исполнения подзадачи: те же сервисы, что у основного агента, но
    // без правок, подтверждений и памяти — подзадача ничего не меняет.
    const subContext: ToolContext = {
      workspace: this.workspace,
      signal: params.signal,
      autoApprove: false,
      allowAll: false,
      confirmDangerous: true,
    };
    if (this.git) subContext.git = this.git;
    if (this.symbols) subContext.symbols = this.symbols;
    if (this.linter) subContext.linter = this.linter;
    if (params.skills) subContext.skills = params.skills;
    const host = params.host;
    if (host) subContext.diagnostics = (path) => host.getDiagnostics(path);
    const webSearch = settings.ai.webSearch;
    if (this.canUseWebSearch(webSearch)) {
      subContext.webSearch = {
        search: (query, limit, callSignal) =>
          searchWeb(
            query,
            { provider: webSearch.provider, endpoint: webSearch.endpoint, apiKey: this.settings.resolveWebSearchKey() },
            limit,
            callSignal,
          ).then((hits) => ({ hits, providerLabel: webSearchProviderLabel(webSearch.provider) })),
      };
    }

    let steps = 0;
    let toolCalls = 0;
    let usage: ChatUsage = {};
    let report = '';
    // Тот же предохранитель от зацикливания, что у основного цикла: повторы
    // чтения не исполняем, а шаг целиком из повторов — повод остановиться.
    const executed = new Map<string, ToolOutcome>();
    let stall = 0;

    try {
      for (let step = 0; step < SUBAGENT_MAX_STEPS; step += 1) {
        if (params.signal.aborted) break;

        const done = await this.streamStep(params.provider, {
          model: params.model,
          messages,
          tools,
          temperature: params.temperature,
          maxTokens: params.maxTokens,
          reasoningEffort: params.reasoningEffort,
          signal: params.signal,
          windowTokens: params.windowTokens,
          toolsTokens,
          calibrationKey: `${params.providerId}::${params.model}`,
          onDelta: () => {},
          onReasoning: () => {},
        });
        steps += 1;
        if (done.usage) usage = addUsage(usage, done.usage);
        report = done.text;

        const calls = done.toolCalls ?? [];
        if (calls.length === 0) break;
        toolCalls += calls.length;
        messages.push({ role: 'assistant', content: done.text, toolCalls: calls });

        let didNewWork = false;
        for (const call of calls) {
          const key = `${call.name}:${call.arguments}`;
          let content: string;
          if (executed.has(key)) {
            // Результат уже есть выше — не повторяем дорогое чтение.
            content = `Повтор вызова «${call.name}» пропущен: такой вызов уже был, его результат выше.`;
          } else {
            const outcome = await runTool(subContext, call.name, call.arguments);
            executed.set(key, outcome);
            didNewWork = true;
            const result = outcome.ok ? (outcome.detail ?? outcome.summary) : `Ошибка: ${outcome.summary}`;
            content = compressOutput ? compressToolOutput(result) : result;
          }
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
        }

        stall = didNewWork ? 0 : stall + 1;
        if (stall >= 2) break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        outcome: {
          ok: false,
          summary: `подзадача «${params.description}» не удалась`,
          detail: `Сбой подзадачи: ${message}. Сделай сам или переформулируй задание.`,
        },
        steps,
        toolCalls,
        usage,
      };
    }

    const text = report.trim();
    if (!text) {
      return {
        outcome: {
          ok: false,
          summary: `подзадача «${params.description}»: пустой отчёт`,
          detail: 'Подзадача не вернула текст. Сделай сам или переформулируй задание.',
        },
        steps,
        toolCalls,
        usage,
      };
    }

    const clipped =
      text.length > SUBAGENT_REPORT_CHARS
        ? `${text.slice(0, SUBAGENT_REPORT_CHARS)}\n… (отчёт подзадачи обрезан)`
        : text;
    return {
      outcome: { ok: true, summary: `подзадача «${params.description}»: готово`, detail: clipped },
      steps,
      toolCalls,
      usage,
    };
  }

  /**
   * Сохранить поправки оценки на диск. Поправка — необязательное удобство:
   * сбой записи не должен ломать чат, поэтому ошибки глушим.
   */
  private saveCalibration(): void {
    try {
      const file = calibrationPath(this.settings.file());
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.calibration.snapshot()), 'utf8');
      renameSync(temporary, file);
    } catch {
      // Калибровка — удобство, а не данные: терять из-за неё ответ нельзя.
    }
  }

  /**
   * Может ли эта сборка исполнить инструмент. Файловые операции и git живут в
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
   * Готов ли веб-поиск к работе: включён и обеспечен ключом, если тот нужен.
   * Brave без ключа — это инструмент, который заведомо ответит ошибкой, поэтому
   * модели он не предлагается.
   */
  private canUseWebSearch(search: AiWebSearchSettings): boolean {
    if (!search.enabled) return false;
    return !webSearchNeedsKey(search.provider) || Boolean(this.settings.resolveWebSearchKey());
  }

  private canRun(tool: AgentToolSpec, host: ChatHostBridge | undefined, hasSkills = false): boolean {
    if (tool.name === 'apply_edit') return host?.applyEdits !== undefined;
    if (tool.name === 'apply_patch') return host?.applyPatches !== undefined;
    if (tool.name === 'run_terminal') return host?.confirmCommand !== undefined;
    if (tool.name === 'get_diagnostics') return host?.getDiagnostics !== undefined;
    // Вопрос человеку живёт в ленте чата: без окна задать его негде.
    if (tool.name === 'ask') return host?.ask !== undefined;
    if (tool.name === 'open_file') return host?.openFile !== undefined;
    if (
      tool.name === 'git_status' ||
      tool.name === 'git_diff' ||
      tool.name === 'git_log' ||
      tool.name === 'git_blame'
    ) {
      return this.git !== undefined;
    }
    // Записи в репозиторий спрашивают подтверждение: без моста подтверждений их не предлагаем.
    if (tool.name.startsWith('git_')) return this.git !== undefined && host?.confirmGit !== undefined;
    if (tool.name.startsWith('terminal_')) return this.terminals !== undefined;
    // Оба инструмента символов живут на языковом сервере: без него их не предлагаем.
    if (
      tool.name === 'codebase_search' ||
      tool.name === 'file_outline' ||
      tool.name === 'find_references' ||
      tool.name === 'go_to_definition'
    ) {
      return this.symbols !== undefined;
    }
    // Переименование меняет код через сервер — нужен и сервер, и применение правок.
    if (tool.name === 'rename_symbol') return this.symbols !== undefined && host?.applyEdits !== undefined;
    if (tool.name === 'run_linter') return this.linter !== undefined;
    // Тесты выполняют код проекта: нужен и резолвер команды, и подтверждение.
    if (tool.name === 'run_tests') return this.tests !== undefined && host?.confirmCommand !== undefined;
    // Память проекта живёт в main и доступна всегда — подтверждений не требует:
    // заметка обратима (её снимает `forget`).
    if (tool.name === 'remember' || tool.name === 'forget') return true;
    // Навыки — файлы проекта: инструмент предлагаем только когда есть что читать.
    if (tool.name === 'read_skill') return hasSkills;
    if (tool.name === 'web_search') return this.canUseWebSearch(this.settings.get().ai.webSearch);
    // Браузер: включается настройкой (как веб-поиск), а действия на странице
    // спрашивают подтверждение — значит, без подключённого окна их не предлагаем.
    if (tool.name.startsWith('browser_')) {
      if (!this.browser || !this.settings.get().ai.browser.enabled) return false;
      if (tool.name === 'browser_snapshot' || tool.name === 'browser_close') return true;
      // Масштаб страницу не меняет и отменяется одной кнопкой — спрашивать нечего.
      // Зато он есть только у встроенного браузера: без него инструмент не предлагаем.
      if (tool.name === 'browser_zoom') return this.browser.zoom !== undefined;
      return host?.confirmBrowser !== undefined;
    }
    return tool.side === 'main';
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
      return new AnthropicProvider({ id: provider.id, label: provider.label, baseUrl: provider.baseUrl, apiKey });
    }

    return new OpenAiCompatibleProvider({
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      apiKey,
    });
  }

  /**
   * Карта проекта для промпта: устройство проекта по именам файлов. Пустая
   * папка, ошибка обхода — карта не добавляется, но правила проекта всё равно
   * читаются: без карты агент просто спросит её инструментом.
   */
  private async projectMapLine(root: string): Promise<string | null> {
    if (this.mapCache?.root === root) return this.mapCache.text;
    try {
      const text = formatShortMap(await scanProject(root));
      this.mapCache = { root, text };
      return text;
    } catch {
      return null;
    }
  }

  private async buildWorkspaceContext(withMap: boolean, skills?: SkillLibrary): Promise<string | null> {
    const root = this.workspace.rootPath();
    if (!root) return null;

    const parts = [`Рабочая папка проекта: ${root}`];
    if (withMap) {
      const map = await this.projectMapLine(root);
      if (map) parts.push(map);
    }
    // Память — рядом с картой: заметки агента переживают беседу и её сжатие, поэтому
    // их видно в начале каждого ответа. Областей две: заметки проекта и общие — идут
    // отдельными блоками, чтобы агент не принял глобальную заметку за проектную.
    const memory = formatMemory(await this.memory.list(root, 'workspace'), 'workspace');
    if (memory) parts.push(memory);
    const globalMemory = formatMemory(await this.memory.list(root, 'global'), 'global');
    if (globalMemory) parts.push(globalMemory);
    let spent = 0;
    for (const name of INSTRUCTION_FILES) {
      if (spent >= MAX_INSTRUCTIONS_TOTAL_BYTES) break;
      try {
        const text = await fs.readFile(path.join(root, name), 'utf8');
        if (!text.trim()) continue;

        // Правила сверх общего потолка не добавляем: лучше показать часть, чем
        // вытеснить беседу. Обрезка видна по пометке — модель должна знать,
        // что прочитала не всё.
        const room = Math.min(MAX_INSTRUCTIONS_BYTES, MAX_INSTRUCTIONS_TOTAL_BYTES - spent);
        const trimmed = text.slice(0, room);
        const cut = trimmed.length < text.length ? '\n… (правила обрезаны по размеру)' : '';
        parts.push(`Инструкции из ${name}:\n${trimmed}${cut}`);
        spent += trimmed.length;
      } catch {
        // файла нет — это нормально
      }
    }
    // Навыки — после правил: правила действуют всегда, а навык подгружается по
    // надобности. Здесь только каталог: тело агент просит инструментом read_skill.
    // Без инструментов каталог не нужен: прочитать навык будет нечем.
    const catalog = formatSkillCatalog(withMap && skills ? await skills.list() : []);
    if (catalog) parts.push(catalog);
    return parts.join('\n\n');
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
 * Разбор аргументов `update_plan`. Модель — недоверенный источник, поэтому
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

/** Ошибку подключения объясняем словами: пользователь не должен читать стек. */
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

/** Файл с поправками оценки токенов — рядом с settings.json. */
function calibrationPath(settingsFile: string): string {
  return path.join(path.dirname(settingsFile), 'token-calibration.json');
}

/** Прочитать сохранённые поправки; нет файла или мусор — начинаем с чистого листа. */
function readCalibration(settingsFile: string): unknown {
  try {
    return JSON.parse(readFileSync(calibrationPath(settingsFile), 'utf8'));
  } catch {
    return undefined;
  }
}
