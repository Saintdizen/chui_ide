import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Прокси для `fetch` — единственное место в main, где он применяется. До этого
 * файла ни `installProxyFromEnv`, ни `httpViaProxy` не исполнял ни один тест:
 * ошибку в пути запроса (absolute URI, редирект, тело) видно только здесь.
 *
 * Настоящий undici не нужен: агент собирается как запись настроек, а `fetch`
 * оттуда подменён — важно, чтО модуль передал ему вторым аргументом.
 */
const agents: { options: Record<string, unknown>; closed: boolean }[] = [];
const undiciFetch = vi.fn();

vi.mock('undici', () => ({
  EnvHttpProxyAgent: class {
    options: Record<string, unknown>;
    closed = false;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      agents.push(this as unknown as { options: Record<string, unknown>; closed: boolean });
    }
    close(): Promise<void> {
      this.closed = true;
      return Promise.resolve();
    }
  },
  fetch: (...args: unknown[]) => undiciFetch(...args),
}));

const { installProxyFromEnv, netFetch, proxySettings } = await import('../src/main/net/proxy');

/** Заглушка вместо прокси и/или цели: пишет, что к ней пришло. */
interface Stub {
  url: string;
  requests: { url?: string; method?: string; headers: http.IncomingHttpHeaders; body: string }[];
  close: () => Promise<void>;
}

const stubs: Stub[] = [];

type Reply = { status?: number; headers?: Record<string, string>; body?: string };

async function stubServer(reply: (request: http.IncomingMessage) => Reply): Promise<Stub> {
  const requests: Stub['requests'] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      requests.push({ url: request.url, method: request.method, headers: request.headers, body });
      const answer = reply(request);
      response.writeHead(answer.status ?? 200, answer.headers ?? {});
      response.end(answer.body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const stub: Stub = {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  stubs.push(stub);
  return stub;
}

const globalFetch = vi.fn(async () => new Response('глобальный'));

beforeEach(() => {
  agents.length = 0;
  undiciFetch.mockReset();
  globalFetch.mockClear();
  vi.stubGlobal('fetch', globalFetch);
  installProxyFromEnv({});
});

afterEach(async () => {
  installProxyFromEnv({});
  vi.unstubAllGlobals();
  while (stubs.length > 0) await stubs.pop()!.close();
});

describe('installProxyFromEnv', () => {
  it('без переменных ходит напрямую: диспетчера нет', async () => {
    expect(installProxyFromEnv({})).toEqual({ noProxy: [] });
    expect(agents).toHaveLength(0);
    expect(proxySettings()).toEqual({ noProxy: [] });

    const response = await netFetch('https://api.example.com/v1');
    expect(await response.text()).toBe('глобальный');
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it('HTTP_PROXY и HTTPS_PROXY собирают диспетчер, ALL_PROXY — общий', () => {
    installProxyFromEnv({
      HTTP_PROXY: 'http://proxy:3128',
      HTTPS_PROXY: 'http://proxy:3129',
      NO_PROXY: 'localhost',
    });
    expect(agents).toHaveLength(1);
    expect(agents[0]!.options).toEqual({
      httpProxy: 'http://proxy:3128',
      httpsProxy: 'http://proxy:3129',
      noProxy: 'localhost',
    });

    installProxyFromEnv({ ALL_PROXY: 'http://all:8080' });
    expect(agents).toHaveLength(2);
    expect(agents[1]!.options).toEqual({
      httpProxy: 'http://all:8080',
      httpsProxy: 'http://all:8080',
      noProxy: '',
    });
  });

  it('новый прокси закрывает прежний диспетчер', () => {
    installProxyFromEnv({ HTTPS_PROXY: 'http://one:3128' });
    installProxyFromEnv({ HTTPS_PROXY: 'http://two:3128' });
    expect(agents[0]!.closed).toBe(true);
    expect(agents[1]!.closed).toBe(false);
  });
});

describe('netFetch: https через undici', () => {
  it('отдаёт диспетчер и тот же вход', async () => {
    installProxyFromEnv({ HTTPS_PROXY: 'http://proxy:3128' });
    undiciFetch.mockResolvedValue(new Response('из undici'));

    const response = await netFetch('https://api.example.com/v1', { method: 'POST', body: '{}' });
    expect(await response.text()).toBe('из undici');
    expect(undiciFetch).toHaveBeenCalledTimes(1);
    const [input, init] = undiciFetch.mock.calls[0] as [string, { dispatcher: unknown; method: string }];
    expect(input).toBe('https://api.example.com/v1');
    expect(init.method).toBe('POST');
    expect(init.dispatcher).toBe(agents[0]);
  });

  it('socks5 не игнорирует молча: исключение с объяснением', async () => {
    installProxyFromEnv({ HTTPS_PROXY: 'socks5://127.0.0.1:1080' });
    await expect(netFetch('https://api.example.com/v1')).rejects.toThrow(/socks/i);
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it('NO_PROXY оставляет запрос напрямую', async () => {
    installProxyFromEnv({ HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'internal.example.com' });
    const response = await netFetch('https://internal.example.com/v1');
    expect(await response.text()).toBe('глобальный');
    expect(undiciFetch).not.toHaveBeenCalled();
  });
});

describe('netFetch: http через прокси обычным запросом', () => {
  it('шлёт прокси абсолютный адрес и возвращает ответ с адресом цели', async () => {
    const proxy = await stubServer(() => ({ body: 'страница' }));
    installProxyFromEnv({ HTTP_PROXY: proxy.url });

    const response = await netFetch('http://example.com/page?x=1', { method: 'GET' });
    expect(await response.text()).toBe('страница');
    expect(response.url).toBe('http://example.com/page?x=1');
    expect(proxy.requests).toHaveLength(1);
    expect(proxy.requests[0]!.url).toBe('http://example.com/page?x=1');
    expect(proxy.requests[0]!.headers.host).toBe('example.com');
  });

  it('тело-строка доходит целиком и с content-length', async () => {
    const proxy = await stubServer(() => ({ body: 'ok' }));
    installProxyFromEnv({ HTTP_PROXY: proxy.url });

    await netFetch('http://example.com/api', { method: 'POST', body: '{"a":1}' });
    expect(proxy.requests[0]!.body).toBe('{"a":1}');
    expect(proxy.requests[0]!.headers['content-length']).toBe('7');
  });

  it('потоковое тело отвергает словами, а не молча', async () => {
    const proxy = await stubServer(() => ({ body: 'ok' }));
    installProxyFromEnv({ HTTP_PROXY: proxy.url });

    const body = new ReadableStream({ start: (controller) => controller.close() });
    await expect(netFetch('http://example.com/api', { method: 'POST', body })).rejects.toThrow(/потоковое тело/i);
    expect(proxy.requests).toHaveLength(0);
  });

  it('идёт по редиректу и подставляет адрес последней цели', async () => {
    const target = await stubServer(() => ({ body: 'финал' }));
    const proxy = await stubServer((request) =>
      request.url?.includes('/next') ? { body: 'финал' } : { status: 302, headers: { location: `${target.url}/next` } },
    );
    installProxyFromEnv({ HTTP_PROXY: proxy.url });

    const response = await netFetch('http://example.com/start');
    expect(await response.text()).toBe('финал');
    expect(response.url).toBe(`${target.url}/next`);
    expect(proxy.requests).toHaveLength(2);
  });

  it('redirect: manual редирект не разворачивает', async () => {
    const proxy = await stubServer(() => ({ status: 302, headers: { location: 'http://elsewhere/next' } }));
    installProxyFromEnv({ HTTP_PROXY: proxy.url });

    const response = await netFetch('http://example.com/start', { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(proxy.requests).toHaveLength(1);
  });

  it('сработавший сигнал обрывает запрос', async () => {
    const proxy = await stubServer(() => ({ body: 'поздно' }));
    installProxyFromEnv({ HTTP_PROXY: proxy.url });
    const controller = new AbortController();
    controller.abort();

    await expect(netFetch('http://example.com/slow', { signal: controller.signal })).rejects.toThrow(/abort/i);
  });
});
