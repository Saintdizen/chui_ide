import type {
  ChatConversation,
  ChatGoal,
  ChatHistory,
  ChatMessage,
  ChatRole,
  ChatRunTrace,
  ChatToolCall,
  ChatUsage,
} from './api';
import { sanitizeGoal } from './goal';
import { sanitizeToolPreset } from './tool-presets';

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

    // Сжатый контекст: та же проверка, что и у переписки, но своей пачкой.
    // Нет его или он пуст — значит беседа не сжималась, и модель получит `messages`.
    if (Array.isArray(value.context)) {
      const context = sanitizeMessages(value.context);
      if (context.length > 0) conversation.context = context;
    }

    const usage = sanitizeUsage(value.usage);
    if (usage) conversation.usage = usage;
    const trace = sanitizeTrace(value.trace);
    if (trace) conversation.trace = trace;
    // Цель — часть беседы: без неё незакрытая работа после перезапуска теряла бы
    // своё условие окончания. Текст проверяем общим правилом (`shared/goal.ts`),
    // а флаг читаем строго: строка «да» — это не «закрыто».
    const goal = sanitizeGoalFromFile(value.goal);
    if (goal) conversation.goal = goal;
    // Набор инструментов беседы. Правило общее с настройками (`sanitizeToolPreset`):
    // незнакомое значение — не мусор в файле, а повод взять общий набор.
    if (typeof value.toolPreset === 'string') conversation.toolPreset = sanitizeToolPreset(value.toolPreset);

    used += conversationSize(messages);
    result.push(conversation);
  }

  return result;
}

/** Цель из файла беседы: нужен непустой текст, флаг — только настоящий boolean. */
function sanitizeGoalFromFile(raw: unknown): ChatGoal | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as { text?: unknown; done?: unknown };
  const text = sanitizeGoal(value.text);
  if (!text) return undefined;
  return { text, done: value.done === true };
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
  }

  // Потолок держит СВЕЖИЕ сообщения, а не первые: беседа — это контекст для
  // следующего вопроса, и начало ей нужно меньше, чем последний ход. Режем по
  // индексу, а обрубок пары вызов-ответ после этого убирает `repairToolPairs`:
  // провайдер отвергает такую пару ошибкой HTTP 400.
  return repairToolPairs(messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages);
}

/**
 * Чем заканчивается вызов, ответ на который до истории не дошёл. Так бывает,
 * когда приложение закрыли посреди прогона: вызов модели уже записан, а
 * результата инструмента ещё нет.
 */
export const MISSING_TOOL_RESULT = 'Ошибка: ответ инструмента не получен — прогон прерван.';

/**
 * Привести историю к протоколу вызова инструментов.
 *
 * Провайдер требует строгой пары: сообщение ассистента с `toolCalls` обязано
 * получить ответ на КАЖДЫЙ вызов, а `role: 'tool'` без такого вызова — уже
 * нарушение. Иначе на любой запрос приходит HTTP 400 вида «An assistant message
 * with 'tool_calls' must be followed by tool messages», и беседа перестаёт
 * работать навсегда: сломанная пара лежит в файле и восстанавливается при
 * каждом перезапуске.
 *
 * Поэтому чиним в обе стороны: недостающий ответ дописываем заглушкой (модель
 * видит, что вызов был и чем кончился), а осиротевший ответ выбрасываем —
 * восстановить по нему вызов невозможно.
 */
export function repairToolPairs(messages: readonly ChatMessage[]): ChatMessage[] {
  const repaired: ChatMessage[] = [];
  /** Вызовы, которые ещё ждут ответа: id → имя. `null` — ждать нечего. */
  let waiting: Map<string, string> | null = null;

  /** Закрыть ожидание: на неответившие вызовы дописываем заглушки. */
  const flush = (): void => {
    if (!waiting) return;
    for (const [id, name] of waiting) {
      repaired.push({ role: 'tool', toolCallId: id, name, content: MISSING_TOOL_RESULT });
    }
    waiting = null;
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      // Ответ на вызов, которого не было перед ним, протокол ломает: убрать его —
      // единственный выход, вызов из него не восстановить.
      if (!waiting || !message.toolCallId || !waiting.has(message.toolCallId)) continue;
      waiting.delete(message.toolCallId);
      repaired.push(message);
      continue;
    }

    flush();
    if (message.role !== 'assistant' || !message.toolCalls?.length) {
      repaired.push(message);
      continue;
    }

    // Вызов без id или с повтором id тоже не пройдёт: id — единственное, чем
    // ответ связывается с вызовом. Такой вызов убираем, его ответ отбросит
    // проверка выше — как осиротевший.
    const calls: ChatToolCall[] = [];
    const ids = new Set<string>();
    for (const call of message.toolCalls) {
      if (!call.id || ids.has(call.id)) continue;
      ids.add(call.id);
      calls.push(call);
    }
    if (calls.length === 0) {
      // Вызовов не осталось — сообщение остаётся обычной репликой, если в нём
      // есть текст; пустую реплику модели в историю не тащим.
      if (message.content.trim()) repaired.push({ role: 'assistant', content: message.content });
      continue;
    }
    repaired.push({ ...message, toolCalls: calls });
    waiting = new Map(calls.map((call) => [call.id, call.name]));
  }

  flush();
  return repaired;
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

/** Расход из файла: числа только там, где они числа; иначе поля просто нет. */
function sanitizeUsage(raw: unknown): ChatUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as {
    promptTokens?: unknown;
    completionTokens?: unknown;
    cachedTokens?: unknown;
    cacheCreationTokens?: unknown;
  };
  const clean: ChatUsage = {};
  if (typeof value.promptTokens === 'number') clean.promptTokens = value.promptTokens;
  if (typeof value.completionTokens === 'number') clean.completionTokens = value.completionTokens;
  if (typeof value.cachedTokens === 'number') clean.cachedTokens = value.cachedTokens;
  if (typeof value.cacheCreationTokens === 'number') clean.cacheCreationTokens = value.cacheCreationTokens;
  return clean.promptTokens !== undefined ||
    clean.completionTokens !== undefined ||
    clean.cachedTokens !== undefined ||
    clean.cacheCreationTokens !== undefined
    ? clean
    : undefined;
}

/** След беседы из файла: без валидного расхода он бессмысленен, поэтому тогда его нет. */
function sanitizeTrace(raw: unknown): ChatRunTrace | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as { steps?: unknown; toolCalls?: unknown; usage?: unknown };
  const usage = sanitizeUsage(value.usage);
  if (!usage) return undefined;
  return {
    steps: typeof value.steps === 'number' && Number.isFinite(value.steps) ? Math.max(0, Math.floor(value.steps)) : 0,
    toolCalls:
      typeof value.toolCalls === 'number' && Number.isFinite(value.toolCalls)
        ? Math.max(0, Math.floor(value.toolCalls))
        : 0,
    usage,
  };
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
