import { RpcErrorCode, type ChatMessage, type ChatStreamDone, type ChatToolCall } from '../../shared/api';
import { RpcFailure } from '../ipc/router';
import { fetchWithRetry } from '../../shared/retry';
import { describeHttpError, safeText } from './openai-compatible';
import type { AiProvider, StreamChatHandlers, StreamChatParams } from './provider';

export interface AnthropicOptions {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
}

/* ── типы Messages API (только нужное нам) ──────────────────────────────── */

/** Точка кеша промпта: провайдер переиспользует префикс до неё. */
type CacheControl = { cache_control?: { type: 'ephemeral' } };

type ContentBlock =
  | ({ type: 'text'; text: string } & CacheControl)
  | ({ type: 'image'; source: { type: 'base64'; media_type: string; data: string } } & CacheControl)
  | ({ type: 'tool_use'; id: string; name: string; input: unknown } & CacheControl)
  | ({ type: 'tool_result'; tool_use_id: string; content: string } & CacheControl);

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[] | string;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

/** Бюджет размышлений для расширенного мышления Anthropic по «усилию». */
const THINKING_BUDGET = { low: 1024, medium: 4096, high: 8192 } as const;

/**
 * Провайдер нативного Anthropic Messages API.
 *
 * Отдельный класс, а не «OpenAI-совместимый»: у Anthropic другой провод
 * (`/v1/messages`, блоки content, системный промпт отдельным полем, tool_result
 * только в user-ходе) и другие заголовки (`x-api-key`).
 */
export class AnthropicProvider implements AiProvider {
  constructor(private readonly options: AnthropicOptions) {}

  get id(): string {
    return this.options.id;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await fetchWithRetry(`${this.url()}/v1/models`, { headers: this.headers() }, signal);
    if (!response.ok) {
      const detail = await safeText(response);
      throw new RpcFailure(
        RpcErrorCode.Internal,
        `Не удалось получить список моделей (HTTP ${response.status})`,
        detail,
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
    const { system, messages } = toAnthropicMessages(params.messages);

    const effort = params.reasoningEffort && params.reasoningEffort !== 'off' ? params.reasoningEffort : undefined;
    const budget = effort ? THINKING_BUDGET[effort] : 0;
    // У Anthropic max_tokens обязателен, а при включённом мышлении ещё и больше бюджета.
    const maxTokens = Math.max(params.maxTokens ?? 4096, budget + 1024);

    // Кеш промпта: в агентском режиме на каждом шаге уходит один и тот же префикс
    // (инструменты + system + история). Помечаем точки кеширования — провайдер
    // переиспользует оплаченный префикс и берёт за него около 10% цены. Включаем
    // только когда есть инструменты: там многошаговость и экономия окупает запись кеша.
    const useCache = (params.tools?.length ?? 0) > 0;

    const buildBody = (withCache: boolean): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model: params.model,
        max_tokens: maxTokens,
        messages: withCache ? withCacheBreakpoints(messages) : messages,
        stream: true,
      };
      // system — блоком: cache_control на нём кеширует инструменты вместе с system.
      if (system) {
        body.system = withCache ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system;
      }
      if (params.tools?.length) body.tools = toAnthropicTools(params.tools);
      // Температуру не отправляем при включённом мышлении: Anthropic требует ровно 1.
      if (params.temperature !== undefined && !effort) body.temperature = params.temperature;
      if (effort) body.thinking = { type: 'enabled', budget_tokens: budget };
      return body;
    };

    const post = (withCache: boolean): Promise<Response> =>
      fetchWithRetry(
        `${this.url()}/v1/messages`,
        { method: 'POST', headers: this.headers(), body: JSON.stringify(buildBody(withCache)) },
        signal,
      );

    let response = await post(useCache);
    if (!response.ok && useCache && (response.status === 400 || response.status === 422)) {
      const detail = await safeText(response);
      // Прокси и шлюзы могут не знать cache_control: повторяем без него.
      if (/cache_control|cache control|unexpected|extra field|additional propert|unknown field/i.test(detail ?? '')) {
        response = await post(false);
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
    if (!response.body) throw new RpcFailure(RpcErrorCode.Internal, 'Провайдер не вернул поток данных');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let thoughts = '';
    let finishReason: string | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let cachedTokens: number | undefined;
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
        if (!line.startsWith('data:')) continue; // `event:` нам не нужен: тип лежит в самом JSON

        const data = line.slice(5).trim();
        if (data.length === 0) continue;

        let chunk: AnthropicStreamEvent;
        try {
          chunk = JSON.parse(data) as AnthropicStreamEvent;
        } catch {
          continue;
        }

        if (chunk.type === 'message_start' && chunk.message?.usage) {
          promptTokens = chunk.message.usage.input_tokens;
          completionTokens = chunk.message.usage.output_tokens ?? completionTokens;
          const fromCache = chunk.message.usage.cache_read_input_tokens ?? 0;
          if (fromCache > 0) cachedTokens = fromCache;
          continue;
        }

        if (chunk.type === 'content_block_start') {
          const block = chunk.content_block;
          const index = chunk.index ?? 0;
          if (block?.type === 'tool_use') {
            toolSlots.set(index, { id: block.id ?? '', name: block.name ?? '', args: '' });
          }
          continue;
        }

        if (chunk.type === 'content_block_delta') {
          const delta = chunk.delta;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            text += delta.text;
            handlers.onDelta(delta.text);
          } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            thoughts += delta.thinking;
            handlers.onReasoning?.(delta.thinking);
          } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const slot = toolSlots.get(chunk.index ?? 0);
            if (slot) slot.args += delta.partial_json;
          }
          continue;
        }

        if (chunk.type === 'message_delta') {
          if (chunk.delta?.stop_reason) finishReason = mapStopReason(chunk.delta.stop_reason);
          if (chunk.usage?.output_tokens !== undefined) completionTokens = chunk.usage.output_tokens;
        }
        // message_stop / ping / content_block_stop игнорируем
      }
    }

    const toolCalls: ChatToolCall[] = [...toolSlots.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, slot]) => slot.name.length > 0)
      .map(([index, slot]) => ({ id: slot.id || `call_${index}`, name: slot.name, arguments: slot.args || '{}' }));

    return {
      text,
      finishReason,
      usage: { promptTokens, completionTokens, ...(cachedTokens !== undefined ? { cachedTokens } : {}) },
      ...(thoughts ? { reasoning: thoughts } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }

  private url(): string {
    return this.options.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (this.options.apiKey) headers['x-api-key'] = this.options.apiKey;
    return headers;
  }
}

/* ── разбор потока ──────────────────────────────────────────────────────── */

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
}

/**
 * Точка кеша в конце беседы: следующий шаг переиспользует префикс до неё.
 * Копируем последнее сообщение с блоками, чтобы не портить исходный массив.
 */
function withCacheBreakpoints(messages: AnthropicMessage[]): AnthropicMessage[] {
  const out = [...messages];
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const message = out[index]!;
    const blocks = message.content;
    if (!Array.isArray(blocks) || blocks.length === 0) continue;
    const last = blocks[blocks.length - 1]!;
    out[index] = { ...message, content: [...blocks.slice(0, -1), { ...last, cache_control: { type: 'ephemeral' } }] };
    break;
  }
  return out;
}

/** `max_tokens` у Anthropic — это наш `length`: ответ оборван по лимиту. */
function mapStopReason(reason: string): string {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  return reason;
}

/* ── сборка запроса ─────────────────────────────────────────────────────── */

/**
 * Наши сообщения → формат Anthropic. Две особенности протокола:
 * системные сообщения уезжают одним верхним полем `system`, а результаты
 * инструментов (role='tool') должны лежать в user-ходе блоками `tool_result`.
 * Поэтому подряд идущие tool-сообщения склеиваются в одно user-сообщение.
 */
export function toAnthropicMessages(messages: readonly ChatMessage[]): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  let pendingResults: ContentBlock[] = [];

  const flushResults = (): void => {
    if (pendingResults.length === 0) return;
    out.push({ role: 'user', content: pendingResults });
    pendingResults = [];
  };

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content.trim()) systemParts.push(message.content);
      continue;
    }

    if (message.role === 'tool') {
      pendingResults.push({ type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: message.content });
      continue;
    }

    flushResults();

    if (message.role === 'user') {
      out.push({ role: 'user', content: userContent(message) });
      continue;
    }

    const blocks: ContentBlock[] = [];
    if (message.content.trim()) blocks.push({ type: 'text', text: message.content });
    for (const call of message.toolCalls ?? []) {
      blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: parseInput(call.arguments) });
    }
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
    out.push({ role: 'assistant', content: blocks });
  }

  flushResults();
  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, messages: out };
}

function userContent(message: ChatMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (message.content.trim()) blocks.push({ type: 'text', text: message.content });
  for (const image of message.images ?? []) {
    const parsed = parseDataUrl(image);
    if (parsed)
      blocks.push({ type: 'image', source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data } });
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  return blocks;
}

/** data-URL → тип и base64-данные; неподходящий формат пропускаем. */
function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(url);
  return match ? { mediaType: match[1]!, data: match[2]! } : null;
}

/** Аргументы инструмента у нас — JSON-строка; Anthropic ждёт объект. */
function parseInput(raw: string): unknown {
  try {
    return raw.trim() ? (JSON.parse(raw) as unknown) : {};
  } catch {
    return {};
  }
}

/** Описания инструментов приходят в OpenAI-формате (см. toOpenAiTools). */
function toAnthropicTools(tools: readonly unknown[]): AnthropicTool[] {
  const out: AnthropicTool[] = [];
  for (const tool of tools) {
    const fn = (tool as { function?: { name?: string; description?: string; parameters?: unknown } }).function;
    if (!fn?.name) continue;
    out.push({
      name: fn.name,
      description: fn.description,
      input_schema: fn.parameters ?? { type: 'object', properties: {} },
    });
  }
  return out;
}
