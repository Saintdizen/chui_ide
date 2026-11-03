import { describe, expect, it } from 'vitest';

import { PauseGate } from '../src/main/ai/pause';

describe('пауза прогона', () => {
  it('без паузы ждать нечего', async () => {
    const gate = new PauseGate();
    await expect(gate.wait(new AbortController().signal)).resolves.toBe(false);
  });

  it('«продолжить» отпускает стоящий шаг', async () => {
    const gate = new PauseGate();
    gate.set(true);
    let released = false;
    const waiting = gate.wait(new AbortController().signal).then((waited) => {
      released = waited;
    });
    // Пока пауза стоит — шаг не пошёл.
    await Promise.resolve();
    expect(released).toBe(false);
    gate.set(false);
    await waiting;
    expect(released).toBe(true);
    expect(gate.isPaused).toBe(false);
  });

  it('стоп будит ожидание так же, как «продолжить»', async () => {
    const gate = new PauseGate();
    const controller = new AbortController();
    gate.set(true);
    const waiting = gate.wait(controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBe(true);
    // Пауза не снята — следующий прогон всё равно начнётся с работы: снимает сервис.
    expect(gate.isPaused).toBe(true);
  });
});
