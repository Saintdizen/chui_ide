import type { ChatConversation, ChatHistory, ChatMessage, ChatRole, ChatToolCall, ChatUsage } from './api';

/**
 * Проверка прочитанной истории бесед.
 *
 * Файл истории мог быть правлен руками или достаться от другой версии
 * приложения, поэтому доверять ему нельзя: каждое поле проверяется и подрезается.
 * Логика чистая, поэтому живёт в `shared` и проверяется тестами (см.
 * `tests/chat-sanitize.test.ts`), а не в main рядом с файловой системой.
 */

/** Беседа — это контекст, а не архив: старые диалоги интересны редко. */
export const MAX_CONVERSATIONS = 40;
/** Предохранитель от вырожденной истории: файл должен читаться мгновенно. */
export const MAX_MESSAGES = 200;
/**
 * Потолок на одно сообщение. Результаты инструментов приходят в историю уже
 * сжатыми и усечёнными (см. `MAX_OUTPUT_CHARS` в `agent-tools.ts`), поэтому
 * 100 КБ хватает с запасом; без потолка одно сообщение могло раздуть файл
 * на сотни килобайт.
 */
export const MAX_CONTENT_CHARS = 100_000;
export const MAX_TITLE_CHARS = 120;
export const MAX_TOOL_CALLS = 64;
/**
 * Потолок на весь файл истории одной папки — суммарная длина содержимого бесед.
 * Даже при максимумах по беседе и сообщению файл остаётся мегабайтами, а не
 * гигабайтами: беседы за пределом не сохраняем, начиная со старых.
 */
export const MAX_TOTAL_CHARS = 24_000_000;

const ROLES: readonly ChatRole[] = ['system', 'user', 'assistant', 'tool'];

export function sanitizeHistory(raw: unknown): ChatHistory {
  if (typeof raw !== 'object' || raw === null) return { conversations: [] };
  const value = raw as { conversations?: unknown; activeUid?: unknown };
  const history: ChatHistory = { conversations: sanitizeConversations(value.conversations) };
  if (typeof value.activeUid === 'string' && value.activeUid) history.activeUid = value.activeUid;
  return history;
}

export function sanitizeConversations(raw: unknown): ChatConversation[] {
  if (!Array.isArray(raw)) return [];
  const result: ChatConversation[] = [];
  /** Сколько символов содержимого уже приняли: потолок на весь файл истории. */
  let used = 0;

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    // Беседы за пределом не сохраняем: файл — это контекст, а не архив.
    if (result.length >= MAX_CONVERSATIONS || used >= MAX_TOTAL_CHARS) break;
    const value = item as Record<string, unknown>;
    const uid = typeof value.uid === 'string' && value.uid ? value.uid : `chat_${result.length}`;
    const messages = sanitizeMessages(value.messages);
    const conversation: ChatConversation = {
      uid,
      title: clampString(value.title, 'Новая беседа', MAX_TITLE_CHARS),
      updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
      messages,
    };

    const usage = value.usage as { promptTokens?: unknown; completionTokens?: unknown } | undefined;
    if (usage && typeof usage === 'object') {
      const clean: ChatUsage = {};
      if (typeof usage.promptTokens === 'number') clean.promptTokens = usage.promptTokens;
      if (typeof usage.completionTokens === 'number') clean.completionTokens = usage.completionTokens;
      if (clean.promptTokens !== undefined || clean.completionTokens !== undefined) conversation.usage = clean;
    }

    used += conversationSize(messages);
    result.push(conversation);
  }

  return result;
}

export function sanitizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const messages: ChatMessage[] = [];

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const value = item as Record<string, unknown>;
    const role = value.role;
    if (typeof role !== 'string' || !ROLES.includes(role as ChatRole)) continue;

    const message: ChatMessage = {
      role: role as ChatRole,
      content: clampString(value.content, '', MAX_CONTENT_CHARS),
    };
    if (typeof value.name === 'string') message.name = value.name;
    if (typeof value.toolCallId === 'string') message.toolCallId = value.toolCallId;
    if (value.rating === 'up' || value.rating === 'down') message.rating = value.rating;

    const toolCalls = sanitizeToolCalls(value.toolCalls);
    if (toolCalls.length > 0) message.toolCalls = toolCalls;

    messages.push(message);
    if (messages.length >= MAX_MESSAGES) break;
  }

  return messages;
}

export function sanitizeToolCalls(raw: unknown): ChatToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ChatToolCall[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const value = item as Record<string, unknown>;
    if (typeof value.name !== 'string' || typeof value.arguments !== 'string') continue;
    calls.push({
      id: typeof value.id === 'string' && value.id ? value.id : `call_${calls.length}`,
      name: value.name,
      arguments: value.arguments,
    });
    if (calls.length >= MAX_TOOL_CALLS) break;
  }
  return calls;
}

/** Сколько символов содержимого несёт беседа: по этому считаем потолок файла. */
function conversationSize(messages: ChatMessage[]): number {
  let size = 0;
  for (const message of messages) {
    size += message.content.length;
    for (const call of message.toolCalls ?? []) size += call.arguments.length;
  }
  return size;
}

export function clampString(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback;
  return value.length > max ? value.slice(0, max) : value;
}
