/**
 * Индекс прошлых бесед: файл рядом с файлом беседы и правила его свежести.
 *
 * Хозяин разговоров — `ChatStore`: индекс — копия, из которой ищут. Пропал,
 * отстал, собран другой версией раскладки — пересобираем из бесед; сами
 * разговоры от состояния индекса не зависят, поэтому потеря файла индекса
 * лечится пересборкой, а не потерей истории.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ChatConversation } from '../../shared/api';
import {
  SESSION_INDEX_VERSION,
  buildSessionIndex,
  conversationTraceText,
  entryToSource,
  indexIsFresh,
  journalOnlyEntries,
  mergeJournal,
  sessionTraceText,
  type SessionIndexFile,
} from '../../shared/session-index';
import { searchSessions, type SessionSearchReport } from '../../shared/session-search';
import type { RunTelemetryRecord } from '../../shared/telemetry';

/** Откуда берётся правда: файл беседы и, если журнал ведётся, строки прогонов. */
export interface SessionIndexSources {
  conversations(root: string): Promise<ChatConversation[]>;
  journal(root: string): Promise<RunTelemetryRecord[]>;
  /**
   * Файл беседы этого проекта. Индекс кладёт копию рядом с ним и не повторяет
   * правила именования: разойдись они — поиск молча читал бы чужую копию.
   */
  chatFile(root: string): string;
}

export class SessionIndexStore {
  private readonly sources: SessionIndexSources;
  /** Прочитанное с диска: поиск не должен перечитывать индекс каждый раз. */
  private readonly cache = new Map<string, SessionIndexFile>();

  constructor(sources: SessionIndexSources) {
    this.sources = sources;
  }

  /** Настоящий путь: рядом с файлом беседы, `…-abc123.index.json`. */
  fileFor(root: string): string {
    return `${this.sources.chatFile(root).replace(/\.json$/, '')}.index.json`;
  }

  /**
   * Индекс с диска, если он ещё годится. Старый, битый или чужой версии файл —
   * не ошибка: это повод собрать заново, а не жаловаться человеку.
   */
  private async read(root: string): Promise<SessionIndexFile | undefined> {
    const key = path.resolve(root);
    const cached = this.cache.get(key);
    if (cached) return cached;
    try {
      const parsed = JSON.parse(await fs.readFile(this.fileFor(root), 'utf8')) as SessionIndexFile;
      if (parsed?.version !== SESSION_INDEX_VERSION || !Array.isArray(parsed.entries)) return undefined;
      this.cache.set(key, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  /** Запись индекса. Не записалось — поиск идёт по собранному в памяти. */
  private async write(root: string, index: SessionIndexFile): Promise<void> {
    this.cache.set(path.resolve(root), index);
    try {
      await fs.mkdir(path.dirname(this.fileFor(root)), { recursive: true });
      await fs.writeFile(this.fileFor(root), JSON.stringify(index), 'utf8');
    } catch {
      // Индекс — копия, а не хозяин: без него поиск остаётся, пропадает только скорость.
    }
  }

  /** Беседа сохранилась — файл беседы теперь новее индекса. */
  invalidate(root: string): void {
    this.cache.delete(path.resolve(root));
  }

  /**
   * Индекс, годный к чтению: свежий с диска или пересобранный из бесед.
   * Пересборка заодно пишет файл, чтобы следующий запуск начал со свежего.
   */
  private async ensure(root: string): Promise<SessionIndexFile> {
    const conversations = await this.sources.conversations(root);
    const cached = await this.read(root);
    if (indexIsFresh(cached, conversations)) return cached as SessionIndexFile;
    const index = buildSessionIndex(conversations);
    await this.write(root, index);
    return index;
  }

  /** Журнал прогонов; его может не быть — тогда поиск живёт одной историей. */
  private async journal(root: string): Promise<RunTelemetryRecord[]> {
    try {
      return await this.sources.journal(root);
    } catch {
      return [];
    }
  }

  /**
   * Поиск по прошлым беседам. Ищется по индексу, но ответ честный: у каждой
   * найденной реплики видно, лежит ли она в контексте, вытеснена сжатием или
   * осталась только в журнале прогонов.
   */
  async search(
    root: string,
    query: string,
    options: { limit?: number; matches?: number } = {},
  ): Promise<SessionSearchReport> {
    const index = await this.ensure(root);
    const journal = await this.journal(root);
    const entries = [...mergeJournal(index.entries, journal), ...journalOnlyEntries(index.entries, journal)];
    return searchSessions(entries.map(entryToSource), query, options);
  }

  /**
   * «Что было в прогоне» по беседе. Журнал помнит шаги и вызовы, история —
   * только итоговые числа, поэтому журнал в приоритете, а след беседы остаётся
   * запасным ответом.
   */
  async trace(root: string, uid: string): Promise<string> {
    const journal = await this.journal(root);
    if (journal.some((record) => record.conversation === uid)) return sessionTraceText(uid, journal);
    const conversations = await this.sources.conversations(root);
    return conversationTraceText(
      conversations.find((conversation) => conversation.uid === uid),
      uid,
    );
  }
}
