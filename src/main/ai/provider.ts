import type { ChatMessage, ChatStreamDone, ReasoningEffort } from '../../shared/api';
import type { AccountBalance } from '../../shared/balance';
import type { ModelInfo } from '../../shared/model-info';

export interface StreamChatParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /**
   * Строки-обрывы: модель замолкает, как только допишет до любой из них.
   * Для коротких ответов это дешевле, чем ждать `maxTokens`: лишние токены
   * (перевод строки, «Надеюсь, это помогло») не генерируются вовсе.
   */
  stop?: readonly string[];
  /** Усилие размышления; не выставляется для моделей, которые его не понимают. */
  reasoningEffort?: ReasoningEffort;
  /**
   * Выключить размышление явно. `false` — только для моделей, которые думают по
   * умолчанию и умеют это отключать (`ModelCapabilities.thinkingToggle`).
   */
  thinking?: boolean;
  /**
   * Метка конечного пользователя (`user_id`). Провайдер считает по ней кеш
   * контекста и лимиты, поэтому у разных людей за одним окном она разная.
   */
  userId?: string;
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
  /**
   * Паспорт моделей: окно, предел ответа, модальности. Сервер, который его
   * отдаёт, знает о своих моделях больше, чем любая таблица в коде. Метод
   * необязателен: без него остаются догадки по имени (`shared/providers.ts`).
   */
  listModelInfos?(signal?: AbortSignal): Promise<ModelInfo[]>;
  /**
   * Состояние счёта (`GET /user/balance`). Есть не у каждого провайдера: у
   * локальных серверов денег нет вовсе, поэтому метод необязателен.
   */
  getBalance?(signal?: AbortSignal): Promise<AccountBalance>;
  streamChat(params: StreamChatParams, handlers: StreamChatHandlers, signal: AbortSignal): Promise<ChatStreamDone>;
}
