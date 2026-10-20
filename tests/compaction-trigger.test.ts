import { describe, expect, it } from 'vitest';
import {
  COMPACT_EVERY_TURNS,
  compactionMessage,
  isCacheMiss,
  needsCompaction,
  type CompactionInput,
} from '../src/shared/context-fit';
import { turnsSinceCompact } from '../src/renderer/ui/compact-turns';
import type { ChatMessage } from '../src/shared/api';

/**
 * Когда сжимать беседу. Логика живёт в shared, поэтому проверяем её без окна:
 * сжатие стоит отдельного запроса и обнуляет кеш, так что срабатывать не вовремя
 * (или не срабатывать вовремя) — это деньги, а не удобство.
 */

const WINDOW = 100_000;

/** Ничего не подозревающая беседа: короткая, кеш попадает. */
function input(overrides: Partial<CompactionInput> = {}): CompactionInput {
  return {
    used: 10_000,
    limit: WINDOW,
    reserve: 1_000,
    usage: { promptTokens: 10_000, completionTokens: 100, cachedTokens: 9_000 },
    usageFresh: true,
    ...overrides,
  };
}

describe('needsCompaction', () => {
  it('обычная беседа не сжимается', () => {
    expect(needsCompaction(input())).toBeNull();
  });

  it('подход к окну — с запасом, а не «в упор»', () => {
    // 0.8 окна: 80 000 + резерв 1 000 > 80 000 — уже пора.
    expect(needsCompaction(input({ used: 80_000 }))).toBe('window');
    // За запасом: 70 000 + 1 000 < 80 000 — ещё нет.
    expect(needsCompaction(input({ used: 70_000 }))).toBeNull();
  });

  it('промах кеша — основной сигнал', () => {
    const miss = { promptTokens: 50_000, completionTokens: 100, cachedTokens: 1_000 };
    expect(needsCompaction(input({ used: 50_000, usage: miss }))).toBe('cache-miss');
  });

  it('окно важнее промаха: сообщение должно звать к делу', () => {
    const miss = { promptTokens: 50_000, completionTokens: 100, cachedTokens: 0 };
    expect(needsCompaction(input({ used: 90_000, usage: miss }))).toBe('window');
  });

  it('устаревший расход не судим', () => {
    const miss = { promptTokens: 50_000, completionTokens: 100, cachedTokens: 0 };
    expect(needsCompaction(input({ used: 50_000, usage: miss, usageFresh: false }))).toBeNull();
  });

  it('расписание: каждые N ходов', () => {
    expect(needsCompaction(input({ turnsEvery: 5, turnsSinceCompact: 4 }))).toBeNull();
    expect(needsCompaction(input({ turnsEvery: 5, turnsSinceCompact: 5 }))).toBe('turns');
    // 0 — расписание выключено, сколько бы ходов ни прошло.
    expect(needsCompaction(input({ turnsEvery: 0, turnsSinceCompact: 999 }))).toBeNull();
  });

  it('абсолютный потолок выключен по умолчанию', () => {
    expect(needsCompaction(input({ used: 500_000, limit: 1_000_000 }))).toBeNull();
    expect(needsCompaction(input({ used: 500_000, limit: 1_000_000, compactAtTokens: 100_000 }))).toBe('history');
  });

  it('без компактного сжатия промах кеша не повод', () => {
    const miss = { promptTokens: 50_000, completionTokens: 100, cachedTokens: 0 };
    // Локальная модель: префикс сократить нечем, сжатие только сожжёт деньги.
    expect(needsCompaction(input({ used: 50_000, usage: miss, compactCapable: false }))).toBeNull();
    // Пользователь сам запретил — тоже не повод.
    expect(needsCompaction(input({ used: 50_000, usage: miss, compactOnCacheMiss: false }))).toBeNull();
  });
});

describe('isCacheMiss', () => {
  it('маленький вход — не промах', () => {
    expect(isCacheMiss({ promptTokens: 500, completionTokens: 10, cachedTokens: 0 })).toBe(false);
  });

  it('провайдер молчит про кеш — судить не по чему', () => {
    expect(isCacheMiss({ promptTokens: 50_000, completionTokens: 10 })).toBe(false);
    expect(isCacheMiss(undefined)).toBe(false);
  });

  it('треть попаданий — уже промах, выше — нет', () => {
    expect(isCacheMiss({ promptTokens: 10_000, completionTokens: 10, cachedTokens: 3_000 })).toBe(false);
    expect(isCacheMiss({ promptTokens: 10_000, completionTokens: 10, cachedTokens: 2_999 })).toBe(true);
  });
});

describe('compactionMessage', () => {
  it('у каждой причины свой текст', () => {
    const texts = (['window', 'history', 'turns', 'cache-miss'] as const).map(compactionMessage);
    for (const text of texts) expect(text.length).toBeGreaterThan(10);
    expect(new Set(texts).size).toBe(4);
  });
});

describe('turnsSinceCompact', () => {
  const msg = (role: ChatMessage['role']): ChatMessage => ({ role, content: 'x' });

  it('считает вопросы человека после служебных двух', () => {
    // После сжатия история — ровно [резюме, «принято»]; они не ход.
    expect(turnsSinceCompact([msg('user'), msg('assistant')])).toBe(0);
    expect(
      turnsSinceCompact([msg('user'), msg('assistant'), msg('user'), msg('assistant'), msg('user'), msg('assistant')]),
    ).toBe(2);
  });

  it('шаги агента внутри хода не считаются ходами', () => {
    // Резюме и «принято», затем один вопрос и три ответа агента (вызовы
    // инструментов) — это один ход, а не три.
    const history = [
      msg('user'),
      msg('assistant'),
      msg('user'),
      msg('assistant'),
      msg('tool'),
      msg('assistant'),
      msg('tool'),
      msg('assistant'),
    ];
    expect(turnsSinceCompact(history)).toBe(1);
  });

  it('порог по умолчанию — разумный', () => {
    expect(COMPACT_EVERY_TURNS).toBeGreaterThan(0);
  });
});
