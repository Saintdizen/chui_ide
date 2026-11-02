import { describe, expect, it, vi } from 'vitest';
import { browserAction } from '../src/main/ai/agent-browser';
import type { ToolContext } from '../src/main/ai/tool-context';
import type { BrowserSnapshot } from '../src/shared/browser';

/**
 * Инструмент браузера (`main/ai/agent-browser.ts`).
 *
 * Одно имя вместо семи: разбирается по `action`. Проверяются две вещи, которые
 * легко сломать: отказ на незнакомое действие и согласие человека — действия с
 * последствиями не должны проходить без него, даже если окно подключено.
 *
 * Браузер — заглушка: инструмент разговаривает с ним через `ctx.browser`, и всё,
 * что выше, — настоящий код.
 */

function snapshot(overrides: Partial<BrowserSnapshot> = {}): BrowserSnapshot {
  return {
    url: 'https://example.com/',
    title: 'Пример',
    elements: [],
    text: 'текст страницы',
    ...overrides,
  } as BrowserSnapshot;
}

interface Options {
  allowAll?: boolean;
  confirm?: (action: string) => Promise<boolean> | boolean;
  noConfirm?: boolean;
}

function makeContext(options: Options = {}) {
  const calls: string[] = [];
  const browser = {
    open: vi.fn(async (url: string) => {
      calls.push(`open:${url}`);
      return snapshot({ url, title: 'Открыто' });
    }),
    snapshot: vi.fn(async () => {
      calls.push('snapshot');
      return snapshot();
    }),
    click: vi.fn(async (ref: string) => {
      calls.push(`click:${ref}`);
      return snapshot();
    }),
    type: vi.fn(async (ref: string, text: string, submit?: boolean) => {
      calls.push(`type:${ref}:${text}${submit ? ':submit' : ''}`);
      return snapshot();
    }),
    evaluate: vi.fn(async (expression: string) => {
      calls.push(`evaluate:${expression}`);
      return { value: 42 };
    }),
    zoom: vi.fn(async (mode: string) => {
      calls.push(`zoom:${mode}`);
      return { ok: true, zoom: 1 };
    }),
    close: vi.fn(async () => {
      calls.push('close');
      return snapshot();
    }),
  };
  const ctx = {
    browser,
    allowAll: options.allowAll ?? false,
    confirmBrowser: options.noConfirm
      ? undefined
      : async (action: string) => {
          calls.push(`confirm:${action}`);
          return options.confirm ? await options.confirm(action) : true;
        },
  } as unknown as ToolContext;
  return { ctx, browser, calls };
}

const run = (ctx: ToolContext, args: Record<string, unknown>) => browserAction(ctx, args);

describe('выбор действия', () => {
  it('незнакомое действие — отказ со списком допустимых', async () => {
    const { ctx, calls } = makeContext();

    const outcome = await run(ctx, { action: 'взлететь' });

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('взлететь');
    // Список в ответе — чтобы модель не гадала, что доступно.
    expect(outcome.detail).toContain('snapshot');
    expect(calls).toEqual([]);
  });

  it('без действия инструмент падает на разборе аргументов', async () => {
    // Так устроены все инструменты: обязательный аргумент проверяет `requireString`,
    // и его исключение ловит общий диспетчер, а не сам инструмент.
    const { ctx } = makeContext();

    await expect(run(ctx, {})).rejects.toThrow('action');
  });

  it('недостающий аргумент не доходит до браузера', async () => {
    const { ctx, calls } = makeContext();

    const outcome = await run(ctx, { action: 'click' });

    expect(outcome.ok).toBe(false);
    expect(calls.some((call) => call.startsWith('click'))).toBe(false);
  });

  it('без подключённого окна каждое действие отвечает «недоступен»', async () => {
    const { ctx } = makeContext();
    (ctx as unknown as { browser: undefined }).browser = undefined;

    const outcome = await run(ctx, { action: 'snapshot' });

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('Браузер недоступен');
  });
});

describe('снимок и открытие', () => {
  it('открытие передаёт адрес и возвращает снимок с заголовком', async () => {
    const { ctx, browser } = makeContext();

    const outcome = await run(ctx, { action: 'open', url: 'https://example.com' });

    expect(browser.open).toHaveBeenCalledWith('https://example.com');
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('Открыто');
  });

  it('снимок отдаёт текст страницы в подробностях', async () => {
    const { ctx } = makeContext();

    const outcome = await run(ctx, { action: 'snapshot' });

    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('текст страницы');
  });

  it('заголовка нет — в сводке стоит адрес', async () => {
    const { ctx, browser } = makeContext();
    browser.snapshot.mockResolvedValue(snapshot({ title: '   ' }));

    const outcome = await run(ctx, { action: 'snapshot' });

    expect(outcome.summary).toContain('https://example.com');
  });
});

describe('согласие человека', () => {
  it('клик спрашивает разрешение и без согласия не выполняется', async () => {
    // Клик в браузере — это отправка формы, покупка, удаление: без человека нельзя.
    const { ctx, browser, calls } = makeContext({ confirm: () => false });

    const outcome = await run(ctx, { action: 'click', ref: 'e12' });

    expect(calls.some((call) => call.startsWith('confirm:'))).toBe(true);
    expect(browser.click).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });

  it('с согласием действие выполняется', async () => {
    const { ctx, browser } = makeContext({ confirm: () => true });

    const outcome = await run(ctx, { action: 'click', ref: 'e12' });

    expect(browser.click).toHaveBeenCalledWith('e12');
    expect(outcome.ok).toBe(true);
  });

  it('ввод текста тоже спрашивает разрешение', async () => {
    const { ctx, browser } = makeContext({ confirm: () => false });

    await run(ctx, { action: 'type', ref: 'e3', text: 'привет' });

    expect(browser.type).not.toHaveBeenCalled();
  });

  it('снимок разрешения не спрашивает: он ничего не меняет', async () => {
    const { ctx, calls } = makeContext();

    await run(ctx, { action: 'snapshot' });

    expect(calls.some((call) => call.startsWith('confirm:'))).toBe(false);
  });

  it('allowAll отменяет вопросы, но не действия', async () => {
    const { ctx, browser, calls } = makeContext({ allowAll: true });

    const outcome = await run(ctx, { action: 'click', ref: 'e1' });

    expect(calls.some((call) => call.startsWith('confirm:'))).toBe(false);
    expect(browser.click).toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
  });

  it('отказ согласия объясняет причину, а не молчит', async () => {
    const { ctx } = makeContext({ confirm: () => false });

    const outcome = await run(ctx, { action: 'click', ref: 'e1' });

    expect(outcome.summary.length).toBeGreaterThan(0);
  });
});

describe('выполнение кода и размер окна', () => {
  it('evaluate передаёт выражение и отдаёт результат', async () => {
    const { ctx, browser } = makeContext({ allowAll: true });
    // `evaluate` возвращает результат выполнения, а не строку.
    browser.evaluate.mockResolvedValue({ value: 42 });

    const outcome = await run(ctx, { action: 'evaluate', expression: '1 + 1' });

    expect(browser.evaluate).toHaveBeenCalledWith('1 + 1');
    // `detail` — сам результат вычисления, как его вернул браузер.
    expect((outcome.detail as unknown as { value: number }).value).toBe(42);
  });

  it('evaluate без разрешения не выполняется', async () => {
    // Это исполнение кода на чужой странице — самое опасное из действий.
    const { ctx, browser } = makeContext({ confirm: () => false });

    await run(ctx, { action: 'evaluate', expression: 'fetch("/admin")' });

    expect(browser.evaluate).not.toHaveBeenCalled();
  });

  it('масштаб окна передаётся в браузер', async () => {
    const { ctx, browser } = makeContext({ allowAll: true });

    await run(ctx, { action: 'zoom', mode: 'fit' });

    expect(browser.zoom).toHaveBeenCalledWith('fit');
  });

  it('закрытие окна проходит без вопросов: это безопасное действие', async () => {
    const { ctx, browser, calls } = makeContext();

    const outcome = await run(ctx, { action: 'close' });

    expect(browser.close).toHaveBeenCalled();
    expect(calls.some((call) => call.startsWith('confirm:'))).toBe(false);
    expect(outcome.ok).toBe(true);
  });
});
