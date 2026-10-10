import { RpcErrorCode, type ChatMessage, type ChatStreamDone, type ChatToolCall } from '../../shared/api';
import { RpcFailure } from '../ipc/router';
import type { AiProvider, StreamChatHandlers, StreamChatParams } from './provider';
import { isContextOverflow } from '../../shared/context-fit';
import { fetchWithRetry } from '../../shared/retry';

export interface OpenAiCompatibleOptions {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
}

/** Фрагмент вызова инструмента в дельте стрима. Приходит по кускам, ключ — `index`. */
interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** Размышления: у DeepSeek — `reasoning_content`, у части других — `reasoning`. */
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** OpenAI кладёт сюда попадание в кеш промпта — это оплаченные дешевле токены. */
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Провайдер поверх OpenAI-совместимого HTTP API.
 * Стриминг разбираем руками: SSE — это построчный текстовый протокол,
 * тянуть SDK ради него не нужно.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  constructor(private readonly options: OpenAiCompatibleOptions) {}

  get id(): string {
    return this.options.id;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await fetchWithRetry(this.url('/models'), { headers: this.headers() }, signal);
    if (!response.ok) {
      throw new RpcFailure(
        RpcErrorCode.Internal,
        `Не удалось получить список моделей (HTTP ${response.status})`,
        await safeText(response),
      );
    }

    const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
    return (payload.data ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string')
      .sort((a, b) => a.localeCompare(b));
  }

  async streamChat(
    params: StreamChatParams,
    handlers: StreamChatHandlers,
    signal: AbortSignal,
  ): Promise<ChatStreamDone> {
    // `stream_options` понимают не все: строгий OpenAI-совместимый сервер
    // (часть сборок llama.cpp, vLLM) отвечает ошибкой «unknown field». Поэтому
    // собираем тело сборщиком и при отказе повторяем запрос без него.
    const buildBody = (includeStreamOptions: boolean): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model: params.model,
        messages: params.messages.map((message) => toWireMessage(message)),
        stream: true,
      };
      if (includeStreamOptions) body.stream_options = { include_usage: true };
      if (params.temperature !== undefined) body.temperature = params.temperature;
      if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
      // Имя поля — из OpenAI-протокола; так же его понимают OpenRouter, Groq и шлюзы.
      if (params.reasoningEffort) body.reasoning_effort = params.reasoningEffort;
      if (params.tools?.length) body.tools = params.tools;
      // Кеш промпта: только на официальном OpenAI — сторонние совместимые серверы
      // могут отвергнуть незнакомое поле. Ключ стабилен для одного префикса, поэтому
      // повторные запросы попадают в тот же кеш и префикс считается дешевле.
      const cacheKey = promptCacheKey(this.options.baseUrl, params);
      if (cacheKey) body.prompt_cache_key = cacheKey;
      return body;
    };

    const post = (body: Record<string, unknown>): Promise<Response> =>
      fetchWithRetry(
        this.url('/chat/completions'),
        { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
        signal,
      );

    let response = await post(buildBody(true));
    if (!response.ok && (response.status === 400 || response.status === 422)) {
      const detail = await safeText(response);
      if (
        /stream_options|stream options|unknown field|unrecognized|extra field|additional propert/i.test(detail ?? '')
      ) {
        response = await post(buildBody(false));
        if (!response.ok) {
          const retryDetail = await safeText(response);
          throw new RpcFailure(RpcErrorCode.Internal, describeHttpError(response.status, retryDetail), retryDetail);
        }
      } else {
        throw new RpcFailure(RpcErrorCode.Internal, describeHttpError(response.status, detail), detail);
      }
    } else if (!response.ok) {
      const detail = await safeText(response);
      throw new RpcFailure(RpcErrorCode.Internal, describeHttpError(response.status, detail), detail);
    }
    if (!response.body) {
      throw new RpcFailure(RpcErrorCode.Internal, 'Провайдер не вернул поток данных');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let thoughts = '';
    let finishReason: string | undefined;
    let usage: ChatStreamDone['usage'];
    const toolSlots = new Map<number, { id: string; name: string; args: string }>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line.length === 0 || !line.startsWith('data:')) continue;

        const data = line.slice(5).trim();
        if (data.length === 0 || data === '[DONE]') continue;

        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(data) as ChatCompletionChunk;
        } catch {
          continue; // неполный или нестандартный чанк — пропускаем, поток продолжается
        }

        const choice = chunk.choices?.[0];

        // Размышления отдельным потоком: в ответ они не входят и в историю не пишутся.
        const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          thoughts += reasoning;
          handlers.onReasoning?.(reasoning);
        }

        const delta = choice?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          text += delta;
          handlers.onDelta(delta);
        }

        // Вызовы инструментов приходят фрагментами: id и имя — обычно целиком
        // в первом чанке, аргументы — по кускам JSON, которые надо склеить.
        for (const call of choice?.delta?.tool_calls ?? []) {
          const index = typeof call.index === 'number' ? call.index : 0;
          const slot = toolSlots.get(index) ?? { id: '', name: '', args: '' };
          if (call.id && !slot.id) slot.id = call.id;
          if (call.function?.name) slot.name += call.function.name;
          if (call.function?.arguments) slot.args += call.function.arguments;
          toolSlots.set(index, slot);
        }

        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            ...(cached !== undefined && cached > 0 ? { cachedTokens: cached } : {}),
          };
        }
      }
    }

    const toolCalls: ChatToolCall[] = [...toolSlots.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, slot]) => ({
        id: slot.id || `call_${index}`,
        name: slot.name,
        arguments: slot.args,
      }))
      .filter((call) => call.name.length > 0);

    return {
      text,
      finishReason,
      usage,
      ...(thoughts ? { reasoning: thoughts } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }

  private url(pathname: string): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}${pathname}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    return headers;
  }
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    const wire: Record<string, unknown> = { role: 'tool', content: message.content };
    if (message.toolCallId) wire.tool_call_id = message.toolCallId;
    if (message.name) wire.name = message.name;
    return wire;
  }

  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      // content обязан быть null, когда ответ целиком состоит из вызовов
      content: message.content.length > 0 ? message.content : null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }

  const wire: Record<string, unknown> = { role: message.role, content: wireContent(message) };
  if (message.name) wire.name = message.name;
  return wire;
}

/**
 * Содержимое сообщения: строка, а с картинками — части контента
 * (`text` + `image_url` с data-URL). Так картинки понимает любой
 * OpenAI-совместимый провайдер, и ничего кодировать по дороге не нужно.
 */
function wireContent(message: ChatMessage): unknown {
  if (!message.images?.length) return message.content;

  const parts: Record<string, unknown>[] = [];
  if (message.content.trim()) parts.push({ type: 'text', text: message.content });
  for (const image of message.images) parts.push({ type: 'image_url', image_url: { url: image } });
  return parts;
}

/**
 * Ключ кеша промпта для OpenAI. Поле понимает только официальный сервер, поэтому
 * шлём его лишь на `api.openai.com`: у сторонних OpenAI-совместимых серверов
 * незнакомое поле — это 400. Ключ должен быть стабилен для одного префикса
 * (модель + system + инструменты) — тогда повторы бьют в тот же кеш.
 */
function promptCacheKey(baseUrl: string, params: StreamChatParams): string | undefined {
  let host = '';
  try {
    host = new URL(baseUrl).host;
  } catch {
    return undefined;
  }
  if (host !== 'api.openai.com') return undefined;
  const system = params.messages.find((message) => message.role === 'system')?.content ?? '';
  if (!system && !params.tools?.length) return undefined;
  return hashKey(`${params.model}\n${system}\n${params.tools?.length ?? 0}`);
}

/** FNV-1a: нужен короткий стабильный ключ из префикса, не криптография. */
function hashKey(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export async function safeText(response: Response): Promise<string | undefined> {
  try {
    return (await response.text()).slice(0, 2000);
  } catch {
    return undefined;
  }
}

/** Текст ошибки по коду HTTP: переполнение контекста — самая частая причина 400. */
export function describeHttpError(status: number, detail?: string): string {
  if (isContextOverflow({ details: detail })) {
    return 'Превышен размер контекста модели — сожмите беседу или снимите вложения (HTTP 400)';
  }
  if (status === 401 || status === 403) return `Ключ отклонён провайдером (HTTP ${status})`;
  if (status === 404) return 'По этому адресу нет API — возможно, забыт суффикс /v1 (HTTP 404)';
  if (status === 429) return 'Провайдер ограничил частоту запросов (HTTP 429)';
  if (status >= 500) return `Провайдер недоступен (HTTP ${status})`;
  return `Провайдер ответил ошибкой (HTTP ${status})`;
}
