import { describe, expect, it } from 'vitest';
import { describeDay, describeSpend, startOfDay, summarizeSpend } from '../src/shared/spend';
import type { RunTelemetryRecord } from '../src/shared/telemetry';

/**
 * Сводка расхода. Проверяем три вещи, на которых легко соврать:
 * границу дня (местную, а не UTC), строки по моделям и честное «цена неизвестна»
 * вместо частичной суммы.
 */

function run(
  at: number,
  model: string,
  usage: { promptTokens?: number; completionTokens?: number },
  provider = 'openai',
): RunTelemetryRecord {
  return {
    provider,
    model,
    at,
    trace: { usage },
  } as unknown as RunTelemetryRecord;
}

// Полдень понятного дня: вокруг него и строим границы.
const NOON = new Date(2026, 10, 7, 12, 0, 0).getTime();

it('начало дня — местная полночь', () => {
  const start = startOfDay(NOON);
  expect(new Date(start).getHours()).toBe(0);
  expect(start).toBeLessThan(NOON);
  expect(start + 24 * 60 * 60 * 1000).toBeGreaterThan(NOON);
});

describe('summarizeSpend', () => {
  it('берёт только свой день: вчерашнее не мешает сегодняшнему', () => {
    const today = run(NOON, 'gpt-4o', { promptTokens: 1000, completionTokens: 500 });
    const yesterday = run(startOfDay(NOON) - 1, 'gpt-4o', { promptTokens: 9999 });
    const summary = summarizeSpend([today, yesterday], NOON);
    expect(summary.runs).toBe(1);
    expect(summary.usage.promptTokens).toBe(1000);
  });

  it('окно из двух дней включает вчера', () => {
    const today = run(NOON, 'gpt-4o', { promptTokens: 10 });
    const yesterday = run(startOfDay(NOON) - 1, 'gpt-4o', { promptTokens: 5 });
    expect(summarizeSpend([today, yesterday], NOON, { days: 2 }).usage.promptTokens).toBe(15);
  });

  it('строки по модели и провайдеру, дорогое сверху', () => {
    const expensive = run(NOON, 'gpt-4o', { promptTokens: 100_000, completionTokens: 100_000 });
    const cheap = run(NOON, 'gpt-4o-mini', { promptTokens: 100_000, completionTokens: 100_000 });
    const rows = summarizeSpend([cheap, expensive], NOON).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.model).toBe('gpt-4o');
    expect(rows[0]!.runs).toBe(1);
  });

  it('один и тот же gpt-4o у разных провайдеров — разные строки', () => {
    const rows = summarizeSpend(
      [run(NOON, 'gpt-4o', { promptTokens: 100 }, 'openai'), run(NOON, 'gpt-4o', { promptTokens: 100 }, 'azure')],
      NOON,
    ).rows;
    expect(rows).toHaveLength(2);
  });

  it('неизвестная модель — цена null, а не частичная сумма', () => {
    const summary = summarizeSpend(
      [run(NOON, 'gpt-4o', { promptTokens: 1000 }), run(NOON, 'какая-то-модель', { promptTokens: 1000 })],
      NOON,
    );
    expect(summary.cost).toBeNull();
    expect(summary.unpricedRuns).toBe(1);
    expect(summary.runs).toBe(2);
  });

  it('пустой журнал — ноль прогонов, а не ошибка', () => {
    const summary = summarizeSpend([], NOON);
    expect(summary.runs).toBe(0);
    expect(summary.rows).toEqual([]);
    expect(describeSpend(summary)).toBe('за это время прогонов не было');
  });
});

describe('подписи', () => {
  it('день словами', () => {
    expect(describeDay(NOON, NOON)).toBe('сегодня');
    expect(describeDay(startOfDay(NOON) - 1, NOON)).toBe('вчера');
    expect(describeDay(startOfDay(NOON) - 2 * 24 * 60 * 60 * 1000, NOON)).toContain('5');
  });

  it('строка сводки называет самого дорогого', () => {
    const summary = summarizeSpend([run(NOON, 'gpt-4o', { promptTokens: 1000, completionTokens: 100 })], NOON);
    expect(describeSpend(summary)).toContain('gpt-4o');
    expect(describeSpend(summary)).toContain('вход 1000');
  });
});
