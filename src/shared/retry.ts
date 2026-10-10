/**
 * Повтор сетевого запроса на временных сбоях.
 *
 * Вынесено из `openai-compatible.ts` в `shared`: логика чистая (только `fetch`,
 * таймеры и заголовки), поэтому проверяется тестами без Electron. Оба провайдера
 * (OpenAI-совместимый и Anthropic) используют её через этот модуль.
 */

/** Коды, на которых повтор осмыслен: временная перегрузка или сеть. */
export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
export const MAX_ATTEMPTS = 4;

/** Задержка перед повтором: экспонента с джиттером, но не дольше 8 с. */
export function backoffDelay(attempt: number): number {
  const base = Math.min(8_000, 500 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 250);
}

/** `Retry-After` — секунды или HTTP-дата. Отдаём миллисекунды, если разобрали. */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
  return undefined;
}

/** Пауза, прерываемая сигналом: отмена не должна ждать сна. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Повтор запроса на временных сбоях сети и состояниях 429/5xx. Повторяется
 * только сам fetch — до чтения тела потока, поэтому стрим не дублируется.
 */
export async function fetchWithRetry(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal });
      if (response.ok || !RETRYABLE_STATUS.has(response.status) || attempt === MAX_ATTEMPTS) {
        return response;
      }
      const wait = retryAfterMs(response.headers.get('retry-after')) ?? backoffDelay(attempt);
      await sleep(wait, signal);
    } catch (error) {
      lastError = error;
      if (signal?.aborted || attempt === MAX_ATTEMPTS) throw error;
      await sleep(backoffDelay(attempt), signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Запрос к провайдеру не удался');
}
