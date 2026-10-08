import { RpcErrorCode, type ChatMessage, type ChatStreamDone, type ChatToolCall } from '../../shared/api';
import { RpcFailure } from '../ipc/router';
import type { AiProvider, StreamChatHandlers, StreamChatParams } from './provider';

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
  usage?: { prompt_tokens?: number; completion_tokens?: number };
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
    const response = await fetch(this.url('/models'), { headers: this.headers(), signal });
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
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages.map((message) => toWireMessage(message)),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
    // Имя поля — из OpenAI-протокола; так же его понимают OpenRouter, Groq и шлюзы.
    if (params.reasoningEffort) body.reasoning_effort = params.reasoningEffort;
    if (params.tools?.length) body.tools = params.tools;

    const response = await fetch(this.url('/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new RpcFailure(
        RpcErrorCode.Internal,
        `Провайдер ответил ошибкой (HTTP ${response.status})`,
        await safeText(response),
      );
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
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
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

async function safeText(response: Response): Promise<string | undefined> {
  try {
    return (await response.text()).slice(0, 2000);
  } catch {
    return undefined;
  }
}
