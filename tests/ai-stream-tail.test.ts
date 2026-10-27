import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, type toAnthropicMessages } from '../src/main/ai/anthropic';
import type { ChatMessage } from '../src/shared/api';
import { OpenAiCompatibleProvider } from '../src/main/ai/openai-compatible';

/** Формат сообщений Anthropic: модуль его не экспортирует — берём из функции сборки. */
type AnthropicMessage = ReturnType<typeof toAnthropicMessages>['messages'][number];

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

describe('расход Anthropic считает весь вход', () => {
  it('кешированное входит в promptTokens и не пропадает', async () => {
    // Живой баг: Anthropic сообщает input_tokens БЕЗ кешированного. При
    // попадании в кеш запрос выглядел пустым, и калибровка окна обучалась на
    // ratio 0.1 — то есть считала, что текста вдесятеро меньше, чем есть.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":900,"cache_creation_input_tokens":80,"output_tokens":1}}}\n\n',
        ]),
      ),
    );

    const provider = new AnthropicProvider({ id: 'a', label: 'A', baseUrl: 'http://localhost:1', apiKey: 'k' });
    const done = await provider.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 100 },
      { onDelta: () => undefined },
      new AbortController().signal,
    );

    expect(done.usage?.promptTokens).toBe(1100);
    expect(done.usage?.cachedTokens).toBe(900);
    expect(done.usage?.cacheCreationTokens).toBe(80);
  });

  it('DeepSeek: попадание в кеш приходит полем prompt_cache_hit_tokens', async () => {
    // Кеш у DeepSeek включён всегда: если это поле не читать, попадания
    // выглядят как полная цена, и рычаг оптимизации не виден в учёте.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":1200,"completion_tokens":5,"prompt_cache_hit_tokens":1100,"prompt_cache_miss_tokens":100}}\n\n',
        ]),
      ),
    );
    const provider = new OpenAiCompatibleProvider({
      id: 'd',
      label: 'D',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
    });
    const done = await provider.streamChat(
      { model: 'deepseek-flash', messages: [{ role: 'user', content: 'x' }], maxTokens: 100 },
      { onDelta: () => undefined },
      new AbortController().signal,
    );

    expect(done.usage?.promptTokens).toBe(1200);
    expect(done.usage?.cachedTokens).toBe(1100);
  });
});

describe('ключ дискового кеша промпта', () => {
  /** Тело последнего запроса: ключ кеша виден только там. */
  async function bodyFor(baseUrl: string): Promise<Record<string, unknown>> {
    const spy = vi.fn(async () => sse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']));
    vi.stubGlobal('fetch', spy);
    const provider = new OpenAiCompatibleProvider({ id: 'p', label: 'P', baseUrl, apiKey: 'k' });
    await provider.streamChat(
      {
        model: 'deepseek-flash',
        messages: [{ role: 'system', content: 'ты агент' }],
        tools: [{ name: 'read', description: 'd', parameters: { type: 'object', properties: {} } }],
      },
      { onDelta: () => undefined },
      new AbortController().signal,
    );
    const call = spy.mock.calls[0] as unknown as [string, { body: string }];
    return JSON.parse(call[1].body) as Record<string, unknown>;
  }

  it('DeepSeek получает prompt_cache_key — у него есть дисковый кеш', async () => {
    // Без ключа DeepSeek всё равно кеширует по префиксу, но ключ на 30× дешевле
    // и снимает утечку между беседами: одинаковый system у всех.
    expect((await bodyFor('https://api.deepseek.com')).prompt_cache_key).toEqual(expect.any(String));
  });

  it('чужой OpenAI-совместимый сервер ключа не получает — там это 400', async () => {
    expect((await bodyFor('https://api.groq.com/openai/v1')).prompt_cache_key).toBeUndefined();
  });
});

describe('кеш Anthropic держит только префикс прогона', () => {
  /** Тела запросов: кеш видно только там. */
  async function bodies(turns: number): Promise<Array<Record<string, unknown>>> {
    const spy = vi.fn(async () => sse(['data: {"type":"message_stop"}\n\n']));
    vi.stubGlobal('fetch', spy);
    const provider = new AnthropicProvider({ id: 'a', label: 'A', baseUrl: 'http://localhost:1', apiKey: 'k' });
    const messages: ChatMessage[] = [
      { role: 'system', content: 'ты агент' },
      ...Array.from({ length: turns }, (_, index) => ({ role: 'user' as const, content: `шаг ${index}` })),
    ];
    await provider.streamChat(
      {
        model: 'm',
        messages,
        tools: [{ name: 'read', description: 'd', parameters: { type: 'object', properties: {} } }],
      },
      { onDelta: () => undefined },
      new AbortController().signal,
    );
    return spy.mock.calls.map((call) => JSON.parse((call as unknown as [string, { body: string }])[1].body));
  }

  /** Сколько сообщений несут cache_control: префикс кеша, а не хвост беседы. */
  function marked(body: Record<string, unknown>): number {
    const messages = body.messages as AnthropicMessage[];
    return messages.filter(
      (message) => Array.isArray(message.content) && message.content.some((block) => 'cache_control' in block),
    ).length;
  }

  it('метка стоит на последнем сообщении с блоками — его и переиспользует следующий шаг', async () => {
    const [body] = await bodies(4);
    const messages = body!.messages as AnthropicMessage[];
    expect(marked(body!)).toBe(1);
    const last = messages[messages.length - 1]!;
    expect(Array.isArray(last.content) && last.content.some((block) => 'cache_control' in block)).toBe(true);
    // system (вместе с инструментами) — вторая, неподвижная точка.
    const system = body!.system as Array<{ cache_control?: unknown }> | undefined;
    if (system) expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });
});
