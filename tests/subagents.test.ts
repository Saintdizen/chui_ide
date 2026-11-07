import { describe, expect, it } from 'vitest';
import {
  MAX_PARALLEL,
  MAX_TASKS,
  formatSubagentReport,
  parseSubagentTasks,
  runWithLimit,
  subagentBatchSize,
} from '../src/shared/subagents';

/**
 * Подзадачи агента: разбор аргументов `task` (одна или несколько), пул с
 * пределом и сводный отчёт.
 *
 * Проверяем то, что дорого переделать потом: что десяток подзадач не запустится
 * (каждая — прогон модели) и что одна упавшая не уносит с собой остальные.
 */
describe('parseSubagentTasks', () => {
  it('одна подзадача прежней формы', () => {
    expect(parseSubagentTasks({ prompt: 'где лежит X', description: 'Поиск X' })).toEqual({
      tasks: [{ description: 'Поиск X', prompt: 'где лежит X' }],
    });
  });

  it('без description подпись по умолчанию', () => {
    expect(parseSubagentTasks({ prompt: 'q' }).tasks[0]!.description).toBe('подзадача');
  });

  it('несколько подзадач списком', () => {
    const request = parseSubagentTasks({
      tasks: [{ description: 'Первая', prompt: 'q1' }, { prompt: 'q2' }],
    });
    expect(request.error).toBeUndefined();
    expect(request.tasks.map((task) => task.prompt)).toEqual(['q1', 'q2']);
    expect(request.tasks[1]!.description).toBe('подзадача');
  });

  it('пустой prompt в списке пропускается', () => {
    const request = parseSubagentTasks({
      tasks: [{ prompt: 'q1' }, { prompt: '   ' }, { description: 'без промпта' }],
    });
    expect(request.tasks).toHaveLength(1);
  });

  it('ничего не передали — понятный отказ', () => {
    const request = parseSubagentTasks({});
    expect(request.tasks).toEqual([]);
    expect(request.error).toContain('prompt');
    expect(request.error).toContain('tasks');
  });

  it('список без единой настоящей подзадачи — отказ', () => {
    expect(parseSubagentTasks({ tasks: [{}, null] }).error).toContain('prompt');
  });
});

describe('предел на раз', () => {
  it('больше MAX_TASKS за вызов не принимаем', () => {
    const many = Array.from({ length: MAX_TASKS + 1 }, (_, index) => ({ prompt: `q${index}` }));
    const request = parseSubagentTasks({ tasks: many });
    expect(request.tasks).toEqual([]);
    expect(request.error).toContain(String(MAX_TASKS));
  });

  it('ровно MAX_TASKS проходит', () => {
    const many = Array.from({ length: MAX_TASKS }, (_, index) => ({ prompt: `q${index}` }));
    expect(parseSubagentTasks({ tasks: many }).tasks).toHaveLength(MAX_TASKS);
  });

  it('размер пула не больше MAX_PARALLEL и не больше числа задач', () => {
    expect(subagentBatchSize(1)).toBe(1);
    expect(subagentBatchSize(2)).toBe(2);
    expect(subagentBatchSize(MAX_TASKS)).toBe(Math.min(MAX_PARALLEL, MAX_TASKS));
    expect(subagentBatchSize(0)).toBe(1);
  });
});

describe('runWithLimit', () => {
  it('держит предел одновременно работающих', async () => {
    let active = 0;
    let peak = 0;
    const result = await runWithLimit([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    });

    expect(peak).toBeLessThanOrEqual(2);
    expect(result.done.map((item) => item.value)).toEqual([2, 4, 6, 8, 10]);
    expect(result.failed).toEqual([]);
  });

  it('одна упавшая не отменяет остальные', async () => {
    const result = await runWithLimit([1, 2, 3], 3, async (value) => {
      if (value === 2) throw new Error('не смогла');
      return value;
    });

    expect(result.done.map((item) => item.index)).toEqual([0, 2]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.index).toBe(1);
  });

  it('ответы идут в порядке задач, а не в порядке финиша', async () => {
    const result = await runWithLimit([30, 10, 20], 3, async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return delay;
    });
    expect(result.done.map((item) => item.value)).toEqual([30, 10, 20]);
  });
});

describe('formatSubagentReport', () => {
  it('каждый отчёт под своим заголовком', () => {
    const text = formatSubagentReport([
      { description: 'Первая', text: 'нашла A' },
      { description: 'Вторая', text: 'нашла B' },
    ]);
    expect(text).toBe('## Первая\nнашла A\n\n## Вторая\nнашла B');
  });

  it('провал назван отдельным разделом: пустота читалась бы как «там ничего нет»', () => {
    const text = formatSubagentReport(
      [{ description: 'Первая', text: 'нашла A' }],
      [{ description: 'Вторая', reason: 'модель отказала' }],
    );
    expect(text).toContain('## Не удалось');
    expect(text).toContain('- Вторая: модель отказала');
  });
});
