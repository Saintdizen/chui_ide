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
  type ChatStreamDone,
  type ChatUsage,
  type DiagnosticsHostResult,
  type PlanStep,
  type PlanStepStatus,
  type ReasoningEffort,
} from '../../shared/api';
import type { FileEdit } from '../../shared/edits';
import { compressToolOutput } from '../../shared/output-compress';
import { formatShortMap } from '../../shared/project-map';
import { modelCapabilities, contextWindow, findProviderPreset, reasoningEffortFor } from '../../shared/providers';
import {
  AGENT_TOOLS,
  parseToolArguments,
  toOpenAiTools,
  type AgentToolSpec,
  type ExposedToolSpec,
} from '../../shared/tools';
import {
  condenseCallArguments,
  estimateMessagesTokens,
  estimateTokens,
  isContextOverflow,
  TokenCalibration,
  trimMessagesToFit,
} from '../../shared/context-fit';
import { RpcFailure } from '../ipc/router';
import { scanProject } from '../project/scan';
import type { SettingsStore } from '../settings';
import type { WorkspaceService } from '../workspace/workspace';
import type { McpToolInfo } from '../../shared/mcp';
import {
  runTool,
  type GitTools,
  type McpRunner,
  type SymbolSearch,
  type TerminalAgent,
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

/** Пометка на свёрнутом результате инструмента; её наличие — признак уже свёрнутого. */
const AGED_MARK = ' (детали свёрнуты — перечитай инструмент, если нужно)';

/** Порог сворачивания. Отключён: сворачивание теряло прочитанные файлы, агент перечитывал их заново. */
const AGED_MIN_CHARS = Number.POSITIVE_INFINITY; // CHUI: содержимое результатов не сворачиваем (агент терял прочитанное)

/** Покрыт ли запрошенный диапазон одним из уже прочитанных. */
function isCovered(ranges: ReadonlyArray<{ from: number; to: number }>, from: number, to: number): boolean {
  return ranges.some((range) => range.from <= from && range.to >= to);
}

/**
 * Запрос read_file, целиком лежащий в уже прочитанном диапазоне: такой повтор не
 * исполняем — текст уже есть выше в ветке. Ловим только запросы с явным endLine:
 * без него верхняя граница (конец файла) нам неизвестна.
 */
function coveredRequest(
  name: string,
  rawArguments: string,
  reads: ReadonlyMap<string, Array<{ from: number; to: number }>>,
): { path: string; from: number; to: number } | undefined {
  if (name !== 'read_file') return undefined;
  const parsed = parseToolArguments(rawArguments);
  if (!parsed.ok) return undefined;
  // force: явный запрос перечитать — контент мог выпасть из контекста.
  if (parsed.value.force === true) return undefined;
  const target = parsed.value.path;
  const endLine = parsed.value.endLine;
  if (typeof target !== 'string' || typeof endLine !== 'number' || !Number.isInteger(endLine)) return undefined;
  const startLine = parsed.value.startLine;
  const from = typeof startLine === 'number' && Number.isInteger(startLine) ? Math.max(1, startLine) : 1;
  const to = Math.max(from, endLine);
  const ranges = reads.get(target);
  if (!ranges || !isCovered(ranges, from, to)) return undefined;
  return { path: target, from, to };
}

/** Запомнить прочитанный диапазон файла. */
function rememberRead(
  reads: Map<string, Array<{ from: number; to: number }>>,
  read: { path: string; from: number; to: number },
): void {
  const ranges = reads.get(read.path) ?? [];
  ranges.push({ from: read.from, to: read.to });
  reads.set(read.path, ranges);
}

/**
 * Заметка на месте обрезанной истории. Агент должен знать, что начало беседы
 * убрано, иначе будет ссылаться на то, чего в запросе уже нет.
 */
const TRIM_MARKER =
  'Часть ранней истории беседы опущена: она не помещалась в окно модели. Если нужны детали — перечитай их инструментами.';

// Лимиты шагов «модель → инструмент → модель» живут в настройках
// (`ai.maxSteps` и `ai.maxAutopilotSteps`): значения по умолчанию — там же.

/**
 * Инструменты, которые только читают состояние. Их повтор без нового
 * результата — признак зацикливания, и повторный вызов можно не исполнять.
 * Правки и команды сюда не входят: они меняют мир, и повторить их бывает нужно.
 */
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
  'project_map',
  'web_search',
  'find_files',
  'get_diagnostics',
  'git_status',
  'git_log',
  'git_diff',
  'open_file',
  'update_plan',
]);

const READ_ONLY_TOOLS = new Set([
  'list_dir',
  'read_file',
  'read_files',
  'search',
  'project_map',
  'find_files',
  'get_diagnostics',
  'git_status',
  'git_log',
]);

/** Дописывается в системный промпт, когда агентный режим включён. */
const AGENT_PROMPT = [
  'Работай с проектом инструментами, а не по догадке: назначение и аргументы у каждого инструмента описаны отдельно — читай их.',
  'Устройство проекта видно по карте в начале беседы: не обходи дерево и не читай манифесты, чтобы понять, что это за проект. Подробнее — project_map.',
  'Не выдумывай содержимое файлов: то, чего не знаешь, читай инструментами.',
  'Прежде чем читать файл целиком, найди место: codebase_search — где объявлен символ, search — где встречается, find_files — какие файлы есть.',
  'Большие файлы читай диапазоном строк и не перечитывай одно и то же много раз.',
  'Задачу из нескольких шагов начинай с update_plan и обновляй план по ходу.',
  'Перед тем как чинить код, посмотри get_diagnostics — так видно настоящую ошибку, а не догадку.',
  'Если apply_edit ответил «не совпало с текстом документа» — перечитай файл и повтори правку, а не меняй формулировку наугад.',
  'Правки и команды пользователь подтверждает — не считай их сделанными, пока не получил ответ инструмента.',
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
 * Возможности, которые живут только в renderer: документная модель (ревью правок)
 * и интерфейс подтверждений. Нет моста — соответствующие инструменты вообще не
 * предлагаются модели: меньше инструментов лучше, чем заведомо битый.
 */
export interface ChatHostBridge {
  applyEdits(edits: FileEdit[], autoApprove: boolean): Promise<ApplyEditsHostResult>;
  /** Спросить у пользователя разрешение на запуск команды. */
  confirmCommand(command: string): Promise<boolean>;
  /** Пометки языка: они живут в Monaco, то есть в renderer. */
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
  /** Внешние инструменты (MCP): нет сервиса — внешних инструментов не предлагаем. */
  private mcp?: McpRunner;
  /**
   * Права доступа текущего прогона (кнопка в композере). Храним на сервисе, а не
   * снимком в запросе: renderer может переключить их прямо во время ответа агента.
   * Сервис один на окно, а активный агентский прогон в окне один — этого хватает.
   */
  private liveAutoApprove = false;

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

  constructor(
    private readonly settings: SettingsStore,
    private readonly workspace: WorkspaceService,
  ) {
    // Поправки оценки токенов переживают перезапуск: без них первые шаги снова
    // промахиваются мимо окна, пока калибровка не наберёт замеры заново.
    this.calibration.load(readCalibration(this.settings.file()));
  }

  /** Подключить git рабочей папки: включает инструменты git_status и git_diff. */
  attachGit(git: GitTools): void {
    this.git = git;
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
   * Подключить внешние инструменты (MCP): их список сервис берёт у серверов из
   * настроек. Без подключения агент работает только своими инструментами.
   */
  attachMcp(mcp: McpRunner): void {
    this.mcp = mcp;
  }

  /**
   * Обновить права доступа агента. Вызывается кнопкой в композере — в том числе
   * пока агент работает: следующее действие возьмёт уже новое значение.
   */
  setAutoApprove(value: boolean): void {
    this.liveAutoApprove = value;
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

  async chat(
    request: ChatRequest,
    emit: (event: string, payload: unknown) => void,
    signal: AbortSignal,
    host?: ChatHostBridge,
  ): Promise<ChatStreamDone> {
    const settings = this.settings.get();
    const webSearch = settings.ai.webSearch;
    const provider = this.createProvider(request.providerId);
    const useTools = request.useTools ?? false;
    const planMode = request.planMode ?? false;
    // В режиме плана менять ничего нельзя, поэтому полный доступ выключаем.
    const autoApprove = !planMode && (request.autoApprove ?? false);
    // Текущие права запоминаем на сервисе: дальше их можно менять на лету.
    this.liveAutoApprove = autoApprove;

    const messages: ChatMessage[] = [];
    const systemPrompt = request.systemPrompt ?? settings.ai.systemPrompt;
    if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt });

    // Карта проекта нужна там, где агент работает с проектом; в «Вопросе»
    // инструментов нет, и обход дерева за наши деньги был бы лишним.
    const context = await this.buildWorkspaceContext(useTools || planMode);
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
    if (planMode) messages.push({ role: 'system', content: `${AGENT_PROMPT}\n${PLAN_PROMPT}` });
    else if (useTools)
      messages.push({
        role: 'system',
        content: autoApprove ? `${AGENT_PROMPT}\n${AUTO_APPROVE_PROMPT}` : AGENT_PROMPT,
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
    const available = useTools
      ? AGENT_TOOLS.filter((tool) => this.canRun(tool, host) && (!planMode || PLAN_MODE_TOOLS.has(tool.name)))
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
      autoApprove,
      allowAll: autoApprove,
      confirmDangerous: settings.ai.confirmDangerous === true,
    };
    // Сжатие вывода — только для контекста модели: человек в карточке инструмента
    // видит текст как он есть (см. `compressToolOutput`).
    const compressOutput = settings.ai.compressOutput !== false;
    if (this.git) toolContext.git = this.git;
    if (this.terminals) toolContext.terminals = this.terminals;
    if (this.symbols) toolContext.symbols = this.symbols;
    if (this.mcp && external.length > 0) toolContext.mcp = this.mcp;
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
    if (host) {
      toolContext.applyEdits = (edits, auto) => host.applyEdits(edits, auto);
      toolContext.confirmCommand = (command) => host.confirmCommand(command);
      toolContext.diagnostics = (path) => host.getDiagnostics(path);
      toolContext.openFile = (path, line, column) => host.openFile(path, line, column);
    }

    // Лимит шагов задаётся в настройках: человек может поднять его под длинную задачу.
    const steps = autoApprove ? settings.ai.maxAutopilotSteps : settings.ai.maxSteps;

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

    // Вся ветка, порождённая этим вызовом. Renderer дописывает её в историю —
    // поэтому в следующем вопросе модель помнит, что успела прочитать.
    const produced: ChatMessage[] = [];
    let text = '';
    let reasoning = '';
    let usage: ChatUsage | undefined;
    let finishReason: string | undefined;

    // Дедупликация вызовов в рамках одной ветки: одинаковый read-only вызов
    // не исполняется дважды, а если шаг целиком состоит из повторов — цикл
    // останавливается. Правка/команда сбрасывает кэш: состояние могло измениться.
    const executed = new Map<string, ToolOutcome>();
    let stallSteps = 0;
    // Сводки результатов по id: ими заменяем детали, когда результат «стареет».
    const toolSummaries = new Map<string, string>();
    // id вызовов последнего хода — их результаты модель ещё не «отработала».
    let freshToolIds = new Set<string>();
    // Прочитанные диапазоны по файлам: повтор уже прочитанного места не исполняем.
    const coveredReads = new Map<string, Array<{ from: number; to: number }>>();

    for (let step = 0; step < steps; step += 1) {
      if (signal.aborted) break;

      // Свернуть детали результатов прошлых ходов: они уже отработали, а полный
      // текст (прочитанный файл, вывод команды) снова грузит окно на каждом шаге.
      for (let i = 0; i < messages.length; i += 1) {
        const aged = messages[i]!;
        if (aged.role !== 'tool' || !aged.toolCallId) continue;
        if (freshToolIds.has(aged.toolCallId)) continue;
        const content = aged.content ?? '';
        if (content.length < AGED_MIN_CHARS || content.endsWith(AGED_MARK)) continue;
        const summary = toolSummaries.get(aged.toolCallId) ?? 'результат инструмента';
        messages[i] = { ...aged, content: summary + AGED_MARK };
      }

      // Аргументы уже применённых правок копятся ещё хуже: полный newText/oldText
      // остаётся в истории навсегда, хотя файл давно изменён. Держим путь и
      // размеры, а длинные тела правок заменяем пометкой.
      for (let i = 0; i < messages.length; i += 1) {
        const aged = messages[i]!;
        if (aged.role !== 'assistant' || !aged.toolCalls?.length) continue;
        let changed = false;
        const toolCalls = aged.toolCalls.map((call) => {
          if (freshToolIds.has(call.id)) return call;
          const condensed = condenseCallArguments(call.arguments, AGED_MIN_CHARS);
          if (condensed === call.arguments) return call;
          changed = true;
          return { ...call, arguments: condensed };
        });
        if (changed) messages[i] = { ...aged, toolCalls };
      }

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

      if (done.usage) usage = done.usage;
      if (done.finishReason) finishReason = done.finishReason;

      const calls = done.toolCalls ?? [];
      if (calls.length === 0) {
        produced.push({ role: 'assistant', content: done.text });
        return { text, finishReason, usage, agentMessages: produced, ...(reasoning ? { reasoning } : {}) };
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

        // Права перечитываем перед каждым действием: пользователь мог переключить
        // их кнопкой, пока агент отвечал. В «Плане» менять нечего — всегда выключены.
        toolContext.autoApprove = planMode ? false : this.liveAutoApprove;
        toolContext.allowAll = planMode ? false : this.liveAutoApprove;

        const key = `${call.name}:${call.arguments}`;
        const repeated = READ_ONLY_TOOLS.has(call.name) ? executed.get(key) : undefined;
        // Повтор чтения уже прочитанного диапазона: текст есть выше, не дублируем.
        const covered = repeated ? undefined : coveredRequest(call.name, call.arguments, coveredReads);

        emit(ChatStreamEvent.ToolStart, { id: call.id, name: call.name, args: call.arguments });
        let outcome: ToolOutcome;
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
          toolSummaries.set(call.id, outcome.summary);
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

      // id вызовов этого хода: их результаты считаем свежими на следующем шаге.
      freshToolIds = new Set(calls.map((call) => call.id));
      stallSteps = didNewWork ? 0 : stallSteps + 1;
      if (stallSteps >= 2) {
        const note = '\n\n[агент остановлен: повторяющиеся вызовы не дают нового результата]';
        text += note;
        emit(ChatStreamEvent.Delta, { text: note });
        produced.push({ role: 'assistant', content: note.trim() });
        return { text, finishReason, usage, agentMessages: produced, ...(reasoning ? { reasoning } : {}) };
      }
    }

    // Отмена (например, пока пользователь решал судьбу правок) — это не
    // «лимит шагов»: возвращаем то, что успели, без лишней приписки.
    if (signal.aborted) {
      produced.push({ role: 'assistant', content: text });
      return { text, finishReason, usage, agentMessages: produced, ...(reasoning ? { reasoning } : {}) };
    }

    const note = '\n\n[агент остановлен: достигнут лимит шагов]';
    text += note;
    emit(ChatStreamEvent.Delta, { text: note });
    produced.push({ role: 'assistant', content: note.trim() });
    return { text, finishReason, usage, agentMessages: produced, ...(reasoning ? { reasoning } : {}) };
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
   * Сохранить поправки оценки на диск. Поправка — необязательное удобство:
   * сбой записи не должен ломать чат, поэтому ошибки глушим.
   */
  private saveCalibration(): void {
    try {
      const file = calibrationPath(this.settings.file());
      const temporary = file + '.tmp';
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

    return tools
      .filter((tool) => tool.readOnly || host?.confirmCommand !== undefined)
      .map((tool) => ({
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

  private canRun(tool: AgentToolSpec, host: ChatHostBridge | undefined): boolean {
    if (tool.name === 'apply_edit') return host?.applyEdits !== undefined;
    if (tool.name === 'run_terminal') return host?.confirmCommand !== undefined;
    if (tool.name === 'get_diagnostics') return host?.getDiagnostics !== undefined;
    if (tool.name === 'open_file') return host?.openFile !== undefined;
    if (tool.name === 'git_status' || tool.name === 'git_diff' || tool.name === 'git_log') {
      return this.git !== undefined;
    }
    if (tool.name.startsWith('terminal_')) return this.terminals !== undefined;
    if (tool.name === 'codebase_search') return this.symbols !== undefined;
    if (tool.name === 'web_search') return this.canUseWebSearch(this.settings.get().ai.webSearch);
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

  private async buildWorkspaceContext(withMap: boolean): Promise<string | null> {
    const root = this.workspace.rootPath();
    if (!root) return null;

    const parts = [`Рабочая папка проекта: ${root}`];
    if (withMap) {
      const map = await this.projectMapLine(root);
      if (map) parts.push(map);
    }
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
