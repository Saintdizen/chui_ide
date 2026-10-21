import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ChatConversation } from '../src/shared/api';
import { SessionIndexStore } from '../src/main/ai/session-index-store';
import {
  SESSION_INDEX_VERSION,
  buildIndexEntry,
  buildSessionIndex,
  conversationTraceText,
  indexIsFresh,
  journalMessages,
  journalOnlyEntries,
  mergeJournal,
  sessionTraceText,
  type SessionIndexFile,
} from '../src/shared/session-index';
import { formatSessionSearch, searchSessions } from '../src/shared/session-search';
import type { RunTelemetryRecord } from '../src/shared/telemetry';

/**
 * Индекс бесед. Главное, что проверяем: индекс — копия. Его можно потерять,
 * испортить, перепутать версию — разговоры от этого не пропадают, а поиск
 * отвечает честно, где лежит реплика: в контексте, вне его или только в журнале.
 */
const conversation = (
  uid: string,
  title: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  extra: Partial<ChatConversation> = {},
): ChatConversation => ({
  uid,
  title,
  updatedAt: 1_700_000_000_000,
  messages: messages.map((message) => ({ ...message })),
  ...extra,
});

const record = (uid: string, text: string, at = 1_700_000_500_000): RunTelemetryRecord => ({
  version: 1,
  at,
  startedAt: at - 1000,
  conversation: uid,
  provider: 'openai',
  model: 'gpt',
  mode: 'agent',
  permission: 'auto',
  finished: 'done',
  ms: 1000,
  trace: { steps: 1, toolCalls: 1, usage: { promptTokens: 100, completionTokens: 10 } },
  system: {} as RunTelemetryRecord['system'],
  steps: [
    {
      index: 1,
      ms: 900,
      text,
      calls: [{ id: 'c1', name: 'read', args: '{"path":"src/a.ts"}', ok: true, summary: '12 строк' }],
    },
  ],
});

describe('buildIndexEntry', () => {
  it('без сжатия все реплики живут в контексте', () => {
    const entry = buildIndexEntry(
      conversation('chat_a', 'Разговор', [
        { role: 'user', content: 'Почему поиск молчит?' },
        { role: 'assistant', content: 'Индекс отстал от файла.' },
      ]),
    );
    expect(entry.messages.map((message) => message.zone)).toEqual(['context', 'context']);
    expect(entry.fingerprint).toMatch(/^1700000000000:2:0:\d+$/);
  });

  it('со сжатием лента делится на контекст и вытесненное, резюме тоже попадает', () => {
    const entry = buildIndexEntry(
      conversation(
        'chat_b',
        'Долгий разговор',
        [
          { role: 'user', content: 'Старый вопрос про pty' },
          { role: 'assistant', content: 'Свежий ответ про сборку' },
        ],
        {
          context: [
            { role: 'system', content: 'Резюме: чинили pty и сборку.' },
            { role: 'assistant', content: 'Свежий ответ про сборку' },
          ],
        },
      ),
    );
    const zones = entry.messages.map((message) => [message.text, message.zone]);
    expect(zones).toEqual([
      ['Старый вопрос про pty', 'evicted'],
      ['Свежий ответ про сборку', 'context'],
      ['Резюме: чинили pty и сборку.', 'context'],
    ]);
  });
});

describe('indexIsFresh', () => {
  const chats = [
    conversation('chat_a', 'Разговор', [{ role: 'user', content: 'Вопрос' }]),
    conversation('chat_b', 'Второй', [{ role: 'user', content: 'Другой' }]),
  ];

  it('свой свежий индекс годится', () => {
    expect(indexIsFresh(buildSessionIndex(chats), chats)).toBe(true);
  });

  it('новая беседа, правка и другая версия делают индекс негодным', () => {
    const index = buildSessionIndex(chats);
    expect(indexIsFresh(index, [...chats, conversation('chat_c', 'Третья', [])])).toBe(false);

    const edited = [{ ...chats[0], updatedAt: chats[0].updatedAt + 1 }, chats[1]];
    expect(indexIsFresh(index, edited)).toBe(false);

    const old: SessionIndexFile = { ...index, version: SESSION_INDEX_VERSION + 1 };
    expect(indexIsFresh(old, chats)).toBe(false);
    expect(indexIsFresh(undefined, chats)).toBe(false);
  });
});

describe('журнал', () => {
  const entry = () =>
    buildIndexEntry(conversation('chat_a', 'Разговор', [{ role: 'user', content: 'Почему падает сборка?' }]));

  it('шаги прогона добавляются с пометкой «только в журнале»', () => {
    const [merged] = mergeJournal([entry()], [record('chat_a', 'Смотрю node-pty.')]);
    expect(merged.messages.map((message) => message.zone)).toEqual(['context', 'journal', 'journal']);
    expect(merged.messages[1].text).toBe('Смотрю node-pty.');
    expect(merged.messages[2].text).toContain('read');
  });

  it('повтор того, что уже есть в беседе, второй раз в поиск не идёт', () => {
    const seen = new Set(['почему падает сборка?']);
    const messages = journalMessages(record('chat_a', 'Почему падает сборка?'), seen);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain('read');
  });

  it('беседа, известная только журналу, появляется с честным названием', () => {
    const extra = journalOnlyEntries([], [record('chat_gone', 'Разбирали лог.')]);
    expect(extra).toHaveLength(1);
    expect(extra[0].uid).toBe('chat_gone');
    expect(extra[0].title).toContain('Беседа вне истории');
    expect(journalOnlyEntries([entry()], [record('chat_a', 'Шаг.')])).toEqual([]);
  });

  it('trace отвечает шагами из журнала, а без журнала — следом беседы', () => {
    const text = sessionTraceText('chat_a', [record('chat_a', 'Смотрю node-pty.')]);
    expect(text).toContain('Прогонов в беседе chat_a: 1');
    expect(text).toContain('→ read');
    expect(sessionTraceText('chat_никто', [])).toContain('ничего нет');

    const fallback = conversationTraceText(
      conversation('chat_a', 'Разговор', [], {
        trace: { steps: 3, toolCalls: 5, usage: { promptTokens: 1200, completionTokens: 200 } },
      }),
      'chat_a',
    );
    expect(fallback).toContain('3 шага');
    expect(fallback).toContain('5 вызовов');
  });
});

describe('SessionIndexStore', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** Хранилище поверх временного каталога: файла беседы здесь нет вовсе. */
  const makeStore = async (initial: ChatConversation[]) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chui-index-'));
    dirs.push(dir);
    const state = { conversations: initial, journal: [] as RunTelemetryRecord[], reads: 0 };
    const store = new SessionIndexStore({
      conversations: async () => {
        state.reads += 1;
        return state.conversations;
      },
      chatFile: () => path.join(dir, 'workspace.json'),
      journal: async () => state.journal,
    });
    return { store, state, file: path.join(dir, 'workspace.index.json') };
  };

  it('соберёт индекс при первом поиске и пересоберёт после правки беседы', async () => {
    const { store, state, file } = await makeStore([
      conversation('chat_a', 'Сборка', [{ role: 'user', content: 'Почему падает сборка?' }]),
    ]);
    const first = await store.search('/проект', 'сборка');
    expect(first.hits.map((hit) => hit.uid)).toEqual(['chat_a']);

    const saved = JSON.parse(await readFile(file, 'utf8')) as SessionIndexFile;
    expect(saved.version).toBe(SESSION_INDEX_VERSION);

    // Файл беседы ушёл вперёд — индекс обязан отстать и пересобраться.
    state.conversations = [conversation('chat_a', 'Сборка', [{ role: 'user', content: 'Почему падает линковка?' }])];
    const second = await store.search('/проект', 'линковка');
    expect(second.hits.map((hit) => hit.uid)).toEqual(['chat_a']);
    const rewrite = JSON.parse(await readFile(file, 'utf8')) as SessionIndexFile;
    expect(rewrite.entries[0].fingerprint).not.toBe(saved.entries[0].fingerprint);
  });

  it('потерянный и битый индекс лечится пересборкой, а не потерей бесед', async () => {
    const { store, file } = await makeStore([
      conversation('chat_a', 'Сборка', [{ role: 'user', content: 'Почему падает сборка?' }]),
    ]);
    await writeFile(file, 'не json', 'utf8');
    const report = await store.search('/проект', 'сборка');
    expect(report.hits).toHaveLength(1);
    expect((JSON.parse(await readFile(file, 'utf8')) as SessionIndexFile).version).toBe(SESSION_INDEX_VERSION);
  });
});

describe('поиск по индексу', () => {
  it('пометка зоны доходит до ответа: вытесненное и журнальное видно', () => {
    const entry = buildIndexEntry(
      conversation('chat_a', 'Сборка', [{ role: 'user', content: 'Старый вопрос про pty и сборка' }], {
        context: [{ role: 'assistant', content: 'Резюме: pty починен' }],
      }),
    );
    const [merged] = mergeJournal([entry], [record('chat_a', 'Шаг про линковку')]);
    const report = searchSessions(
      [merged].map((item) => ({
        uid: item.uid,
        title: item.title,
        updatedAt: item.updatedAt,
        messages: item.messages.map((message) => ({
          role: message.role,
          content: message.text,
          zone: message.zone,
        })),
      })),
      'сборка линков',
    );
    const zones = report.hits[0].matches.map((match) => match.zone);
    expect(zones).toContain('evicted');
    const text = formatSessionSearch(report);
    expect(text).toContain('(вне контекста)');
    expect(text).toContain('(только в журнале)');
  });
});
