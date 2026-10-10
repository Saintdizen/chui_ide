import { app } from 'electron';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatConversation, ChatHistory, ChatMessage, ChatRole, ChatToolCall, ChatUsage } from '../../shared/api';

/**
 * Хранилище бесед: по одному JSON-файлу на рабочую папку.
 *
 * Renderer остаётся источником истины (он собирает ленту и историю), а main
 * только пишет и читает. Файлы лежат рядом с настройками и намеренно отдельно
 * от `settings.json`: беседа растёт в размерах и незачем держать её в одном
 * файле с ключами и параметрами редактора.
 */

/** Беседа — это контекст, а не архив: старые диалоги интересны редко. */
const MAX_CONVERSATIONS = 40;
/** Предохранитель от вырожденной истории: файл должен читаться мгновенно. */
const MAX_MESSAGES = 400;
const MAX_CONTENT_CHARS = 200_000;
const MAX_TITLE_CHARS = 120;
const MAX_TOOL_CALLS = 64;

const ROLES: readonly ChatRole[] = ['system', 'user', 'assistant', 'tool'];

export class ChatStore {
  private readonly dir?: string;

  /** Каталог можно задать явно (проверки), иначе — userData/chats. */
  constructor(dir?: string) {
    this.dir = dir;
  }

  load(root: string): ChatHistory {
    if (!root) return { conversations: [] };
    try {
      const raw: unknown = JSON.parse(readFileSync(this.fileFor(root), 'utf8'));
      return sanitizeHistory(raw);
    } catch {
      // Файла нет или он повреждён — начинаем с чистой истории, а не с ошибки:
      // потеря беседы неприятна, но отказ панели хуже.
      return { conversations: [] };
    }
  }

  save(root: string, history: ChatHistory): void {
    if (!root) return;

    const conversations = sanitizeConversations(history.conversations ?? []);
    const payload: ChatHistory = {
      conversations,
      ...(typeof history.activeUid === 'string' && history.activeUid ? { activeUid: history.activeUid } : {}),
    };

    const file = this.fileFor(root);
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(payload)}\n`, 'utf8');
    renameSync(temporary, file);
  }

  /**
   * Имя файла повторяет имя проекта (чтобы каталог читался глазами) плюс
   * короткий хеш пути: две одинаково названные папки не затирают друг друга.
   */
  private fileFor(root: string): string {
    const resolved = path.resolve(root);
    const hash = createHash('sha1').update(resolved).digest('hex').slice(0, 12);
    const safe =
      path
        .basename(resolved)
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 40) || 'workspace';
    const dir = this.dir ?? path.join(app.getPath('userData'), 'chats');
    return path.join(dir, `${safe}-${hash}.json`);
  }
}

/* ── проверка прочитанного ──────────────────────────────────────────────────
 * Файл мог быть правлен руками или достаться от другой версии приложения,
 * поэтому доверять ему нельзя: каждое поле проверяется и подрезается.
 */

function sanitizeHistory(raw: unknown): ChatHistory {
  if (typeof raw !== 'object' || raw === null) return { conversations: [] };
  const value = raw as { conversations?: unknown; activeUid?: unknown };
  const history: ChatHistory = { conversations: sanitizeConversations(value.conversations) };
  if (typeof value.activeUid === 'string' && value.activeUid) history.activeUid = value.activeUid;
  return history;
}

function sanitizeConversations(raw: unknown): ChatConversation[] {
  if (!Array.isArray(raw)) return [];
  const result: ChatConversation[] = [];

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
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

    result.push(conversation);
    if (result.length >= MAX_CONVERSATIONS) break;
  }

  return result;
}

function sanitizeMessages(raw: unknown): ChatMessage[] {
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

function sanitizeToolCalls(raw: unknown): ChatToolCall[] {
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

function clampString(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback;
  return value.length > max ? value.slice(0, max) : value;
}
