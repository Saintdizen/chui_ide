import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAllowedSearchEndpoint } from '../src/shared/web-search';

/**
 * Единственный выход проекта во внешнюю сеть «по просьбе модели». Проверяем то,
 * что защищает: адрес только из настроек, ограничение размера и времени, разбор
 * ответа трёх вендоров и срез до запрошенного числа результатов.
 */
const netFetch = vi.fn();

vi.mock('../src/main/net/proxy', () => ({
  netFetch: (...args: unknown[]) => netFetch(...args),
}));

const {
  WEB_SEARCH_LIMIT,
  searchWeb,
  webSearchHeaders,
  webSearchNeedsKey,
  webSearchProviderLabel,
  webSearchRequestBody,
  webSearchRequestUrl,
} = await import('../src/main/ai/web-search');

const searx = { provider: 'searxng' as const, endpoint: '' };
const brave = { provider: 'brave' as const, endpoint: '', apiKey: 'key-1' };
const deepseek = { provider: 'deepseek' as const, endpoint: 'https://api.deepseek.com/search', apiKey: 'ds-2' };

/** Ответ netFetch с готовым телом. */
function reply(body: string, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    text: async () => body,
  } as Response;
}

beforeEach(() => {
  netFetch.mockReset();
});

describe('адрес, заголовки и тело запроса', () => {
  it('SearxNG: /search с format=json, адрес по умолчанию', () => {
    const url = webSearchRequestUrl(searx, 'как дела', 5);
    expect(url).toMatch(/\/search\?q=%D0%BA%D0%B0%D0%BA%20%D0%B4%D0%B5%D0%BB%D0%B0&format=json$/);
  });

  it('Brave: count в строке запроса, лишние слэши в адресе не удваиваются', () => {
    const url = webSearchRequestUrl({ ...brave, endpoint: 'https://api.search.brave.com/res/v1/web/search/' }, 'q', 3);
    expect(url).toBe('https://api.search.brave.com/res/v1/web/search?q=q&count=3');
  });

  it('DeepSeek: запрос уходит телом, адрес без параметров', () => {
    expect(webSearchRequestUrl(deepseek, 'что нового', 10)).toBe('https://api.deepseek.com/search');
    const body = webSearchRequestBody(deepseek, 'привет', 200);
    expect(body?.contentType).toBe('application/json');
    expect(JSON.parse(body!.body)).toEqual({ query: 'привет', count: 50 });
  });

  it('DeepSeek: тело ужимает число результатов в разумные рамки', () => {
    const low = webSearchRequestBody(deepseek, 'q', 0);
    expect(JSON.parse(low!.body).count).toBe(1);
    expect(webSearchRequestBody(searx, 'q', 10)).toBeUndefined();
    expect(webSearchRequestBody(brave, 'q', 10)).toBeUndefined();
  });

  it('заголовки: ключ вендора каждый раз свой', () => {
    expect(webSearchHeaders(brave)['x-subscription-token']).toBe('key-1');
    expect(webSearchHeaders(deepseek).authorization).toBe('Bearer ds-2');
    expect(webSearchHeaders(searx)).toEqual({ accept: 'application/json' });
    expect(webSearchHeaders({ ...brave, apiKey: undefined })).toEqual({ accept: 'application/json' });
  });

  it('ключ нужен всем, кроме своего сервера поиска', () => {
    expect(webSearchNeedsKey('searxng')).toBe(false);
    expect(webSearchNeedsKey('brave')).toBe(true);
    expect(webSearchNeedsKey('deepseek')).toBe(true);
    expect(webSearchProviderLabel('brave')).toBe('Brave Search');
    expect(webSearchProviderLabel('deepseek')).toBe('Поиск DeepSeek');
    expect(webSearchProviderLabel('searxng')).toBe('SearxNG');
  });
});

describe('searchWeb: защита и разбор ответа', () => {
  it('неразрешённый адрес не открывается вовсе', async () => {
    await expect(searchWeb('q', { provider: 'searxng', endpoint: 'http://чужой-сервер.example' })).rejects.toThrow(
      /не разрешён/,
    );
    expect(netFetch).not.toHaveBeenCalled();
  });

  it('SearxNG: срезает выдачу до запрошенного числа и чистит теги', async () => {
    const results = Array.from({ length: 30 }, (_, i) => ({
      url: `https://site.example/${i}`,
      title: `<b>Заголовок ${i}</b>`,
      content: 'описание',
    }));
    netFetch.mockResolvedValue(reply(JSON.stringify({ results })));

    const hits = await searchWeb('q', searx, 4);
    expect(hits).toHaveLength(4);
    expect(hits[0]).toEqual({ title: 'Заголовок 0', url: 'https://site.example/0', snippet: 'описание' });
    const [url, init] = netFetch.mock.calls[0] as [string, { method: string; headers: Record<string, string> }];
    expect(init.method).toBe('GET');
    expect(init.headers['content-type']).toBeUndefined();
    expect(url).toContain('q=q');
  });

  it('DeepSeek: POST с телом и content-type', async () => {
    netFetch.mockResolvedValue(reply(JSON.stringify({ results: [{ url: 'https://a.example', summary: 'сводка' }] })));

    const hits = await searchWeb('вопрос', deepseek, 10);
    expect(hits).toEqual([{ title: 'https://a.example', url: 'https://a.example', snippet: 'сводка' }]);
    const [, init] = netFetch.mock.calls[0] as [string, { method: string; body?: string }];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body!)).toEqual({ query: 'вопрос', count: 10 });
  });

  it('Brave: результаты берутся из web.results', async () => {
    netFetch.mockResolvedValue(
      reply(JSON.stringify({ web: { results: [{ url: 'https://b.example', title: 'B', description: 'кратко' }] } })),
    );
    const hits = await searchWeb('q', brave);
    expect(hits).toEqual([{ title: 'B', url: 'https://b.example', snippet: 'кратко' }]);
  });

  it('код 401 говорит про ключ, прочие коды — просто код', async () => {
    netFetch.mockResolvedValueOnce(reply('', { status: 401 }));
    await expect(searchWeb('q', brave)).rejects.toThrow(/проверьте ключ/);
    netFetch.mockResolvedValueOnce(reply('', { status: 503 }));
    await expect(searchWeb('q', brave)).rejects.toThrow(/кодом 503/);
  });

  it('огромный ответ отвергается до разбора', async () => {
    netFetch.mockResolvedValue(reply('x'.repeat(1_000_001)));
    await expect(searchWeb('q', searx)).rejects.toThrow(/слишком большой/);
  });

  it('не-JSON объясняет, что проверить', async () => {
    netFetch.mockResolvedValue(reply('<html>не то</html>'));
    await expect(searchWeb('q', searx)).rejects.toThrow(/не JSON/);
  });

  it('пустая выдача — пустой список, а не ошибка', async () => {
    netFetch.mockResolvedValue(reply(JSON.stringify({})));
    await expect(searchWeb('q', searx)).resolves.toEqual([]);
    expect(WEB_SEARCH_LIMIT).toBe(10);
  });

  it('ограничение по времени приходит в netFetch вместе с отменой агента', async () => {
    netFetch.mockResolvedValue(reply('{"results":[]}'));
    await searchWeb('q', searx);
    const [, init] = netFetch.mock.calls[0] as [string, { signal?: AbortSignal }];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(isAllowedSearchEndpoint(webSearchRequestUrl(searx, 'q', 10))).toBe(true);
  });
});
