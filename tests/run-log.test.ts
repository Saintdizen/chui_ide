import { describe, expect, it } from 'vitest';
import {
  MAX_RUN_FIELD,
  clampRunText,
  describeRun,
  formatDuration,
  plural,
  runTruncated,
  type ChatRunLog,
} from '../src/shared/run-log';

/**
 * Трасса прогона: подписи, длительности и потолки.
 *
 * Собирает трассу main, показывает renderer, а проверяется здесь то, что у них
 * общее: как число миллисекунд превращается в «5 м 24 с», как считается строка
 * итога и где обрезается текст. Ошибка в подписи выглядит как враньё о работе
 * агента, поэтому проверяем и крайние случаи.
 */

const log = (overrides: Partial<ChatRunLog> = {}): ChatRunLog => ({
  startedAt: 0,
  ms: 324_000,
  steps: [],
  system: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    mode: 'agent',
    permission: 'ask',
    tools: 24,
  },
  finished: 'answer',
  trace: { steps: 6, toolCalls: 14, usage: { promptTokens: 30_000, completionTokens: 11_400 } },
  ...overrides,
});

describe('длительность словами', () => {
  it('до секунды — в миллисекундах', () => {
    expect(formatDuration(0)).toBe('0 мс');
    expect(formatDuration(820)).toBe('820 мс');
    expect(formatDuration(999)).toBe('999 мс');
  });

  it('секунды, минуты и часы', () => {
    expect(formatDuration(1000)).toBe('1 с');
    expect(formatDuration(12_400)).toBe('12 с');
    expect(formatDuration(60_000)).toBe('1 м');
    expect(formatDuration(84_000)).toBe('1 м 24 с');
    // Тот самый случай из объявления: прогон на 5 минут 24 секунды.
    expect(formatDuration(324_000)).toBe('5 м 24 с');
    expect(formatDuration(3_600_000)).toBe('1 ч');
    // Минуты часа дополняются нулём: «1 ч 05 м» читается как время, «1 ч 5 м» — как счёт.
    expect(formatDuration(3_900_000)).toBe('1 ч 05 м');
  });

  it('мусор на входе не превращается в число', () => {
    expect(formatDuration(-5)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('итог прогона одной строкой', () => {
  it('называет время, шаги, вызовы и токены', () => {
    expect(describeRun(log())).toBe('5 м 24 с · 6 шагов · 14 вызовов · 41\u00a0400 токенов');
  });

  it('без вызовов и токенов строка короче, а не с нулями', () => {
    const quiet = log({
      ms: 1500,
      steps: [{ index: 1, ms: 1500, calls: [] }],
      trace: { steps: 1, toolCalls: 0, usage: {} },
    });
    expect(describeRun(quiet)).toBe('2 с · 1 шаг');
  });

  it('склонение совпадает с числом', () => {
    expect([1, 2, 5, 11, 21, 22, 25].map((count) => plural(count, 'шаг', 'шага', 'шагов'))).toEqual([
      '1 шаг',
      '2 шага',
      '5 шагов',
      '11 шагов',
      '21 шаг',
      '22 шага',
      '25 шагов',
    ]);
  });
});

describe('потолки трассы', () => {
  it('короткий текст не трогаем', () => {
    expect(clampRunText('git status', 100)).toBe('git status');
  });

  it('длинный обрезаем и помечаем', () => {
    const text = clampRunText('а'.repeat(MAX_RUN_FIELD + 500));
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_RUN_FIELD + 1);
  });

  it('обрезка не режет символ пополам', () => {
    // Эмодзи занимает две единицы UTF-16: срез по индексу оставил бы половину.
    const text = clampRunText('🙂'.repeat(10), 3);
    expect(text).toBe('🙂🙂🙂…');
    expect(text.includes('\uFFFD')).toBe(false);
  });

  it('трасса считается обрезанной, если что-то не поместилось', () => {
    expect(runTruncated(log())).toBe(false);
    expect(runTruncated(log({ steps: [{ index: 1, ms: 10, calls: [], hiddenCalls: 3 }] }))).toBe(true);
    expect(runTruncated(log({ steps: [{ index: 1, ms: 10, calls: [], text: 'обрезано…' }] }))).toBe(true);
  });
});
