/**
 * Индекс прошлых бесед — копия для поиска, а не хозяин разговоров.
 *
 * Правда о беседе лежит в её файле (см. `main/ai/chat-store.ts`). Индекс можно
 * потерять: он пересоберётся, а разговоры останутся. Поэтому в записи индекса
 * лежит отпечаток беседы (`fingerprint`): разошёлся с файлом — запись пересобирается.
 *
 * Зачем индекс, если беседа читается из того же файла: файл растёт (переписка,
 * сжатие, следы прогонов), а поиску нужны три вещи — текст реплик, их роль и
 * место относительно контекста модели. Последнее и есть новое: реплика живёт
 * в контексте (`context`), вытеснена из него сжатием (`evicted`) или осталась
 * только в журнале прогонов (`journal`).
 */

import type { ChatConversation, ChatMessage } from './api';
import { clampRunText, formatClock, formatDuration, formatThousands, plural } from './run-log';
import type { RunTelemetryRecord } from './telemetry';
import { finishedLabel } from './telemetry';
import type { SessionSearchSource, SessionZone } from './session-search';

/**
 * Версия раскладки индекса. Файл другой версии не читаем, а пересобираем:
 * старый индекс — не повод переписывать формат на ходу.
 */
export const SESSION_INDEX_VERSION = 1;

/** Потолок текста одной реплики в индексе: поиск всё равно отдаёт фрагмент. */
export const MAX_INDEX_TEXT = 4000;

/** Потолок реплик одной беседы в индексе: дальше индекс дороже файла. */
export const MAX_INDEX_MESSAGES = 2000;

/** Сколько прогонов одной беседы показывает `search: trace`. */
export const MAX_TRACE_RUNS = 5;

/** Одна реплика в индексе. Больше полей поиску не нужно. */
export interface IndexedMessage {
  role: ChatMessage['role'];
  text: string;
  zone: SessionZone;
}

/** Беседа в индексе: то, по чему ищут, плюс отпечаток файла-хозяина. */
export interface SessionIndexEntry {
  uid: string;
  title: string;
  updatedAt: number;
  /** Отпечаток беседы из файла: по нему видно, что индекс отстал. */
  fingerprint: string;
  messages: IndexedMessage[];
}

/** Файл индекса: версия, время сборки и записи бесед. */
export interface SessionIndexFile {
  version: number;
  builtAt: number;
  entries: SessionIndexEntry[];
}

/** Пробелы и регистр — единственное, чем различаются «те же» реплики. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Отпечаток беседы берётся из того, что видно в файле: время правки, число
 * реплик, длина контекста и суммарная длина текста. Хеш не считаем: отпечаток
 * нужен, чтобы заметить отставший индекс, а не защититься от подмены.
 */
export function conversationFingerprint(conversation: ChatConversation): string {
  let chars = 0;
  for (const message of conversation.messages) chars += message.content.length;
  return [conversation.updatedAt, conversation.messages.length, conversation.context?.length ?? 0, chars].join(':');
}

/** Все тексты реплик одной пачки — чтобы не искать по массиву каждый раз. */
function textsOf(messages: readonly { content: string }[]): Set<string> {
  const set = new Set<string>();
  for (const message of messages) {
    const text = normalizeText(message.content);
    if (text) set.add(text);
  }
  return set;
}

/**
 * Запись индекса по беседе. Зона реплики считается сравнением ленты с
 * контекстом: сжатие заменяет контекст резюме, но не стирает переписку, и
 * разница между «модель это помнит» и «человек это читал» — ровно то, ради чего
 * индекс и заводится.
 */
export function buildIndexEntry(conversation: ChatConversation): SessionIndexEntry {
  const context = conversation.context ?? [];
  const compacted = context.length > 0;
  const inContext = textsOf(context);
  const inFeed = textsOf(conversation.messages);
  const messages: IndexedMessage[] = [];
  for (const message of conversation.messages) {
    const text = message.content.trim();
    if (!text) continue;
    const zone: SessionZone = !compacted || inContext.has(normalizeText(text)) ? 'context' : 'evicted';
    messages.push({ role: message.role, text: clampRunText(text, MAX_INDEX_TEXT), zone });
  }
  // Резюме сжатия живёт только в контексте: в ленте его нет, а вопрос «что
  // модель помнит о разговоре» — законный и после перезапуска.
  for (const message of context) {
    const text = message.content.trim();
    if (!text || inFeed.has(normalizeText(text))) continue;
    messages.push({ role: message.role, text: clampRunText(text, MAX_INDEX_TEXT), zone: 'context' });
  }
  return {
    uid: conversation.uid,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    fingerprint: conversationFingerprint(conversation),
    messages: messages.slice(-MAX_INDEX_MESSAGES),
  };
}

/** Собрать индекс с нуля: единственный способ лечения отставшего или битого файла. */
export function buildSessionIndex(conversations: readonly ChatConversation[], now = Date.now()): SessionIndexFile {
  return {
    version: SESSION_INDEX_VERSION,
    builtAt: now,
    entries: conversations.map((conversation) => buildIndexEntry(conversation)),
  };
}

/**
 * Годится ли индекс. Проверяем ровно то, что может разойтись с файлами: версия
 * раскладки, состав бесед и отпечаток каждой из них. Не годится — пересборка.
 */
export function indexIsFresh(index: SessionIndexFile | undefined, conversations: readonly ChatConversation[]): boolean {
  if (!index || index.version !== SESSION_INDEX_VERSION) return false;
  if (index.entries.length !== conversations.length) return false;
  const byUid = new Map(index.entries.map((entry) => [entry.uid, entry]));
  for (const conversation of conversations) {
    const entry = byUid.get(conversation.uid);
    if (!entry || entry.fingerprint !== conversationFingerprint(conversation)) return false;
  }
  return true;
}

/** Запись индекса в том виде, в каком её читает поиск. */
export function entryToSource(entry: SessionIndexEntry): SessionSearchSource {
  return {
    uid: entry.uid,
    title: entry.title,
    updatedAt: entry.updatedAt,
    messages: entry.messages.map((message) => ({
      role: message.role,
      content: message.text,
      zone: message.zone,
    })),
  };
}

/**
 * Реплики, которых в файле беседы уже нет: их помнит только журнал прогонов.
 * `seen` — тексты, которые в беседе и так есть: повтор шага не должен давать
 * второй такой же результат в поиске.
 */
export function journalMessages(record: RunTelemetryRecord, seen = new Set<string>()): IndexedMessage[] {
  const messages: IndexedMessage[] = [];
  const add = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const key = normalizeText(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    messages.push({ role: 'assistant', text: clampRunText(trimmed, MAX_INDEX_TEXT), zone: 'journal' });
  };
  for (const step of record.steps) {
    if (step.text) add(step.text);
    for (const call of step.calls) add(`${call.name} ${call.args}${call.ok ? '' : ' — отказ'}`);
  }
  return messages;
}

/**
 * Дополнить индекс журналом прогонов. Беседа, которой в истории уже нет, но чьи
 * прогоны остались в журнале, тоже попадает в поиск — с честной пометкой, что
 * разговор известен только по журналу.
 */
export function mergeJournal(
  entries: readonly SessionIndexEntry[],
  records: readonly RunTelemetryRecord[],
): SessionIndexEntry[] {
  const byUid = new Map<string, RunTelemetryRecord[]>();
  for (const record of records) {
    if (!record.conversation) continue;
    const own = byUid.get(record.conversation);
    if (own) own.push(record);
    else byUid.set(record.conversation, [record]);
  }
  const merged = entries.map((entry) => {
    const own = byUid.get(entry.uid);
    if (!own) return entry;
    const seen = new Set(entry.messages.map((message) => normalizeText(message.text)));
    const extra = own.flatMap((record) => journalMessages(record, seen));
    if (extra.length === 0) return entry;
    return { ...entry, messages: [...entry.messages, ...extra].slice(-MAX_INDEX_MESSAGES) };
  });
  return merged;
}

/**
 * Беседы, известные только журналу: файл беседы удалён, строки прогонов живы.
 * Отдельная функция, а не побочный эффект `mergeJournal`: смешивать «дополнить
 * беседу» и «завести беседу, которой нет» в одном месте — значит потом гадать,
 * откуда в поиске взялось название.
 */
export function journalOnlyEntries(
  entries: readonly SessionIndexEntry[],
  records: readonly RunTelemetryRecord[],
): SessionIndexEntry[] {
  const known = new Set(entries.map((entry) => entry.uid));
  const byUid = new Map<string, RunTelemetryRecord[]>();
  for (const record of records) {
    if (!record.conversation || known.has(record.conversation)) continue;
    const own = byUid.get(record.conversation);
    if (own) own.push(record);
    else byUid.set(record.conversation, [record]);
  }
  const extra: SessionIndexEntry[] = [];
  for (const [uid, own] of byUid) {
    const seen = new Set<string>();
    const messages = own.flatMap((record) => journalMessages(record, seen));
    if (messages.length === 0) continue;
    const last = own.reduce((at, record) => Math.max(at, record.at), 0);
    extra.push({
      uid,
      title: `Беседа вне истории · ${formatClock(last)}`,
      updatedAt: last,
      fingerprint: 'journal',
      messages: messages.slice(-MAX_INDEX_MESSAGES),
    });
  }
  return extra;
}

/**
 * «Что было в прогоне» по прошлой беседе: ответ `search: trace`.
 * Берём из журнала, потому что журнал помнит шаги и вызовы, а файл беседы —
 * только итоговые числа в следе.
 */
export function sessionTraceText(uid: string, records: readonly RunTelemetryRecord[], limit = MAX_TRACE_RUNS): string {
  const own = records.filter((record) => record.conversation === uid).sort((a, b) => a.at - b.at);
  if (own.length === 0) {
    return `В журнале прогонов по беседе ${uid} ничего нет: журнал не писался или уже почищен.`;
  }
  const shown = own.slice(-limit);
  const head =
    shown.length === own.length
      ? `Прогонов в беседе ${uid}: ${own.length}.`
      : `Прогонов в беседе ${uid}: ${own.length}, показаны последние ${shown.length}.`;
  const lines: string[] = [head];
  for (const record of shown) {
    const steps = record.trace.steps || record.steps.length;
    lines.push(
      '',
      `${formatClock(record.at)} · ${record.mode} · ${record.provider}/${record.model} · ` +
        `${formatDuration(record.ms)} · ${plural(steps, 'шаг', 'шага', 'шагов')} · ` +
        `${plural(record.trace.toolCalls, 'вызов', 'вызова', 'вызовов')} · ` +
        finishedLabel(record.finished),
    );
    for (const step of record.steps) {
      const said = step.text ? ` ${clampRunText(step.text, 200)}` : '';
      lines.push(`  #${step.index} ${formatDuration(step.ms)}${said}`);
      for (const call of step.calls) {
        const verdict = call.ok ? '' : ' отказ';
        lines.push(`    → ${call.name} ${clampRunText(call.args, 120)}${verdict}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Запасной ответ для `search: trace`, когда журнал молчит: в беседе остался
 * итоговый след прогона. Чисел меньше, чем в журнале (шагов и вызовов по
 * отдельности нет), но больше, чем ничего.
 */
export function conversationTraceText(conversation: ChatConversation | undefined, uid: string): string {
  const trace = conversation?.trace;
  if (!conversation || !trace) {
    return `Про беседу ${uid} ничего не известно ни журналу, ни истории: след не писался.`;
  }
  const usage = trace.usage;
  const parts = [
    `Беседа «${conversation.title}», след прогона (журнал не писался):`,
    `${plural(trace.steps, 'шаг', 'шага', 'шагов')} · ` + `${plural(trace.toolCalls, 'вызов', 'вызова', 'вызовов')}`,
  ];
  if (usage.promptTokens || usage.completionTokens) {
    parts.push(
      `вход ${formatThousands(usage.promptTokens ?? 0)} · выход ${formatThousands(usage.completionTokens ?? 0)} ток.`,
    );
  }
  if (trace.toolsTokens) parts.push(`схемы инструментов ${formatThousands(trace.toolsTokens)} ток.`);
  parts.push(`правка ${formatClock(conversation.updatedAt)}`);
  return parts.join('\n');
}
