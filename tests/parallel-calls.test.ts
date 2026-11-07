import { describe, expect, it } from 'vitest';
import { callOrder, planStepCalls } from '../src/shared/parallel-calls';

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

describe('что можно исполнять вместе', () => {
  it('два чтения разных файлов — вместе', () => {
    expect(callOrder('read', JSON.stringify({ path: '/a.ts' }))).toBe('group');
  });

  it('правка — только одна', () => {
    expect(callOrder('edit', JSON.stringify({ path: '/a.ts' }))).toBe('alone');
  });

  it('терминал — только по очереди, даже чтение', () => {
    expect(callOrder('terminal', JSON.stringify({ action: 'read' }))).toBe('alone');
  });

  it('lsp и checks — по очереди: один сервер на всех', () => {
    expect(callOrder('lsp', JSON.stringify({ action: 'outline' }))).toBe('alone');
    expect(callOrder('checks', JSON.stringify({ action: 'diagnostics' }))).toBe('alone');
  });

  it('картинка едет отдельным сообщением — только одна', () => {
    expect(callOrder('read_image', JSON.stringify({ path: '/a.png' }))).toBe('alone');
  });
});

describe('план шага', () => {
  it('одно чтение — одна группа', () => {
    const plan = planStepCalls([call('1', 'read', { path: '/a.ts' })]);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toHaveLength(1);
  });

  it('соседние чтения разных файлов собираются в одну группу', () => {
    const plan = planStepCalls([
      call('1', 'read', { path: '/a.ts' }),
      call('2', 'read', { path: '/b.ts' }),
      call('3', 'read', { path: '/c.ts' }),
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.map((item) => item.id)).toEqual(['1', '2', '3']);
  });

  it('один и тот же файл — разные группы: чтение и правка зависят от порядка', () => {
    const plan = planStepCalls([
      call('1', 'read', { path: '/a.ts' }),
      call('2', 'read', { path: '/a.ts' }),
    ]);
    expect(plan).toHaveLength(2);
  });

  it('правка разрывает пачку чтений', () => {
    const plan = planStepCalls([
      call('1', 'read', { path: '/a.ts' }),
      call('2', 'edit', { path: '/a.ts' }),
      call('3', 'read', { path: '/a.ts' }),
    ]);
    expect(plan.map((group) => group.map((item) => item.id))).toEqual([['1'], ['2'], ['3']]);
  });

  it('порядок групп — порядок модели', () => {
    const plan = planStepCalls([
      call('1', 'terminal', { action: 'run', command: 'ls' }),
      call('2', 'read', { path: '/a.ts' }),
      call('3', 'read', { path: '/b.ts' }),
    ]);
    expect(plan.map((group) => group.map((item) => item.id))).toEqual([['1'], ['2', '3']]);
  });

  it('пустой список — пустой план', () => {
    expect(planStepCalls([])).toEqual([]);
  });
});
