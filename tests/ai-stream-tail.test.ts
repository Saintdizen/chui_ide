import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/main/ai/anthropic';
import { OpenAiCompatibleProvider } from '../src/main/ai/openai-compatible';

/**
 * Хвост потока провайдера.
 *
 * SSE отдаётся строками, и разбор идёт по переводам строк. Но последняя строка
 * потока легко приходит БЕЗ завершающего `\n` (сервер закрывает соединение сразу
 * после последнего `data:`), а некоторые сборки и вовсе не шлют `data: [DONE]`.
 * Такой остаток нельзя держать в буфере «до следующей строки» — следующей уже не
 * будет, и текст последнего куска пропадёт: ответ в чате обрывается на полуслове.
 *
 * Проверка ловит именно это: последний фрагмент приходит без `\n` и должен попасть
 * и в итоговый текст, и в `onDelta` (лента рисует по дельтам).
 */

/** Ответ-поток: чанки уходят как есть, без доведения до переводов строки. */
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('хвост SSE без завершающего перевода строки', () => {
  it('OpenAI-совместимый: последний фрагмент без \\n не теряется', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          'data: {"choices":[{"delta":{"content":"Прив"}}]}\n\n',
          // Последняя строка — без «\n» и без «[DONE]»: так тоже бывает.
          'data: {"choices":[{"delta":{"content":"ет"}}]}',
        ]),
      ),
    );

    const deltas: string[] = [];
    const provider = new OpenAiCompatibleProvider({ id: 'p', label: 'P', baseUrl: 'http://localhost:1' });
    const done = await provider.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'привет' }] },
      { onDelta: (text) => deltas.push(text) },
      new AbortController().signal,
    );

    expect(deltas.join('')).toBe('Привет');
    expect(done.text).toBe('Привет');
  });

  it('OpenAI-совместимый: хвост читается, даже если он разрезан посередине', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sse(['data: {"choices":[{"delta":{"content":"середи', 'не"}}]}'])),
    );

    const provider = new OpenAiCompatibleProvider({ id: 'p', label: 'P', baseUrl: 'http://localhost:1' });
    const done = await provider.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      { onDelta: () => undefined },
      new AbortController().signal,
    );

    expect(done.text).toBe('середине');
  });

  it('Anthropic: последний фрагмент без \\n не теряется', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"раз"}}\n\n',
          // Хвост без перевода строки: событие закрывает соединение как есть.
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" два"}}',
        ]),
      ),
    );

    const deltas: string[] = [];
    const provider = new AnthropicProvider({ id: 'a', label: 'A', baseUrl: 'http://localhost:1', apiKey: 'k' });
    const done = await provider.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 100 },
      { onDelta: (text) => deltas.push(text) },
      new AbortController().signal,
    );

    expect(deltas.join('')).toBe('раз два');
    expect(done.text).toBe('раз два');
  });
});
