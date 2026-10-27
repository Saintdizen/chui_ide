import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleProvider } from '../src/main/ai/openai-compatible';

/**
 * Размышления шага уходят обратно вместе с вызовами инструментов.
 *
 * DeepSeek отвечает 400 на запрос с `tools`, если `reasoning_content` прошлых
 * шагов не возвращён: размышление — часть протокола вызова, а не отладочный
 * вывод. Проверка смотрит на тело запроса: там ли поле и не уходит ли оно
 * туда, где его не было (чужому серверу лишнее поле может стоить отказа).
 */

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Тело последнего запроса, который провайдер отправил. */
function bodyOf(spy: ReturnType<typeof vi.fn>): { messages: Record<string, unknown>[] } {
  const call = spy.mock.calls.at(-1);
  const init = call?.[1] as RequestInit | undefined;
  if (!init?.body) throw new Error('провайдер не отправил тело запроса');
  return JSON.parse(String(init.body));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reasoning_content в теле запроса', () => {
  it('размышления шага возвращаются вместе с вызовами', async () => {
    const fetchSpy = vi.fn(async () =>
      sse(['data: {"choices":[{"delta":{"content":"ок"},"finish_reason":"stop"}]}\n\n']),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const provider = new OpenAiCompatibleProvider({ id: 'p', label: 'P', baseUrl: 'http://localhost:1' });
    await provider.streamChat(
      {
        model: 'deepseek-flash',
        messages: [
          { role: 'user', content: 'посчитай' },
          {
            role: 'assistant',
            content: 'Сейчас вызову.',
            reasoning: 'Надо сложить два числа.',
            toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
          },
          { role: 'tool', content: '42', toolCallId: 'c1' },
        ],
      },
      { onDelta: () => {} },
      new AbortController().signal,
    );

    const assistant = bodyOf(fetchSpy).messages[1];
    expect(assistant!.reasoning_content).toBe('Надо сложить два числа.');
    expect(assistant!.tool_calls).toBeTruthy();
  });

  it('без размышлений поля в теле нет', async () => {
    const fetchSpy = vi.fn(async () =>
      sse(['data: {"choices":[{"delta":{"content":"ок"},"finish_reason":"stop"}]}\n\n']),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const provider = new OpenAiCompatibleProvider({ id: 'p', label: 'P', baseUrl: 'http://localhost:1' });
    await provider.streamChat(
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'user', content: 'привет' },
          { role: 'assistant', content: 'здравствуй', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] },
          { role: 'tool', content: 'ok', toolCallId: 'c1' },
        ],
      },
      { onDelta: () => {} },
      new AbortController().signal,
    );

    // Чужой сервер не присылал размышлений — и обратно их не получает.
    expect(bodyOf(fetchSpy).messages[1]).not.toHaveProperty('reasoning_content');
  });

  it('выключение размышления уходит параметром', async () => {
    const fetchSpy = vi.fn(async () =>
      sse(['data: {"choices":[{"delta":{"content":"ок"},"finish_reason":"stop"}]}\n\n']),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const provider = new OpenAiCompatibleProvider({ id: 'p', label: 'P', baseUrl: 'http://localhost:1' });
    await provider.streamChat(
      {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'привет' }],
        thinking: false,
      },
      { onDelta: () => {} },
      new AbortController().signal,
    );

    // «Без размышлений» — это отдельный параметр: молчание означало бы
    // «думай как обычно», ведь у DeepSeek размышление включено по умолчанию.
    expect(bodyOf(fetchSpy)).toMatchObject({ thinking: { type: 'disabled' } });
  });

  it('когда размышление не выключали, поля thinking нет', async () => {
    const fetchSpy = vi.fn(async () =>
      sse(['data: {"choices":[{"delta":{"content":"ок"},"finish_reason":"stop"}]}\n\n']),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const provider = new OpenAiCompatibleProvider({ id: 'p', label: 'P', baseUrl: 'http://localhost:1' });
    await provider.streamChat(
      { model: 'deepseek-flash', messages: [{ role: 'user', content: 'привет' }] },
      { onDelta: () => {} },
      new AbortController().signal,
    );

    expect(bodyOf(fetchSpy)).not.toHaveProperty('thinking');
  });
});
