import type { ChatMessage, ChatStreamDone, ReasoningEffort } from '../../shared/api';

export interface StreamChatParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Усилие размышления; не выставляется для моделей, которые его не понимают. */
  reasoningEffort?: ReasoningEffort;
  /** Описания инструментов в формате провайдера (см. `toOpenAiTools`). */
  tools?: readonly unknown[];
}

export interface StreamChatHandlers {
  onDelta(text: string): void;
  /** Размышления модели (`reasoning_content` у DeepSeek и подобных). */
  onReasoning?(text: string): void;
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
