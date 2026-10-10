/**
 * Веб-поиск: разбор ответов и проверка адреса.
 *
 * Инструмент агента обращается к внешнему сервису поиска, и сервисы эти говорят
 * по-разному. Разбор ответов — правило, а не I/O, поэтому живёт здесь и
 * проверяется без сети: ошибка в разборе выглядела бы как «поиск ничего не нашёл»,
 * то есть модель молча осталась бы без результатов.
 *
 * Поддерживаются два вида: свой или публичный **SearxNG** (JSON, ключ не нужен —
 * подходит локальному первому запуску) и **Brave Search API** (нужен ключ).
 */

export const WEB_SEARCH_PROVIDERS = ['searxng', 'brave'] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export function isWebSearchProvider(value: unknown): value is WebSearchProvider {
  return typeof value === 'string' && (WEB_SEARCH_PROVIDERS as readonly string[]).includes(value);
}

/** Адрес по умолчанию: для SearxNG — своя установка на localhost, для Brave — их API. */
export function defaultWebSearchEndpoint(provider: WebSearchProvider): string {
  return provider === 'brave' ? 'https://api.search.brave.com/res/v1/web/search' : 'http://localhost:8080';
}

/** Наружу отдаём только http(s): другой схемы у веб-поиска быть не может. */
export function isAllowedSearchEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  // Открытый http — это передача запроса по сети в открытом виде. Разрешаем его
  // только для своего: localhost и частные диапазоны (домашний сервер SearxNG).
  return isLocalHostname(url.hostname);
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '127.0.0.1') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  // Имя без точки — своя машина в локальной сети (`searx` рядом с IDE).
  return !host.includes('.') && /^[a-z0-9-]+$/.test(host);
}

/** Один результат поиска в нашей форме. */
export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Снять разметку: описания приходят с `<b>` вокруг совпавших слов. */
export function stripTags(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Разобрать ответ поисковика. Схемы двух вендоров, но разбор терпим к лишнему:
 * отсутствие поля даёт пустую строку, а не исключение — один кривой результат не
 * должен отменять все остальные.
 */
export function parseSearchResponse(provider: WebSearchProvider, payload: unknown): WebSearchHit[] {
  const root = asRecord(payload);
  if (!root) return [];

  // SearxNG: результаты прямо в корне. Brave: внутри `web.results`.
  const raw = provider === 'brave' ? asRecord(root.web)?.results : root.results;
  if (!Array.isArray(raw)) return [];

  const hits: WebSearchHit[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;
    const url = asString(record.url);
    if (!url) continue;
    const title = stripTags(asString(record.title)) || url;
    // У SearxNG описание в `content`, у Brave — в `description`.
    const snippet = stripTags(asString(record.content) || asString(record.description));
    hits.push({ title, url, snippet });
  }
  return hits;
}

/**
 * Ответ инструмента. Ссылки приводим полностью: по короткому пути модель не
 * поймёт, куда ведёт результат. Источник — в сводке, чтобы человек видел, откуда
 * взялись строки.
 */
export function formatWebResults(
  query: string,
  providerLabel: string,
  hits: readonly WebSearchHit[],
): { summary: string; detail: string } {
  if (hits.length === 0) {
    return {
      summary: `«${query}»: ничего не найдено (${providerLabel})`,
      detail: `Поиск не вернул результатов. Попробуй другую формулировку или уточни запрос.`,
    };
  }

  const detail = hits
    .map((hit, index) => {
      const head = `${index + 1}. ${hit.title}`;
      const body = hit.snippet ? `\n   ${hit.snippet}` : '';
      return `${head}\n   ${hit.url}${body}`;
    })
    .join('\n\n');

  return {
    summary: `«${query}»: результатов ${hits.length} (${providerLabel})`,
    detail: `${detail}\n\nИсточник: ${providerLabel}. Это поисковая выдача, а не проверенный факт: на страницу по ссылке агент не ходил.`,
  };
}
