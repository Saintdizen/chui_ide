import {
  defaultWebSearchEndpoint,
  isAllowedSearchEndpoint,
  parseSearchResponse,
  type WebSearchHit,
  type WebSearchProvider,
} from '../../shared/web-search';

/**
 * Обращение к сервису веб-поиска.
 *
 * Это единственное место в проекте, которое ходит во внешнюю сеть по просьбе
 * модели. Поэтому здесь три ограничения: адрес задаёт человек в настройках (модель
 * его не меняет, только запрос), открытый http допускается лишь для своего
 * (см. `isAllowedSearchEndpoint`), а ответ ограничен по времени и размеру — иначе
 * медленный или огромный ответ останавливал бы агентский цикл.
 */

/** Дольше ждать поиск незачем: человек уже ушёл, а шаг агента стоит токенов. */
const TIMEOUT_MS = 15_000;

/**
 * Потолок тела ответа. Парсить мегабайты JSON незачем: в выдаче нужны первые
 * десятки результатов, а всё остальное — простор для отказа по памяти.
 */
const MAX_BODY_CHARS = 1_000_000;

/** Сколько результатов просим у сервиса. */
export const WEB_SEARCH_LIMIT = 10;

export interface WebSearchConfig {
  provider: WebSearchProvider;
  /** Пусто — адрес по умолчанию для выбранного вида поиска. */
  endpoint: string;
  apiKey?: string;
}

/** Адрес запроса: у SearxNG это `/search` с `format=json`, у Brave — готовый путь API. */
export function webSearchRequestUrl(config: WebSearchConfig, query: string, limit: number): string {
  const base = (config.endpoint.trim() || defaultWebSearchEndpoint(config.provider)).replace(/\/+$/, '');
  const params = `q=${encodeURIComponent(query)}`;
  return config.provider === 'searxng' ? `${base}/search?${params}&format=json` : `${base}?${params}&count=${limit}`;
}

/** Заголовки запроса: ключ нужен только Brave. */
export function webSearchHeaders(config: WebSearchConfig): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (config.provider === 'brave' && config.apiKey) headers['x-subscription-token'] = config.apiKey;
  return headers;
}

/** Нужен ли этому виду поиска ключ: SearxNG обходится без него. */
export function webSearchNeedsKey(provider: WebSearchProvider): boolean {
  return provider === 'brave';
}

export async function searchWeb(
  query: string,
  config: WebSearchConfig,
  limit = WEB_SEARCH_LIMIT,
  signal?: AbortSignal,
): Promise<WebSearchHit[]> {
  const url = webSearchRequestUrl(config, query, limit);
  if (!isAllowedSearchEndpoint(url)) {
    throw new Error(`Адрес поиска не разрешён: ${config.endpoint || defaultWebSearchEndpoint(config.provider)}`);
  }

  // Свой срок и просьба агента — вместе: отмена должна срабатывать и тогда,
  // когда человек нажал «Стоп», и тогда, когда сервис просто молчит.
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const response = await fetch(url, { headers: webSearchHeaders(config), signal: combined });
  if (!response.ok) {
    throw new Error(`Поиск ответил кодом ${response.status}${response.status === 401 ? ' — проверьте ключ' : ''}`);
  }

  const body = await response.text();
  if (body.length > MAX_BODY_CHARS) throw new Error('Ответ поиска слишком большой');

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('Поиск вернул не JSON: проверьте, что адрес отвечает в формате JSON');
  }

  return parseSearchResponse(config.provider, payload).slice(0, limit);
}

/** Подпись источника для человека: по ней видно, откуда взялись результаты. */
export function webSearchProviderLabel(provider: WebSearchProvider): string {
  return provider === 'brave' ? 'Brave Search' : 'SearxNG';
}
