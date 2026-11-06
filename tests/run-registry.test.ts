import { describe, expect, it } from 'vitest';
import { RunRegistry, abortOfRun } from '../src/main/ai/run-registry';

describe('опись прогонов', () => {
  it('инструмент снимается и отменой прогона, и сам по себе', () => {
    const registry = new RunRegistry();
    const run = registry.start('call-1', 'conv-a');
    const toolAbort = registry.toolStart('call-1', 'terminal')!;

    expect(toolAbort.signal.aborted).toBe(false);
    run.abort.abort();
    // Отмена прогона доходит до инструмента: это весь смысл описи.
    expect(toolAbort.signal.aborted).toBe(true);
  });

  it('отмена одного инструмента не гасит прогон', () => {
    const registry = new RunRegistry();
    const run = registry.start('call-1', 'conv-a');
    const read = registry.toolStart('call-1', 'read')!;

    expect(registry.abortTool('call-1', 'read')).toBe(true);
    expect(read.signal.aborted).toBe(true);
    expect(run.abort.signal.aborted).toBe(false);
  });

  it('финиш прогона гасит оставшиеся инструменты и убирает запись', () => {
    const registry = new RunRegistry();
    registry.start('call-1', 'conv-a');
    const terminal = registry.toolStart('call-1', 'terminal')!;

    registry.finish('call-1');
    expect(terminal.signal.aborted).toBe(true);
    expect(registry.find('call-1')).toBeUndefined();
    expect(registry.snapshot().runs).toBe(0);
  });

  it('по беседе находятся все её прогоны', () => {
    const registry = new RunRegistry();
    registry.start('call-1', 'conv-a');
    registry.start('call-2', 'conv-a');
    registry.start('call-3', 'conv-b');

    expect(registry.forConversation('conv-a')).toHaveLength(2);
  });

  it('снимок считает возраст самого старого инструмента', () => {
    const registry = new RunRegistry();
    registry.start('call-1', 'conv-a');
    registry.toolStart('call-1', 'terminal', 1000);
    registry.toolStart('call-1', 'read', 5000);

    const snapshot = registry.snapshot(9000);
    expect(snapshot.tools[0]!.names).toEqual(['terminal', 'read']);
    // 8000, а не 4000: возраст — по тому, что начался раньше.
    expect(snapshot.tools[0]!.runningMs).toBe(8000);
  });

  it('abortAll гасит всё и говорит, сколько было', () => {
    const registry = new RunRegistry();
    const first = registry.start('call-1', 'conv-a');
    const second = registry.start('call-2', 'conv-b');

    expect(registry.abortAll()).toBe(2);
    expect(first.abort.signal.aborted).toBe(true);
    expect(second.abort.signal.aborted).toBe(true);
  });

  it('сигнал окна гасит и прогон в описи', () => {
    const outer = new AbortController();
    const run = new RunRegistry().start('call-1', 'conv-a', abortOfRun(outer.signal));
    outer.abort();
    expect(run.abort.signal.aborted).toBe(true);
  });
});
