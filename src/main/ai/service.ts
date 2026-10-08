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
} from '../../shared/api';
import type { FileEdit } from '../../shared/edits';
import { modelCapabilities, reasoningEffortFor } from '../../shared/providers';
import { AGENT_TOOLS, toOpenAiTools, type AgentToolSpec } from '../../shared/tools';
import { RpcFailure } from '../ipc/router';
import type { SettingsStore } from '../settings';
import type { WorkspaceService } from '../workspace/workspace';
import { runTool, type ToolContext } from './agent-tools';
import { assertChatImages } from './images';
import { OpenAiCompatibleProvider } from './openai-compatible';
import type { AiProvider } from './provider';

/** Файлы с инструкциями проекта — подмешиваются в системный промпт. */
const INSTRUCTION_FILES = ['AGENTS.md', 'CHUI.md', 'CLAUDE.md'];
const MAX_INSTRUCTIONS_BYTES = 8000;

/** Страховка от бесконечного цикла «модель → инструмент → модель». */
const MAX_AGENT_STEPS = 8;
/** В автопилоте задача длиннее: шагов нужно больше. */
const MAX_AUTOPILOT_STEPS = 24;

/** Дописывается в системный промпт, когда агентный режим включён. */
const AGENT_PROMPT = [
  'У тебя есть инструменты: list_dir, read_file, search, get_diagnostics — изучать проект; apply_edit — предлагать правки; run_terminal — выполнять команды.',
  'Пути передавай абсолютные; позиции в apply_edit — 1-based, как в LSP.',
  'В каждой правке передавай oldText — точный текст, который она заменяет: инструмент сверяет его с файлом.',
  'Не выдумывай содержимое файлов: то, чего не знаешь, читай инструментами.',
  'Перед тем как чинить код, посмотри get_diagnostics — так видно настоящую ошибку, а не догадку.',
  'Если apply_edit ответил «не совпало с текстом документа» — перечитай файл и повтори правку, а не меняй формулировку наугад.',
  'Правки и команды пользователь подтверждает — не считай их сделанными, пока не получил ответ инструмента.',
].join('\n');

/** Дописывается к промпту в автопилоте: агент работает сам, до результата. */
const AUTOPILOT_PROMPT = [
  'Режим автопилота: правки применяются сразу, рядовые команды выполняются без подтверждения.',
  'Работай до результата: прочитай нужное, сделай правки, проверь себя и только потом отвечай.',
  'Необратимые команды всё равно уйдят на подтверждение — не рассчитывай на них.',
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
}

/** Может ли эта сборка исполнить инструмент. */
function canRun(tool: AgentToolSpec, host: ChatHostBridge | undefined): boolean {
  if (tool.name === 'apply_edit') return host?.applyEdits !== undefined;
  if (tool.name === 'run_terminal') return host?.confirmCommand !== undefined;
  if (tool.name === 'get_diagnostics') return host?.getDiagnostics !== undefined;
  return tool.side === 'main';
}

/**
 * AI-слой. Умеет стримить ответ модели в renderer и — если включён
 * `useTools` — крутить агентный цикл: модель просит вызвать инструмент,
 * тот исполняется (read-only в main, правки — в renderer) и результат
 * возвращается в диалог, пока модель не ответит текстом.
 */
export class AiService {
  constructor(
    private readonly settings: SettingsStore,
    private readonly workspace: WorkspaceService,
  ) {}

  async models(providerId: string, signal?: AbortSignal): Promise<string[]> {
    return this.createProvider(providerId).listModels(signal);
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

    const provider = new OpenAiCompatibleProvider({ id: 'test', label: 'Проверка', baseUrl, apiKey });
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
    const autoApprove = request.autoApprove ?? false;

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
    if (useTools) messages.push({ role: 'system', content: autoApprove ? `${AGENT_PROMPT}\n${AUTOPILOT_PROMPT}` : AGENT_PROMPT });

    messages.push(...request.messages);

    // Сами картинки идут частями ПОСЛЕДНЕГО сообщения пользователя: отдельным
    // system-сообщением их не примет почти ни один провайдер — изображение
    // допустимо только в сообщении пользователя.
    if (images.length > 0) attachImages(messages, images.map((item) => item.dataUrl!));

    // Предлагаем модели только то, что реально может исполнить эта сборка.
    const available = useTools ? AGENT_TOOLS.filter((tool) => canRun(tool, host)) : [];
    const tools = available.length > 0 ? toOpenAiTools(available) : undefined;
    const toolContext: ToolContext = { workspace: this.workspace, signal, autoApprove };
    if (host) {
      toolContext.applyEdits = (edits, auto) => host.applyEdits(edits, auto);
      toolContext.confirmCommand = (command) => host.confirmCommand(command);
      toolContext.diagnostics = (path) => host.getDiagnostics(path);
    }

    const steps = autoApprove ? MAX_AUTOPILOT_STEPS : MAX_AGENT_STEPS;

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

      for (const call of calls) {
        emit(ChatStreamEvent.ToolStart, { id: call.id, name: call.name, args: call.arguments });
        const outcome = await runTool(toolContext, call.name, call.arguments);
        emit(ChatStreamEvent.ToolResult, {
          id: call.id,
          name: call.name,
          ok: outcome.ok,
          summary: outcome.summary,
          detail: outcome.detail,
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
