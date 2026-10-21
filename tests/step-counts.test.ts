import { describe, expect, it } from 'vitest';
import { buildCountsRecord, callFlags, formatCountsLine, parseCounts } from '../src/shared/step-counts';
import type { ChatRunLog } from '../src/shared/run-log';

function run(overrides: Partial<ChatRunLog> = {}): ChatRunLog {
  return {
    startedAt: 1_700_000_000_000,
    ms: 12_000,
    finished: 'answer',
    system: {
      provider: 'anthropic',
      model: 'claude',
      mode: 'agent',
      permission: 'full',
      tools: 17,
    },
    trace: { steps: 2, toolCalls: 3, usage: { promptTokens: 100, cachedTokens: 96, completionTokens: 40 } },
    steps: [
      {
        index: 1,
        ms: 5_000,
        usage: { promptTokens: 50, cachedTokens: 48, completionTokens: 20 },
        outputTokens: 300,
        calls: [
          { id: 'a', name: 'read', args: '{"path":"src/a.ts"}', ok: true, summary: 'x'.repeat(88) },
          {
            id: 'b',
            name: 'terminal',
            args: '{"command":"cd /home/x && grep foo src/a.ts"}',
            ok: false,
            summary: 'код выхода 1',
            note: 'отказ',
            ms: 120,
          },
        ],
      },
      {
        index: 2,
        ms: 7_000,
        outputTokens: 120,
        hiddenCalls: 3,
        calls: [{ id: 'c', name: 'edit', args: '{"action":"write"}', ok: true, summary: 'ok', detail: 'done' }],
      },
    ],
    ...overrides,
  };
}

describe('счётчик шагов', () => {
  it('не несёт текстов переписки: только имена, числа и пометки', () => {
    const record = buildCountsRecord(run(), { conversation: 'uid' });
    const text = formatCountsLine(record);
    // Ни инструкций, ни контекста проекта, ни ответа шага — их в записи нет вовсе.
    expect(text).not.toContain('xxxx');
    expect(text).not.toContain('done');
    expect(record.conversation).toBe('uid');
    expect(record.steps.map((step) => step.i)).toEqual([1, 2]);
    expect(record.steps[1]!.hiddenCalls).toBe(3);
  });

  it('считает цену вызова в символах, а шага — в токенах провайдера', () => {
    const record = buildCountsRecord(run());
    const [first, second] = record.steps;
    const [read, terminal] = first!.calls;
    expect(read!.chars).toBe(88);
    expect(terminal!.ok).toBe(false);
    expect(terminal!.ms).toBe(120);
    expect(second!.out).toBe(120);
    expect(record.trace).toEqual({ steps: 2, toolCalls: 3, prompt: 100, cached: 96, output: 40 });
  });

  it('подписывает форму вызова: cd, шелл вместо read, целое чтение, пачка', () => {
    expect(callFlags('terminal', '{"command":"cd /abs && ls"}')).toEqual(['cd']);
    expect(callFlags('terminal', '{"command":"grep -n foo src/a.ts"}')).toEqual(['shell-read']);
    expect(callFlags('read', '{"path":"src/a.ts"}')).toEqual(['whole-read']);
    expect(callFlags('read', '{"path":"src/a.ts","startLine":10,"endLine":20}')).toEqual([]);
    expect(callFlags('read', '{"paths":["a","b"]}')).toEqual(['paths']);
    // Испорченные аргументы — тоже данные: пометок у них нет, но и падения тоже.
    expect(callFlags('read', '{"path":')).toEqual([]);
  });

  it('переживает обрыв записи в журнале', () => {
    const line = formatCountsLine(buildCountsRecord(run()));
    const records = parseCounts(`${line}\n{"version":1,"steps":[\n`);
    expect(records).toHaveLength(1);
    expect(parseCounts('')).toEqual([]);
  });
});
