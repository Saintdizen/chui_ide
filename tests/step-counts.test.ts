import { describe, expect, it } from 'vitest';
import {
  buildCountsRecord,
  callFailureReason,
  callFlags,
  formatCountsLine,
  parseCounts,
} from '../src/shared/step-counts';
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
    expect(record.trace).toEqual({
      steps: 2,
      toolCalls: 3,
      prompt: 100,
      cached: 96,
      output: 40,
      cacheCreation: 0,
    });
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

  it('кодирует причину отказа без текста ошибки', () => {
    const log = run();
    log.steps[0]!.calls = [
      { id: 'a', name: 'mind', args: '{"action":""}', ok: false, summary: 'Неизвестное действие: ' },
      { id: 'b', name: 'edit', args: '{}', ok: false, summary: 'Не хватает аргумента', detail: 'Передай oldText' },
      { id: 'c', name: 'terminal', args: '{}', ok: false, summary: 'код выхода 1' },
      { id: 'd', name: 'read', args: '{}', ok: false, summary: 'Файл не найден: a.ts' },
      // Якорь — до `not-found`: отказ правки тоже говорит «не найден», но чинится
      // он другим якорем, а не перечитыванием пути.
      {
        id: 'e',
        name: 'edit',
        args: '{}',
        ok: false,
        summary: 'ошибка правки',
        detail: 'текст «return 1» в файле не найден.',
      },
      { id: 'f', name: 'edit', args: '{}', ok: false, summary: 'Правки не применены', detail: 'правка не применена' },
      {
        id: 'g',
        name: 'ask',
        args: '{}',
        ok: false,
        summary: 'Ответа нет',
        detail: 'Человек не ответил: вопрос отклонили',
      },
      { id: 'h', name: 'edit', args: '{}', ok: false, summary: 'Не задан аргумент «contents»' },
      // Наши собственные формы отказов — со строчной буквы. До 29.10 они оседали
      // в «other», и причина 76% отказов `edit` была неведома.
      { id: 'i', name: 'edit', args: '{}', ok: false, summary: 'edits[0].edits[0].newText: нужна строка' },
      { id: 'j', name: 'edit', args: '{}', ok: false, summary: 'edits[0]: не задан path.' },
      { id: 'k', name: 'edit', args: '{}', ok: false, summary: 'edits[0].edits: нужен непустой массив правок.' },
    ];
    const record = buildCountsRecord(log);
    expect(record.steps[0]!.calls.map((item) => item.reason)).toEqual([
      'action',
      'arg',
      'command',
      'not-found',
      'anchor',
      'anchor',
      'rejected',
      'arg',
      'arg',
      'arg',
      'arg',
    ]);
    expect(callFailureReason({ ok: true, summary: 'ok' })).toBe('other');
  });

  it('размечает повторы и смысловые пересечения в одном шаге', () => {
    const log = run();
    log.steps[0]!.calls = [
      { id: 'a', name: 'search', args: '{"action":"code","query":"User"}', ok: true, summary: '1' },
      { id: 'b', name: 'lsp', args: '{"action":"definition","symbol":"User"}', ok: true, summary: '2' },
      { id: 'c', name: 'read', args: '{"path":"src/a.ts"}', ok: true, summary: '3' },
      { id: 'd', name: 'search', args: '{"query":"User","action":"code"}', ok: true, summary: '4' },
    ];
    const record = buildCountsRecord(log);
    expect(record.steps[0]!.overlaps).toEqual([{ a: 0, b: 1, kind: 'search-lsp' }]);
    expect(record.steps[0]!.calls[3]!.flags).toContain('repeat');
    expect(record.steps[0]!.calls[0]!.flags ?? []).not.toContain('repeat');
  });
});
