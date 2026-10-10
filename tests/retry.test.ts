import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay, fetchWithRetry, MAX_ATTEMPTS, retryAfterMs, sleep } from '../src/shared/retry';

/**
 * Повтор сетевого запроса на временных сбоях.
 *
 * Тут важны три вещи: когда повторяем (429/5xx и сеть), когда нет (остальные
 * коды) и сколько ждём (экспонента с джиттером, `Retry-After`). Время
 * подделываем таймерами, чтобы тесты не ждали реального backoff.
 */

describe('retryAfterMs', () => {
  it('заголовка нет → нет и задержки', () => {
    expect(retryAfterMs(null)).toBeUndefined();
  });

  it('секунды превращаем в миллисекунды', () => {
    expect(retryAfterMs('2')).toBe(2000);
    expect(retryAfterMs('0')).toBe(0);
  });

  it('держит разумные пределы: не меньше нуля и не больше 30 с', () => {
    expect(retryAfterMs('-5')).toBe(0);
    expect(retryAfterMs('600')).toBe(30_000);
  });

  it('дата в будущем — миллисекунды до неё', () => {
    const header = new Date(Date.now() + 5000).toUTCString();
    const value = retryAfterMs(header);
    expect(value).toBeGreaterThan(4000);
    expect(value).toBeLessThanOrEqual(5000);
  });

  it('далёкая дата упирается в потолок', () => {
    expect(retryAfterMs(new Date(Date.now() + 3_600_000).toUTCString())).toBe(30_000);
  });

  it('мусор → undefined', () => {
    expect(retryAfterMs('скоро')).toBeUndefined();
  });
});

describe('backoffDelay', () => {
  it('растёт с попытками и заканчивается потолком 8 с', () => {
    expect(backoffDelay(1)).toBeGreaterThanOrEqual(500);
    expect(backoffDelay(1)).toBeLessThanOrEqual(749);
    expect(backoffDelay(5)).toBeGreaterThanOrEqual(8000);
    expect(backoffDelay(5)).toBeLessThanOrEqual(8249);
    // Дальше экспонента упирается в потолок: 500·2⁴ = 8000.
    expect(backoffDelay(20)).toBeLessThanOrEqual(8249);
  });
});

describe('sleep', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('просыпается по таймеру', async () => {
    const promise = sleep(100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBeUndefined();
  });

  it('прерывается сигналом, не дожидаясь сна', async () => {
    const controller = new AbortController();
    const promise = sleep(10_000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow(/Aborted/);
  });

  it('уже отменённый сигнал — сразу отказ', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(10_000, controller.signal)).rejects.toThrow(/Aborted/);
  });
});

describe('fetchWithRetry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Ответ с кодом: тело неважно, важен статус. */
  const response = (status: number, headers?: Record<string, string>): Response =>
    new Response('', { status, headers });

  it('успех — один запрос', async () => {
    const fetchMock = vi.fn(async () => response(200));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchWithRetry('http://x', {});
    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('неповторяемый код отдаём как есть', async () => {
    const fetchMock = vi.fn(async () => response(400));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchWithRetry('http://x', {});
    expect(result.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 с Retry-After повторяем и затем отвечаем', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return call === 1 ? response(429, { 'retry-after': '0' }) : response(200);
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetry('http://x', {});
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('упорные 5xx исчерпывают попытки и возвращают последний ответ', async () => {
    const fetchMock = vi.fn(async () => response(503));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetry('http://x', {});
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('сетевой сбой — исключение после всех попыток', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('сеть недоступна');
    });
    vi.stubGlobal('fetch', fetchMock);

    const assertion = expect(fetchWithRetry('http://x', {})).rejects.toThrow('сеть недоступна');
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('отмена не ждёт повторов', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async () => {
      throw new DOMException('Aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWithRetry('http://x', {}, controller.signal)).rejects.toThrow(/Aborted/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
