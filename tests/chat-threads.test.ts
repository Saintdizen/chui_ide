import { describe, expect, it } from 'vitest';
import { describeThread, summarizeThreads, threadState } from '../src/shared/chat-threads';

const trace = (prompt: number, completion: number) => ({
  steps: 1,
  toolCalls: 0,
  usage: { promptTokens: prompt, completionTokens: completion },
});

describe('нить работы: состояние и цена', () => {
  it('идёт важнее всего остального', () => {
    expect(threadState({ id: 1, running: true, hasHistory: true, failed: true, paused: true })).toBe('running');
  });

  it('упавший прогон перебивает паузу, но не идущий', () => {
    expect(threadState({ id: 1, running: false, hasHistory: true, failed: true, paused: true })).toBe('failed');
  });

  it('пустая нить отличается от готовой', () => {
    expect(threadState({ id: 1, running: false, hasHistory: false })).toBe('empty');
    expect(threadState({ id: 1, running: false, hasHistory: true })).toBe('idle');
  });

  it('цена берётся из следов прогона и читается словами', () => {
    const info = describeThread({
      id: 7,
      running: false,
      hasHistory: true,
      model: 'gpt-4o',
      trace: trace(1000, 500),
    });
    expect(info.cost).toBeGreaterThan(0);
    expect(info.costText).toBeTruthy();
  });

  it('без модели или без следов цену не выдумываем', () => {
    expect(describeThread({ id: 1, running: false, hasHistory: true, trace: trace(1000, 500) }).cost).toBeNull();
    expect(describeThread({ id: 1, running: false, hasHistory: true, model: 'gpt-4o' }).cost).toBeNull();
  });
});

describe('сводка по нитям', () => {
  it('считает по состояниям и складывает цену', () => {
    const threads = [
      describeThread({ id: 1, running: true, hasHistory: true, model: 'gpt-4o', trace: trace(1000, 500) }),
      describeThread({ id: 2, running: true, hasHistory: true }),
      describeThread({ id: 3, running: false, hasHistory: true }),
      describeThread({ id: 4, running: false, hasHistory: false }),
    ];

    const summary = summarizeThreads(threads);
    expect(summary.running).toBe(2);
    expect(summary.waiting).toBe(0);
    expect(summary.text).toBe('2 идут');
    // Пустые в сводку не входят.
    expect(summary.text).not.toContain('пусто');
  });

  it('одна нить — «идёт», а не «идут»', () => {
    const threads = [describeThread({ id: 1, running: true, hasHistory: true })];
    expect(summarizeThreads(threads).text).toBe('1 идёт');
  });

  it('цен нет — сумма null, а не ноль', () => {
    const threads = [describeThread({ id: 1, running: false, hasHistory: true })];
    expect(summarizeThreads(threads).cost).toBeNull();
  });
});
