import { describe, expect, it } from 'vitest';
import { createSymbolPoller, type SymbolPoller, type SymbolPollStatus } from '../src/renderer/core/symbol-poll';

/** Таймеры вручную: иначе test шёл бы в реальном времени. */
function setup(responses: Array<SymbolPollStatus | Error>) {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  const shown: SymbolPollStatus[] = [];
  const asked: number[] = [];

  const poller: SymbolPoller = createSymbolPoller({
    request: async () => {
      asked.push(1);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next ?? { phase: 'ready' };
    },
    show: (status) => shown.push(status),
    intervalMs: 1000,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });

  /** Дать отработать промису `request`, затем выполнить назначенный таймер. */
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  const fire = () => {
    const [id, timer] = [...timers.entries()][0] ?? [];
    if (id === undefined || !timer) return false;
    timers.delete(id);
    timer.fn();
    return true;
  };

  return { poller, timers, shown, asked, flush, fire };
}

describe('createSymbolPoller', () => {
  it('на warming назначает следующий опрос', async () => {
    const t = setup([{ phase: 'warming' }, { phase: 'ready' }]);
    t.poller.poll();
    await t.flush();
    expect(t.shown).toEqual([{ phase: 'warming' }]);
    expect(t.timers.size).toBe(1);
    expect(t.timers.values().next().value?.ms).toBe(1000);
  });

  it('на готовой карте таймера нет', async () => {
    const t = setup([{ phase: 'ready' }]);
    t.poller.poll();
    await t.flush();
    expect(t.timers.size).toBe(0);
    expect(t.poller.polling()).toBe(false);
  });

  it('цепочка: каждый таймер ведёт к одному следующему опросу', async () => {
    const t = setup([{ phase: 'warming' }, { phase: 'warming' }, { phase: 'ready' }]);
    t.poller.poll();
    await t.flush();
    expect(t.asked.length).toBe(1);
    t.fire();
    await t.flush();
    expect(t.asked.length).toBe(2);
    t.fire();
    await t.flush();
    expect(t.asked.length).toBe(3);
    expect(t.timers.size).toBe(0);
  });

  it('два poll подряд не дают двух цепочек', async () => {
    const t = setup([{ phase: 'warming' }, { phase: 'warming' }]);
    t.poller.poll();
    await t.flush();
    t.poller.poll();
    await t.flush();
    // Второй poll снял свой таймер? Нет: он не должен был завести второй.
    expect(t.timers.size).toBe(1);
  });

  it('ошибка опроса останавливает цикл', async () => {
    const t = setup([new Error('main не отвечает')]);
    t.poller.poll();
    await t.flush();
    expect(t.poller.polling()).toBe(false);
    expect(t.timers.size).toBe(0);
  });

  it('stop снимает таймер', async () => {
    const t = setup([{ phase: 'warming' }]);
    t.poller.poll();
    await t.flush();
    expect(t.poller.polling()).toBe(true);
    t.poller.stop();
    expect(t.poller.polling()).toBe(false);
  });

  it('после stop новый poll начинает заново', async () => {
    const t = setup([{ phase: 'warming' }, { phase: 'ready' }]);
    t.poller.poll();
    await t.flush();
    t.poller.stop();
    t.poller.poll();
    await t.flush();
    expect(t.asked.length).toBe(2);
  });
});
