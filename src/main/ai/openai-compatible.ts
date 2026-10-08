import { RpcErrorCode, type ChatMessage, type ChatStreamDone } from '../../shared/api';
import { RpcFailure } from '../ipc/router';
import type { AiProvider, StreamChatHandlers, StreamChatParams } from './provider';

export interface OpenAiCompatibleOptions {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string | null };
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
    let finishReason: string | undefined;
    let usage: ChatStreamDone['usage'];

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
        const delta = choice?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          text += delta;
          handlers.onDelta(delta);
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

    return { text, finishReason, usage };
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

function toWireMessage(message: ChatMessage): { role: string; content: string } {
  return { role: message.role, content: message.content };
}

async function safeText(response: Response): Promise<string | undefined> {
  try {
    return (await response.text()).slice(0, 2000);
  } catch {
    return undefined;
  }
}
