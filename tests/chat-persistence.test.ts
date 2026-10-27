import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatHistory, ChatMessage } from '../src/shared/api';
import type { RpcClient } from '../src/renderer/core/rpc';
import type { WorkspaceModel } from '../src/renderer/core/workspace-model';
import { createChatPersistence, newChatUid, serializeSession } from '../src/renderer/ui/chat-persistence';
import type { ChatSession } from '../src/renderer/ui/chat-session';

/**
 * Сохранение и восстановление бесед.
 *
 * Здесь проверяется то, что легко сломать незаметно: что в файл уходит только
 * нужное (ни ленты DOM, ни незаписанных правок), что пачка правок даёт одну
 * запись, что прежняя папка записывается ДО перехода к новой и что ответ
 * загрузки для уже покинутого проекта не подменяет беседы текущего.
 */

/**
 * Беседа панели: всё, кроме истории, для сохранения не нужно, но должно быть на месте.
 * Переписка по умолчанию повторяет контекст: так выглядит беседа, которую не сжимали.
 */
function makeSession(over: Partial<ChatSession> = {}): ChatSession {
  const history = over.history ?? [];
  return {
    id: 1,
    uid: 'chat_base',
    title: 'Беседа 1',
    thread: null as unknown as HTMLElement,
    history,
    transcript: history,
    touched: new Map(),
    files: [],
    attachments: [],
    draft: '',
    ...over,
  };
}

const user = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: 'user', content, ...extra });

describe('serializeSession', () => {
  it('берёт историю, заголовок и uid, а время проставляет своё', () => {
    const conversation = serializeSession(
      makeSession({ uid: 'chat_x', title: 'Про отладчик', history: [user('привет')] }),
    );
    expect(conversation.uid).toBe('chat_x');
    expect(conversation.title).toBe('Про отладчик');
    expect(conversation.messages).toEqual([{ role: 'user', content: 'привет' }]);
    expect(typeof conversation.updatedAt).toBe('number');
  });

  it('лента DOM, правки агента и черновик в файл не уходят', () => {
    const session = makeSession({
      history: [user('вопрос')],
      draft: 'недописанный вопрос',
      touched: new Map([['/p/a.ts', { original: 'old', added: 1, removed: 0 }]]),
      files: [{ kind: 'created', path: '/p/b.ts' }],
    });
    const conversation = serializeSession(session);
    expect(Object.keys(conversation).sort()).toEqual(['messages', 'title', 'uid', 'updatedAt']);
  });

  it('сохраняет то, чем беседа живёт после перезапуска: имя, вызов, оценку', () => {
    const message: ChatMessage = {
      role: 'tool',
      content: 'готово',
      name: 'read_file',
      toolCallId: 'call-1',
      rating: 'up',
    };
    const conversation = serializeSession(makeSession({ history: [message] }));
    expect(conversation.messages[0]).toEqual({
      role: 'tool',
      content: 'готово',
      name: 'read_file',
      toolCallId: 'call-1',
      rating: 'up',
    });
  });

  it('вложенные вызовы и расход копируются, а не отдаются по ссылке', () => {
    const call = { id: 'c1', name: 'search', arguments: '{}' };
    const session = makeSession({
      history: [{ role: 'assistant', content: '', toolCalls: [call] }],
      usage: { promptTokens: 10, completionTokens: 5 },
      trace: {
        steps: 1,
        toolCalls: 0,
        usage: { promptTokens: 10, completionTokens: 5 },
        toolsTokens: 0,
      },
    });
    const conversation = serializeSession(session);
    expect(conversation.messages[0]?.toolCalls?.[0]).toEqual(call);
    // Копия: правка оригинала не должна утекать в уже собранный снимок.
    expect(conversation.messages[0]?.toolCalls?.[0]).not.toBe(call);
    expect(conversation.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    expect(conversation.usage).not.toBe(session.usage);
    expect(conversation.trace?.usage).not.toBe(session.trace?.usage);
  });

  it('сжатая беседа пишет и переписку, и сжатый контекст', () => {
    const conversation = serializeSession(
      makeSession({
        // Переписка — три сообщения, контекст — резюме: так выглядит сжатая беседа.
        transcript: [user('вопрос'), { role: 'assistant', content: 'ответ' }, user('ещё вопрос')],
        history: [{ role: 'user', content: 'Контекст сжатой беседы:\n\nрезюме' }],
      }),
    );

    // Лента после перезапуска собирается из переписки: прочитанное не пропадает.
    expect(conversation.messages.map((message) => message.content)).toEqual(['вопрос', 'ответ', 'ещё вопрос']);
    // Модель получит резюме, а не всю переписку.
    expect(conversation.context).toEqual([{ role: 'user', content: 'Контекст сжатой беседы:\n\nрезюме' }]);
  });

  it('без сжатия отдельного контекста нет — файл не дублируется', () => {
    const conversation = serializeSession(makeSession({ history: [user('привет')] }));
    expect('context' in conversation).toBe(false);
  });

  it('без расхода и следа в отчёте нет пустых полей', () => {
    const conversation = serializeSession(makeSession({ history: [user('привет')] }));
    expect('usage' in conversation).toBe(false);
    expect('trace' in conversation).toBe(false);
  });
});

describe('newChatUid', () => {
  it('у бесед разные uid: по нему беседа находится после перезапуска', () => {
    const first = newChatUid();
    const second = newChatUid();
    expect(first).toMatch(/^chat_/);
    expect(second).not.toBe(first);
  });
});

/** Рабочая папка: корень и смена корня (как push-событие от main). */
function makeWorkspace(root: string | null) {
  const listeners = new Set<(change: { info: { root: string } | null }) => void>();
  const workspace = {
    root,
    onDidChange: (listener: (change: { info: { root: string } | null }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Перейти к другой папке: корень меняется и об этом узнаёт подписчик. */
    change(next: string | null): void {
      workspace.root = next;
      for (const listener of [...listeners]) listener({ info: next ? { root: next } : null });
    },
  };
  return workspace as unknown as WorkspaceModel & { change(next: string | null): void };
}

interface PersistenceSetup {
  persistence: ReturnType<typeof createChatPersistence>;
  requests: Array<{ method: string; params: unknown }>;
  workspace: WorkspaceModel & { change(next: string | null): void };
  restored: ChatHistory[];
  resolveLoad(history: ChatHistory): void;
}

/** Стенд: заглушка rpc копит запросы, загрузку отдаём вручную — так видно порядок. */
function setup(root: string | null, onRequest?: (method: string) => unknown): PersistenceSetup {
  const requests: Array<{ method: string; params: unknown }> = [];
  const pending: Array<(history: ChatHistory) => void> = [];
  const restored: ChatHistory[] = [];
  const rpc = {
    request: (method: string, params: unknown) => {
      requests.push({ method, params });
      const custom = onRequest?.(method);
      if (custom !== undefined) return custom instanceof Promise ? custom : Promise.resolve(custom);
      if (method === 'ai.chats.load') {
        return new Promise((resolve) => {
          pending.push(resolve as (history: ChatHistory) => void);
        });
      }
      return Promise.resolve();
    },
  } as unknown as RpcClient;

  const workspace = makeWorkspace(root);
  const persistence = createChatPersistence({
    rpc,
    workspace,
    snapshot: () => ({ sessions: [makeSession({ uid: 'chat_active' })], activeUid: 'chat_active' }),
    restore: (history) => restored.push(history),
    onRootChanged: () => undefined,
  });
  return {
    persistence,
    requests,
    workspace,
    restored,
    resolveLoad: (history) => pending.shift()?.(history),
  };
}

const saves = (requests: Array<{ method: string; params: unknown }>) =>
  requests.filter((request) => request.method === 'ai.chats.save');

describe('createChatPersistence: запись', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('пачка правок даёт одну запись — с корнем, беседами и активной', async () => {
    vi.useFakeTimers();
    const { persistence, requests } = setup('/p', () => ({}));
    persistence.start();
    persistence.schedule();
    persistence.schedule();
    persistence.schedule();
    await vi.advanceTimersByTimeAsync(400);

    const writes = saves(requests);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.params).toMatchObject({ root: '/p', activeUid: 'chat_active' });
  });

  it('проект ещё не открыт — записывать некуда, и мы молчим', async () => {
    vi.useFakeTimers();
    const { persistence, requests } = setup(null, () => ({}));
    persistence.start();
    persistence.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves(requests)).toHaveLength(0);
  });

  it('неудачная запись не роняет панель: ошибка глотается', async () => {
    vi.useFakeTimers();
    const { persistence, requests } = setup('/p', (method) =>
      method === 'ai.chats.save' ? Promise.reject(new Error('диск кончился')) : {},
    );
    persistence.start();
    persistence.schedule();
    // Дошли до записи, а отказ в ней не вылез наружу: обработчик ошибки на месте.
    await vi.advanceTimersByTimeAsync(500);
    expect(saves(requests)).toHaveLength(1);
  });
});

describe('createChatPersistence: восстановление', () => {
  it('открытый проект — история загружается и уходит в панель', async () => {
    const { persistence, restored, resolveLoad, requests } = setup('/p');
    persistence.start();
    expect(requests.some((request) => request.method === 'ai.chats.load')).toBe(true);
    resolveLoad({ conversations: [], activeUid: 'chat_1' });
    await Promise.resolve();
    expect(restored).toHaveLength(1);
  });

  it('проекта нет — грузить нечего', () => {
    const { persistence, requests } = setup(null);
    persistence.start();
    expect(requests.some((request) => request.method === 'ai.chats.load')).toBe(false);
  });

  it('ответ для уже покинутого проекта беседы не подменяет', async () => {
    const { persistence, restored, resolveLoad, workspace } = setup('/a');
    persistence.start();
    // Пока грузился старый проект, человек открыл другой.
    workspace.change('/b');
    resolveLoad({ conversations: [], activeUid: 'из А' });
    await Promise.resolve();
    expect(restored).toHaveLength(0);

    resolveLoad({ conversations: [], activeUid: 'из Б' });
    await Promise.resolve();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.activeUid).toBe('из Б');
  });

  it('ошибка загрузки не ломает открытие проекта', async () => {
    const { persistence, restored } = setup('/p', (method) => {
      if (method === 'ai.chats.load') throw new Error('файл битый');
      return {};
    });
    persistence.start();
    await Promise.resolve();
    expect(restored).toHaveLength(0);
    expect(persistence.root()).toBe('/p');
  });
});

describe('createChatPersistence: смена папки', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('прежняя папка записывается до перехода к новой', async () => {
    const { persistence, requests, workspace } = setup('/a', () => ({}));
    persistence.start();
    workspace.change('/b');

    const writes = saves(requests);
    // Запись случилась сразу (не по таймеру) и именно для прежнего корня.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.params).toMatchObject({ root: '/a' });
    // И сразу же запрошена история новой папки.
    const loads = requests.filter((request) => request.method === 'ai.chats.load');
    expect(loads.map((request) => (request.params as { root: string }).root)).toEqual(['/a', '/b']);
  });

  it('отложенная запись снимается переходом: она больше не нужна', async () => {
    vi.useFakeTimers();
    const { persistence, requests, workspace } = setup('/a', () => ({}));
    persistence.start();
    persistence.schedule();
    workspace.change('/b');
    await vi.advanceTimersByTimeAsync(1000);

    // Одна запись — та, что сделана переходом; отложенная не выстрелила второй.
    expect(saves(requests)).toHaveLength(1);
  });

  it('корень, к которому уже привязаны, переходом не считается', () => {
    const { persistence, requests } = setup('/a', () => ({}));
    persistence.start();
    const before = requests.length;
    persistence.root();
    expect(persistence.root()).toBe('/a');
    expect(requests.length).toBe(before);
  });
});
