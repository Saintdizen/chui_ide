import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installMiniDom } from './helpers/mini-dom';
import { createChatRunning, runningAge, runningLabel } from '../src/renderer/ui/chat-running';

beforeAll(() => installMiniDom());

const snapshot = (names: string[], runningMs = 12000) => ({
  runs: 1,
  tools: [{ callId: 'c', conversation: 'conv', names, runningMs }],
});

describe('возраст инструмента', () => {
  it('до минуты — секундами, дальше — минутами', () => {
    expect(runningAge(0)).toBe('0 с');
    expect(runningAge(12000)).toBe('12 с');
    expect(runningAge(60000)).toBe('1 мин');
    expect(runningAge(80000)).toBe('1 мин 20 с');
  });

  it('отрицательное время не превращается в минус', () => {
    expect(runningAge(-5000)).toBe('0 с');
  });
});

describe('строка полосы', () => {
  it('пустой снимок — пустая строка', () => {
    expect(runningLabel(null)).toBe('');
    expect(runningLabel({ runs: 0, tools: [] })).toBe('');
  });

  it('длинный список укорачивается, но не молчит о хвосте', () => {
    expect(runningLabel(snapshot(['terminal', 'read', 'edit', 'search', 'web']))).toBe(
      'terminal, read, edit и ещё 2 · 12 с',
    );
  });
});

describe('полоса «что ещё идёт»', () => {
  it('показывает имя и возраст, а при пустом снимке прячется', async () => {
    let response = snapshot(['terminal']);
    const view = createChatRunning({ snapshot: async () => response, abort: () => undefined });

    view.refresh();
    await vi.waitFor(() => expect(view.element.hidden).toBe(false));
    expect(view.element.textContent).toContain('terminal');
    expect(view.element.textContent).toContain('12 с');

    response = { runs: 0, tools: [] };
    view.refresh();
    await vi.waitFor(() => expect(view.element.hidden).toBe(true));
  });

  it('неудачный спрос прячет полосу, а не показывает вчерашнее', async () => {
    let failing = false;
    const view = createChatRunning({
      snapshot: async () => {
        if (failing) throw new Error('нет');
        return snapshot(['terminal']);
      },
      abort: () => undefined,
    });

    view.refresh();
    await vi.waitFor(() => expect(view.element.hidden).toBe(false));

    failing = true;
    view.refresh();
    await vi.waitFor(() => expect(view.element.hidden).toBe(true));
  });

  it('кнопка зовёт остановку', () => {
    const abort = vi.fn();
    const view = createChatRunning({ snapshot: async () => null, abort });
    (view.element.querySelectorAll('.chat-running-stop')[0] as unknown as { click(): void }).click();
    expect(abort).toHaveBeenCalledOnce();
  });
});
