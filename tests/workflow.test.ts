import { describe, expect, it } from 'vitest';
import type { RunCodeAgentCall, RunCodeOutcome } from '../src/shared/run-code';
import { SUBAGENT_TOOLS } from '../src/shared/tools';
import {
  WORKFLOW_MAX_AGENTS,
  WORKFLOW_MAX_CHARS,
  WORKFLOW_MAX_DEPTH,
  createAgentGate,
  formatWorkflow,
  workflowProblem,
} from '../src/shared/workflow';

/**
 * `workflow`: что считается годным сценарием, как ограничивается число агентов и
 * как читается ответ. Запуск сценария проверяется отдельно
 * (`tests/workflow-run.test.ts`).
 *
 * Главное здесь — пределы. Сценарий в отличие от `run_code` умеет запускать
 * прогоны модели в цикле, и цена ошибки в его разборе не «пустой ответ», а сотня
 * оплаченных подзадач.
 */

const agent = (overrides: Partial<RunCodeAgentCall> = {}): RunCodeAgentCall => ({
  description: 'где живёт настройка',
  ok: true,
  summary: 'нашёл в config.ts',
  ms: 1_500,
  ...overrides,
});

const outcome = (overrides: Partial<RunCodeOutcome> = {}): RunCodeOutcome => ({
  value: 'настройка в config.ts',
  logs: '',
  calls: [],
  ms: 4_000,
  timedOut: false,
  truncated: false,
  agents: [agent()],
  ...overrides,
});

describe('какой сценарий годится', () => {
  it('обычный сценарий с агентом — годится', () => {
    expect(workflowProblem("const a = await agents.run({ prompt: 'найди X' });\nreturn a.text;")).toBeNull();
  });

  it('пачка агентов тоже годится', () => {
    expect(
      workflowProblem('const all = await agents.parallel([{ prompt: "a" }, { prompt: "b" }]);\nreturn all;'),
    ).toBeNull();
  });

  it('пустой сценарий объясняет, что нужно', () => {
    expect(workflowProblem('  \n ')).toContain('Сценарий пустой');
  });

  it('слишком длинный отвергается с числами', () => {
    expect(workflowProblem('x'.repeat(WORKFLOW_MAX_CHARS + 1))).toContain(String(WORKFLOW_MAX_CHARS));
  });

  it('модуль вместо тела: import и export не нужны', () => {
    expect(workflowProblem("import fs from 'node:fs';\nreturn 1;")).toContain('тело функции');
    expect(workflowProblem('export default 1;')).toContain('тело функции');
  });

  it('сценарий без агентов — это не сценарий, а дорогой способ ничего не сделать', () => {
    expect(workflowProblem('return 42;')).toContain('ни одного вызова агента');
  });

  it('инструментов в сценарии нет — и это сказано прямо', () => {
    const problem = workflowProblem("const f = await tools.read_file({ path: 'a.ts' });\nreturn f;");
    expect(problem).toContain('нет `tools`');
    // Подсказка ведёт туда, где инструменты действительно есть.
    expect(problem).toContain('run_code');
  });

  it('слово tools внутри строки не считается вызовом', () => {
    expect(
      workflowProblem("const note = 'tools.read_file';\nconst a = await agents.run({ prompt: note });\nreturn a;"),
    ).toBeNull();
  });
});

describe('очередь на одновременность', () => {
  it('держит предел и пускает следующего, как только место освободилось', async () => {
    const through = createAgentGate(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];

    const work = (id: number) =>
      through(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        order.push(id);
      });

    await Promise.all([work(1), work(2), work(3), work(4)]);

    expect(peak).toBe(2);
    expect(order.sort()).toEqual([1, 2, 3, 4]);
  });

  it('упавшая работа не занимает место навсегда', async () => {
    const through = createAgentGate(1);
    await expect(
      through(async () => {
        throw new Error('сбой агента');
      }),
    ).rejects.toThrow('сбой агента');
    await expect(through(async () => 'прошло')).resolves.toBe('прошло');
  });

  it('предел меньше единицы всё равно означает «по одному»', async () => {
    const through = createAgentGate(0);
    let active = 0;
    let peak = 0;
    await Promise.all(
      [1, 2].map((_) =>
        through(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(1);
  });
});

describe('ответ инструмента', () => {
  it('сводка называет агентов и время', () => {
    const { summary } = formatWorkflow(outcome({ agents: [agent(), agent({ description: 'второй' })] }));
    expect(summary).toBe('workflow: 2 агента за 4 с');
  });

  it('в разборе видно, кто работал и что вернул сценарий', () => {
    const { detail } = formatWorkflow(outcome());
    expect(detail).toContain('Агенты сценария:');
    expect(detail).toContain('1. «где живёт настройка» — 2 с: нашёл в config.ts');
    expect(detail).toContain('Что вернул сценарий:');
    expect(detail).toContain('настройка в config.ts');
  });

  it('упавший агент помечен, а не спрятан', () => {
    const { summary, detail } = formatWorkflow(outcome({ agents: [agent({ ok: false, summary: 'не нашёл' })] }));
    expect(summary).toContain('с ошибкой 1');
    expect(detail).toContain('✗ «где живёт настройка»');
  });

  it('упавший сценарий называет причину и стек', () => {
    const { summary, detail } = formatWorkflow(
      outcome({ error: 'agents is not defined', stack: 'at program.mjs:2:1', value: undefined }),
    );
    expect(summary).toBe('workflow: ошибка — agents is not defined');
    expect(detail).toContain('Сценарий упал: agents is not defined');
    expect(detail).toContain('at program.mjs:2:1');
    expect(detail).toContain('Исправь сценарий');
  });

  it('предел времени назван остановкой, а не ошибкой сценария', () => {
    const { summary, detail } = formatWorkflow(outcome({ timedOut: true, value: undefined }));
    expect(summary).toContain('остановлен по времени');
    expect(detail).toContain('не уложился в отведённое время');
  });

  it('сработавший предел агентов виден модели', () => {
    const { detail } = formatWorkflow(outcome({ agentsExceeded: true }));
    expect(detail).toContain(`Агентов больше предела (${WORKFLOW_MAX_AGENTS})`);
    expect(detail).toContain('не запускались');
  });

  it('обрезка честно названа', () => {
    expect(formatWorkflow(outcome({ truncated: true })).detail).toContain('не поместилась в потолок');
  });

  it('сценарий без агентов и без результата не выглядит пустотой', () => {
    const { detail } = formatWorkflow(outcome({ agents: [], value: undefined, logs: 'ничего не нашёл' }));
    expect(detail).not.toContain('Агенты сценария:');
    expect(detail).toContain('ничего не нашёл');
  });

  it('пустой результат — это «(пусто)», а не пропавшее поле', () => {
    expect(formatWorkflow(outcome({ value: '' })).detail).toContain('(пусто)');
  });
});

describe('глубина: агент не запускает ни агентов, ни сценариев', () => {
  it('предел глубины равен одному шагу', () => {
    expect(WORKFLOW_MAX_DEPTH).toBe(1);
  });

  it('в инструментах подзадачи нет ни task, ни workflow', () => {
    // Это и есть обещание «дерева прогонов не будет»: подзадача физически не
    // может раздать работу дальше, поэтому счёт агентов всегда конечен.
    expect(SUBAGENT_TOOLS.has('task')).toBe(false);
    expect(SUBAGENT_TOOLS.has('workflow')).toBe(false);
  });

  it('подзадача по-прежнему читает проект', () => {
    expect(SUBAGENT_TOOLS.has('read_file')).toBe(true);
    expect(SUBAGENT_TOOLS.has('search')).toBe(true);
  });
});
