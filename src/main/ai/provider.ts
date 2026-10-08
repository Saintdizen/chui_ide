import type { ChatMessage, ChatStreamDone } from '../../shared/api';

export interface StreamChatParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Задел под этап 3: описания инструментов в формате провайдера. */
  tools?: readonly unknown[];
}

export interface StreamChatHandlers {
  onDelta(text: string): void;
}

/**
 * Минимальный интерфейс провайдера. Любая модель, говорящая на
 * OpenAI-совместимом протоколе (OpenAI, Anthropic через прокси, Groq,
 * Ollama, llama.cpp, LM Studio), реализуется этим же интерфейсом.
 */
export interface AiProvider {
  readonly id: string;
  readonly baseUrl: string;
  listModels(signal?: AbortSignal): Promise<string[]>;
  streamChat(
    params: StreamChatParams,
    handlers: StreamChatHandlers,
    signal: AbortSignal,
  ): Promise<ChatStreamDone>;
}
