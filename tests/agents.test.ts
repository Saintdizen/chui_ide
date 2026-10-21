import { describe, expect, it } from 'vitest';
import { createAgentRegistry, type AgentHandle, type AgentRegistry } from '../src/main/ai/agents';
import {
  MAX_AGENT_MESSAGES,
  MAX_KEPT_AGENTS,
  MAX_LIVE_AGENTS,
  MAX_MESSAGE_CHARS,
  agentActivityLabel,
  agentStatusLabel,
  formatAgentList,
  formatAgentNotes,
  formatElapsed,
  stopReasonLabel,
  type AgentSnapshot,
} from '../src/shared/agents';

/** Агент из реестра; отказ запуска в тесте — это провал теста, а не повод ветвиться. */
function spawnOk(registry: AgentRegistry, description = 'разведка'): AgentHandle {
  const spawned = registry.spawn({ description });
  if ('error' in spawned) throw new Error(`агент не запустился: ${spawned.error}`);
  return spawned;
}

describe('подписи', () => {
  it('состояние и причина — словами', () => {
    expect(agentStatusLabel('running')).toBe('идёт');
    expect(agentStatusLabel('failed')).toBe('сбой');
    expect(stopReasonLabel('human')).toContain('человеком');
  });
});

describe('реестр агентов', () => {
  it('заведённый агент сразу виден идущим', () => {
    const registry = createAgentRegistry();
    const handle = spawnOk(registry, 'разведка');
    expect(handle.id).toBe('agent-1');
    expect(registry.list().map((agent) => agent.status)).toEqual(['running']);
  });
  it('завершённый получает итог и отчёт', async () => {
    const registry = createAgentRegistry();
    const handle = spawnOk(registry, 'разведка');
    registry.settle(handle.id, 'done', 'нашёл тесты', 'полный отчёт');
    const result = await registry.wait([handle.id], 50);
    expect(result.timedOut).toBe(false);
    expect(result.agents[0]?.status).toBe('done');
    expect(result.reports.get(handle.id)).toBe('полный отчёт');
  });
  it('сверх предела не запускаем', () => {
    const registry = createAgentRegistry();
    for (let i = 0; i < MAX_LIVE_AGENTS; i += 1) spawnOk(registry, 'задача');
    expect('error' in registry.spawn({ description: 'лишний' })).toBe(true);
  });
});

/** Снимок агента из реестра; нет такого — провал теста. */
function snapshotOf(registry: AgentRegistry, id: string): AgentSnapshot {
  const found = registry.snapshot(id);
  if (found === null) throw new Error(`агента ${id} нет в реестре`);
  return found;
}

describe('почта агента', () => {
  it('сообщение ждёт шага, а не пропадает', () => {
    const registry = createAgentRegistry();
    const handle = spawnOk(registry);
    expect(registry.send(handle.id, 'смотри тесты', 'human')).toEqual({ ok: true });
    // Пока агент не дошёл до шага, сообщение видно счётчиком в панели.
    expect(snapshotOf(registry, handle.id).pending).toBe(1);
    expect(handle.drain()).toEqual([{ from: 'human', text: 'смотри тесты' }]);
    expect(snapshotOf(registry, handle.id).pending).toBe(0);
    // Забрали — второй раз не отдаётся: иначе агент прочитал бы одно и то же дважды.
    expect(handle.drain()).toEqual([]);
  });
});

describe('остановка одного агента', () => {
  it('снимается сигнал, но не весь ход', () => {
    const registry = createAgentRegistry();
    const run = new AbortController();
    const first = registry.spawn({ description: 'первый', parent: run.signal });
    const second = registry.spawn({ description: 'второй', parent: run.signal });
    if ('error' in first || 'error' in second) throw new Error('агенты не запустились');

    expect(registry.interrupt(first.id, 'human')).toBe(true);
    // Сигнал агента снят, а у соседа и у хода — нет: кнопка «остановить» про одного.
    expect(first.signal.aborted).toBe(true);
    expect(first.stopReason).toBe('human');
    expect(second.signal.aborted).toBe(false);
    expect(run.signal.aborted).toBe(false);
  });

  it('остановка хода снимает всех', () => {
    const registry = createAgentRegistry();
    const run = new AbortController();
    const one = registry.spawn({ description: 'первый', parent: run.signal });
    const two = registry.spawn({ description: 'второй', parent: run.signal });
    if ('error' in one || 'error' in two) throw new Error('агенты не запустились');
    run.abort();
    expect(one.signal.aborted).toBe(true);
    expect(two.signal.aborted).toBe(true);
    expect(one.stopReason).toBe('run');
  });

  it('завершённого второй раз не снимаем', () => {
    const registry = createAgentRegistry();
    const handle = spawnOk(registry);
    registry.settle(handle.id, 'done', 'готово');
    expect(registry.interrupt(handle.id, 'human')).toBe(false);
  });
});

describe('пределы реестра', () => {
  it('завершённые не копятся: панель — не архив прогонов', () => {
    const registry = createAgentRegistry();
    for (let index = 0; index < MAX_KEPT_AGENTS + 2; index += 1) {
      const handle = spawnOk(registry, `задача ${index}`);
      registry.settle(handle.id, 'done', 'готово');
    }
    expect(registry.list().length).toBe(MAX_KEPT_AGENTS);
    // Ушли самые старые: свежие отчёты ещё могут понадобиться.
    expect(registry.snapshot('agent-1')).toBeNull();
  });

  it('завершённый не занимает места живого', () => {
    const registry = createAgentRegistry();
    for (let index = 0; index < MAX_LIVE_AGENTS; index += 1) {
      const handle = spawnOk(registry, `задача ${index}`);
      registry.settle(handle.id, 'done', 'готово');
    }
    // Все закончили — место свободно, иначе панель запрещала бы работать после первой пачки.
    expect('error' in registry.spawn({ description: 'новая задача' })).toBe(false);
  });

  it('clearFinished оставляет только идущих', () => {
    const registry = createAgentRegistry();
    const done = spawnOk(registry, 'закончил');
    registry.settle(done.id, 'done', 'готово');
    const live = spawnOk(registry, 'идёт');
    registry.clearFinished();
    expect(registry.list().map((agent) => agent.id)).toEqual([live.id]);
  });
});

describe('ожидание агентов', () => {
  it('истекшее время — честное «ещё идут», а не ошибка', async () => {
    const registry = createAgentRegistry();
    const handle = spawnOk(registry);
    const result = await registry.wait([handle.id], 10);
    expect(result.timedOut).toBe(true);
    expect(result.agents[0]?.status).toBe('running');
    expect(result.reports.size).toBe(0);
  });

  it('ждём только названных: остальные не тормозят', async () => {
    const registry = createAgentRegistry();
    const fast = spawnOk(registry, 'быстрый');
    spawnOk(registry, 'медленный');
    registry.settle(fast.id, 'done', 'готово', 'отчёт');
    const result = await registry.wait([fast.id], 50);
    expect(result.timedOut).toBe(false);
    expect(result.reports.get(fast.id)).toBe('отчёт');
  });
});

describe('подписка на изменения', () => {
  it('каждое действие зовёт слушателя, отписка замолкает', () => {
    const registry = createAgentRegistry();
    const seen: number[] = [];
    const off = registry.onChange((agents) => seen.push(agents.length));
    const handle = spawnOk(registry);
    registry.send(handle.id, 'привет', 'human');
    registry.settle(handle.id, 'done', 'готово');
    expect(seen.length).toBeGreaterThanOrEqual(3);
    off();
    const before = seen.length;
    spawnOk(registry);
    expect(seen.length).toBe(before);
  });
});

/** Снимок для подписей: остальное в них не участвует. */
function agentSnapshot(patch: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: 'agent-1',
    description: 'разведка',
    status: 'running',
    startedAt: 0,
    steps: 0,
    toolCalls: 0,
    activity: '',
    pending: 0,
    ...patch,
  };
}

describe('подписи для панели и модели', () => {
  it('время — секундами и минутами, без десятых', () => {
    expect(formatElapsed(4_000)).toBe('4 с');
    expect(formatElapsed(60_000)).toBe('1 мин');
    expect(formatElapsed(125_000)).toBe('2 мин 5 с');
  });

  it('чем занят идущий и чем кончил завершённый', () => {
    expect(agentActivityLabel(agentSnapshot())).toBe('думает');
    expect(agentActivityLabel(agentSnapshot({ activity: 'read_file' }))).toBe('сейчас: read_file');
    expect(agentActivityLabel(agentSnapshot({ status: 'done', summary: 'нашёл тесты' }))).toBe('нашёл тесты');
  });
});

describe('текст для модели', () => {
  it('пустой список объясняется словами, а не пустотой', () => {
    const text = formatAgentList([]);
    expect(text).toContain('Агентов нет');
    expect(text).toContain('agents');
  });

  it('в строке агента видно номер, состояние и счётчики', () => {
    const text = formatAgentList([agentSnapshot({ steps: 3, toolCalls: 2, activity: 'read_file', pending: 1 })]);
    expect(text).toContain('Агентов: 1');
    expect(text).toContain('agent-1 «разведка»');
    expect(text).toContain('шагов 3');
    expect(text).toContain('вызовов 2');
    expect(text).toContain('сообщений в очереди 1');
  });

  it('уточнения агенту названы по автору', () => {
    const text = formatAgentNotes([
      { from: 'human', text: 'смотри тесты' },
      { from: 'agent', text: 'не трогай стиль' },
    ]);
    expect(text).toContain('от человека: смотри тесты');
    expect(text).toContain('от ведущего агента: не трогай стиль');
  });

});

describe('почта не превращается в свалку', () => {
  it('очередь ограничена: агент её всё равно не успевает читать', () => {
    const registry = createAgentRegistry();
    const handle = spawnOk(registry);
    for (let index = 0; index < MAX_AGENT_MESSAGES; index += 1) {
      expect(registry.send(handle.id, `уточнение ${index}`, 'human').ok).toBe(true);
    }
    const refused = registry.send(handle.id, 'лишнее', 'human');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('не успевает');
  });

  it('длинное сообщение срезается, а не ломает запись', () => {
    const registry = createAgentRegistry();
    const handle = spawnOk(registry);
    expect(registry.send(handle.id, 'я'.repeat(MAX_MESSAGE_CHARS + 50), 'agent').ok).toBe(true);
    expect(handle.drain()[0]?.text.length).toBe(MAX_MESSAGE_CHARS);
    // Автор сохраняется: агент различает, человек это сказал или ведущий агент.
    expect(handle.drain()).toEqual([]);
  });
});
