import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ChatStreamEvent,
  RpcErrorCode,
  type AiConnectionTestResult,
  type ApplyEditsHostResult,
  type ChatAttachment,
  type ChatMessage,
  type ChatRequest,
  type ChatStreamDone,
  type ChatUsage,
  type DiagnosticsHostResult,
  type PlanStep,
  type PlanStepStatus,
} from '../../shared/api';
import type { FileEdit } from '../../shared/edits';
import { modelCapabilities, findProviderPreset, reasoningEffortFor } from '../../shared/providers';
import { AGENT_TOOLS, toOpenAiTools, type AgentToolSpec } from '../../shared/tools';
import { RpcFailure } from '../ipc/router';
import type { SettingsStore } from '../settings';
import type { WorkspaceService } from '../workspace/workspace';
import { runTool, type GitTools, type TerminalAgent, type ToolContext, type ToolOutcome } from './agent-tools';
import { AnthropicProvider } from './anthropic';
import { assertChatImages } from './images';
import { OpenAiCompatibleProvider } from './openai-compatible';
import type { AiProvider } from './provider';

/** Файлы с инструкциями проекта — подмешиваются в системный промпт. */
const INSTRUCTION_FILES = ['AGENTS.md', 'CHUI.md', 'CLAUDE.md'];
const MAX_INSTRUCTIONS_BYTES = 8000;

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
  'find_files',
  'get_diagnostics',
  'git_status',
  'git_log',
]);

/** Дописывается в системный промпт, когда агентный режим включён. */
const AGENT_PROMPT = [
  'У тебя есть инструменты: list_dir, read_file, read_files, search, find_files, get_diagnostics — изучать проект; apply_edit — предлагать правки; replace_in_files — массовая замена по проекту; create_file, delete_file, move_file — создавать, удалять и перемещать файлы; run_terminal — выполнить одну команду; terminal_start, terminal_read, terminal_write, terminal_stop — долгие процессы в настоящем терминале (сервер, watch); update_plan — вести план работы; git_status, git_diff и git_log — смотреть состояние и историю git; open_file — открыть файл в редакторе на нужной строке.',
  'Пути передавай абсолютные; позиции в apply_edit — 1-based, как в LSP.',
  'В каждой правке передавай oldText — точный текст, который она заменяет: инструмент сверяет его с файлом.',
  'Большие файлы читай диапазоном: у read_file есть startLine и endLine, а строки в выводе пронумерованы — по ним готовь правки. Не читай файл целиком много раз.',
  'Не выдумывай содержимое файлов: то, чего не знаешь, читай инструментами.',
  'Задачу из нескольких шагов начинай с update_plan и обновляй план по ходу — так видно прогресс.',
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
  /**
   * Права доступа текущего прогона (кнопка в композере). Храним на сервисе, а не
   * снимком в запросе: renderer может переключить их прямо во время ответа агента.
   * Сервис один на окно, а активный агентский прогон в окне один — этого хватает.
   */
  private liveAutoApprove = false;

  constructor(
    private readonly settings: SettingsStore,
    private readonly workspace: WorkspaceService,
  ) {}

  /** Подключить git рабочей папки: включает инструменты git_status и git_diff. */
  attachGit(git: GitTools): void {
    this.git = git;
  }

  /** Подключить терминалы: включает инструменты terminal_start/read/write/stop. */
  attachTerminals(terminals: TerminalAgent): void {
    this.terminals = terminals;
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
  async testConnection(params: { baseUrl: string; apiKey?: string; providerId?: string }, signal?: AbortSignal): Promise<AiConnectionTestResult> {
    const baseUrl = params.baseUrl.trim();
    if (!baseUrl) return { ok: false, models: [], message: 'Не указан адрес сервера' };

    const apiKey = params.apiKey?.trim() || (params.providerId ? this.settings.resolveApiKey(params.providerId) : undefined);
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
        message: models.length > 0 ? `Подключение работает · доступно моделей: ${models.length}` : 'Сервер ответил, но список моделей пуст',
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

    const context = await this.buildWorkspaceContext();
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
    else if (useTools) messages.push({ role: 'system', content: autoApprove ? `${AGENT_PROMPT}\n${AUTO_APPROVE_PROMPT}` : AGENT_PROMPT });
    else messages.push({ role: 'system', content: ASK_PROMPT });

    messages.push(...request.messages);

    // Сами картинки идут частями ПОСЛЕДНЕГО сообщения пользователя: отдельным
    // system-сообщением их не примет почти ни один провайдер — изображение
    // допустимо только в сообщении пользователя.
    if (images.length > 0) attachImages(messages, images.map((item) => item.dataUrl!));

    // Предлагаем модели только то, что реально может исполнить эта сборка.
    const available = useTools
      ? AGENT_TOOLS.filter((tool) => this.canRun(tool, host) && (!planMode || PLAN_MODE_TOOLS.has(tool.name)))
      : [];
    const tools = available.length > 0 ? toOpenAiTools(available) : undefined;
    // Полный доступ: и правки, и команды без подтверждений.
    // Страховка — из настроек: по умолчанию выключена, включает пользователь.
    const toolContext: ToolContext = {
      workspace: this.workspace,
      signal,
      autoApprove,
      allowAll: autoApprove,
      confirmDangerous: settings.ai.confirmDangerous === true,
    };
    if (this.git) toolContext.git = this.git;
    if (this.terminals) toolContext.terminals = this.terminals;
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

    for (let step = 0; step < steps; step += 1) {
      if (signal.aborted) break;

      const done = await provider.streamChat(
        { model: request.model, messages, temperature, maxTokens, reasoningEffort, tools },
        {
          onDelta: (delta) => {
            text += delta;
            emit(ChatStreamEvent.Delta, { text: delta });
          },
          onReasoning: (delta) => {
            reasoning += delta;
            emit(ChatStreamEvent.Reasoning, { text: delta });
          },
        },
        signal,
      );

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
          emit(ChatStreamEvent.ToolResult, { id: call.id, name: call.name, ok: false, summary: 'режим плана: изменение недоступно' });
          continue;
        }

        // Права перечитываем перед каждым действием: пользователь мог переключить
        // их кнопкой, пока агент отвечал. В «Плане» менять нечего — всегда выключены.
        toolContext.autoApprove = planMode ? false : this.liveAutoApprove;
        toolContext.allowAll = planMode ? false : this.liveAutoApprove;

        const key = `${call.name}:${call.arguments}`;
        const repeated = READ_ONLY_TOOLS.has(call.name) ? executed.get(key) : undefined;

        emit(ChatStreamEvent.ToolStart, { id: call.id, name: call.name, args: call.arguments });
        let outcome: ToolOutcome;
        if (repeated) {
          outcome = {
            ok: false,
            summary: `повтор вызова «${call.name}» — пропущен`,
            detail:
              'Точно такой вызов уже был в этой ветке. Повтор не нужен: используй уже полученный результат или смени подход.',
          };
        } else {
          outcome = await runTool(toolContext, call.name, call.arguments);
          if (READ_ONLY_TOOLS.has(call.name)) executed.set(key, outcome);
          else executed.clear(); // правка/команда изменили состояние — прежние чтения устарели
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

        const toolMessage: ChatMessage = {
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: outcome.ok ? (outcome.detail ?? outcome.summary) : `Ошибка: ${outcome.summary}`,
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
   * Может ли эта сборка исполнить инструмент. Файловые операции и git живут в
   * main; правки, диагностика и открытие вкладки — в renderer, поэтому зависят
   * от того, подключён ли мост. Лишний инструмент хуже отсутствующего: модель
   * потратит шаг на вызов, который заведомо не сработает.
   */
  private canRun(tool: AgentToolSpec, host: ChatHostBridge | undefined): boolean {
    if (tool.name === 'apply_edit') return host?.applyEdits !== undefined;
    if (tool.name === 'run_terminal') return host?.confirmCommand !== undefined;
    if (tool.name === 'get_diagnostics') return host?.getDiagnostics !== undefined;
    if (tool.name === 'open_file') return host?.openFile !== undefined;
    if (tool.name === 'git_status' || tool.name === 'git_diff' || tool.name === 'git_log') {
      return this.git !== undefined;
    }
    if (tool.name.startsWith('terminal_')) return this.terminals !== undefined;
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

  private async buildWorkspaceContext(): Promise<string | null> {
    const root = this.workspace.rootPath();
    if (!root) return null;

    const parts = [`Рабочая папка проекта: ${root}`];
    for (const name of INSTRUCTION_FILES) {
      try {
        const text = await fs.readFile(path.join(root, name), 'utf8');
        if (text.trim()) {
          parts.push(`Инструкции из ${name}:\n${text.slice(0, MAX_INSTRUCTIONS_BYTES)}`);
          break;
        }
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
