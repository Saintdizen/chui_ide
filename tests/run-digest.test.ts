import { describe, expect, it } from 'vitest';

import { digestRuns, digestLine } from '../src/shared/run-digest';
import type { RunTelemetryRecord } from '../src/shared/telemetry';
import type { RunStepLog } from '../src/shared/run-log';

/**
 * Сводка прогонов — ответ на вопрос «что не получилось в этои беседе».
 *
 * Журнал уже лежит в файле построчно, но каждая строка — один прогон целиком,
 * а беседа — их несколько подряд. Человек идёт с вопросом про беседу, поэтому
 * группируем и суммируем, а не листаем.
 */

function step(over: Partial<RunStepLog>): RunStepLog {
  return { index: 1, ms: 1000, calls: [], ...over } as RunStepLog;
}

function record(over: Partial<RunTelemetryRecord>): RunTelemetryRecord {
  return {
    version: 1,
    at: Date.parse('2026-01-01T10:00:00Z'),
    startedAt: Date.parse('2026-01-01T09:59:00Z'),
    provider: 'openai',
    model: 'gpt-4o',
    mode: 'agent',
    permission: 'edit',
    finished: 'answer',
    ms: 60_000,
    trace: { steps: 1, toolCalls: 0, usage: { promptTokens: 100, completionTokens: 20 } },
    system: {} as RunTelemetryRecord['system'],
    steps: [],
    ...over,
  } as RunTelemetryRecord;
}

describe('digestRuns', () => {
  it('прогоны одной беседы собраны вместе', () => {
    const digests = digestRuns([
      record({ conversation: 'a', at: 1 }),
      record({ conversation: 'b', at: 2 }),
      record({ conversation: 'a', at: 3 }),
    ]);
    expect(digests).toHaveLength(2);
    expect(digests.find((d) => d.conversation === 'a')!.runs).toBe(2);
  });

  it('сводка идёт от свежего к старому', () => {
    const digests = digestRuns([record({ conversation: 'old', at: 1 }), record({ conversation: 'new', at: 9 })]);
    expect(digests.map((d) => d.conversation)).toEqual(['new', 'old']);
  });

  it('токены и вызовы суммируются, а не берётся последний', () => {
    const [digest] = digestRuns([
      record({ trace: { steps: 2, toolCalls: 3, usage: { promptTokens: 100, completionTokens: 10 } } }),
      record({ trace: { steps: 1, toolCalls: 4, usage: { promptTokens: 50, completionTokens: 5 } } }),
    ]);
    expect(digest!.tokens.prompt).toBe(150);
    expect(digest!.tokens.completion).toBe(15);
    expect(digest!.toolCalls).toBe(7);
  });

  it('неудачный вызов попадает в проблемы с названием инструмента', () => {
    const [digest] = digestRuns([
      record({
        steps: [
          step({
            calls: [
              { id: '1', name: 'run_command', args: '{}', ok: true, summary: 'ok' } as never,
              { id: '2', name: 'apply_edits', args: '{}', ok: false, summary: 'файл не найден' } as never,
            ],
          }),
        ],
      }),
    ]);
    expect(digest!.failures).toHaveLength(1);
    expect(digest!.failures[0]).toMatchObject({ tool: 'apply_edits', why: 'файл не найден' });
  });

  it('«не смог» и «сделал, но плохо» — разные проблемы', () => {
    const [digest] = digestRuns([
      record({
        steps: [
          step({
            calls: [
              { id: '1', name: 'run_command', args: '{}', ok: true, failed: true, summary: 'тесты упали' } as never,
            ],
          }),
        ],
      }),
    ]);
    expect(digest!.failures[0]).toMatchObject({ tool: 'run_command', why: 'тесты упали' });
  });

  it('один и тот же провал дважды — одна строка со счётчиком', () => {
    const call = { id: '1', name: 'read_file', args: '{}', ok: false, summary: 'нет файла' };
    const [digest] = digestRuns([record({ steps: [step({ calls: [call, { ...call, id: '2' }] as never })] })]);
    expect(digest!.failures).toHaveLength(1);
    expect(digest!.failures[0]!.count).toBe(2);
  });

  it('обрыв по лимиту шагов виден отдельно от ответа', () => {
    const [digest] = digestRuns([record({ finished: 'answer' }), record({ finished: 'limit' })]);
    expect(digest!.finished).toEqual({ answer: 1, limit: 1, aborted: 0 });
  });

  it('записи без беседы не теряются', () => {
    const digests = digestRuns([record({}), record({})]);
    expect(digests).toHaveLength(1);
    expect(digests[0]!.conversation).toBeNull();
    expect(digests[0]!.runs).toBe(2);
  });

  it('без записей — пусто, а не пустая группа', () => {
    expect(digestRuns([])).toEqual([]);
  });
});

describe('digestLine', () => {
  it('говорит итог, а не только числа', () => {
    const [digest] = digestRuns([
      record({
        totalMs: 90_000,
        ms: 90_000,
        trace: { steps: 3, toolCalls: 2, usage: { promptTokens: 1200, completionTokens: 340 } },
      } as never),
    ]);
    const line = digestLine(digest!);
    expect(line).toContain('1 прогон');
    expect(line).toContain('1540');
  });

  it('показывает, сколько входа взято из кэша провайдера', () => {
    const [digest] = digestRuns([
      record({
        trace: {
          steps: 2,
          toolCalls: 1,
          usage: { promptTokens: 8000, completionTokens: 200, cachedTokens: 4000 },
        },
      } as never),
    ]);
    const line = digestLine(digest!);
    expect(line).toContain('из кэша');
    expect(line).toContain('49%');
    // Токены на шаг: 8200 / 2 — по ним видно, дорого ли идёт беседа.
    expect(line).toContain('4100 на шаг');
  });

  it('без токенов не выдумывает нули', () => {
    const [digest] = digestRuns([record({ trace: { steps: 1, toolCalls: 0, usage: {} } })]);
    expect(digestLine(digest!)).not.toContain('токен');
  });
});
