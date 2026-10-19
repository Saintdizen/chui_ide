import {
  clampPageText,
  extractLinks,
  extractTitle,
  fetchUrlProblem,
  htmlToText,
  normalizeFetchUrl,
  type FetchedPage,
} from '../../shared/web-fetch';

/**
 * Загрузка страницы по ссылке для инструмента `web_fetch`.
 *
 * Второе место в проекте (после веб-поиска), которое ходит во внешнюю сеть по
 * просьбе модели. Поэтому те же ограничения и ещё два своих: адрес проверяется
 * до запроса (только http/https), а тело читается с потолком — иначе одна ссылка
 * на многометровый ответ держала бы шаг агента и съедала память.
 *
 * HTML разбирается в текст здесь же (`shared/web-fetch.ts`), а `fetch` можно
 * подменить параметром: проверка поведения без сети — обычный тест, а не проба.
 */

/** Дольше ждать страницу незачем: человек уже ушёл, а шаг агента стоит токенов. */
const TIMEOUT_MS = 20_000;

/** Потолок тела ответа. Страницы читают глазами, а не мегабайтами. */
const MAX_BODY_BYTES = 4_000_000;

/** Кто мы для того сайта: без подписи часть серверов отвечает отказом. */
const USER_AGENT = 'Mozilla/5.0 (compatible; chui_iDE web_fetch)';

/** Что готовы читать текстом. Остальное — файл, и его читает не этот инструмент. */
const TEXTUAL = /^(text\/|application\/(xhtml\+xml|json|xml|ld\+json))/i;

export interface FetchPageOptions {
  /** Отмена агентом («Стоп»). */
  signal?: AbortSignal;
  /** Потолок текста для модели. */
  maxChars?: number;
  /** Подмена сети в тестах: настоящий `fetch` по умолчанию. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

export async function fetchPage(rawUrl: string, options: FetchPageOptions = {}): Promise<FetchedPage> {
  const problem = fetchUrlProblem(rawUrl);
  if (problem) throw new Error(problem);
  const url = normalizeFetchUrl(rawUrl);

  const timeout = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(url, {
      signal,
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5',
        'accept-language': 'ru,en;q=0.8',
      },
    });
  } catch (error) {
    throw new Error(describeNetworkError(error, url));
  }

  // Тело читаем и у ошибочных ответов: у 404 и 500 бывает текст с объяснением,
  // и он полезнее голого кода. Но успехом такой ответ не считаем.
  const contentType = response.headers.get('content-type') ?? '';
  const kind = contentType.split(';')[0]!.trim().toLowerCase();
  const textual = TEXTUAL.test(kind) || kind === '' || kind === 'application/xhtml+xml';

  if (!response.ok) {
    throw new Error(
      `Страница ответила кодом ${response.status}${response.statusText ? ` ${response.statusText}` : ''}` +
        (response.status === 403 || response.status === 401
          ? ' — сайт не пускает без входа или блокирует автоматические запросы'
          : response.status === 404
            ? ' — такой страницы нет'
            : ''),
    );
  }
  if (!textual) {
    throw new Error(
      `По адресу лежит файл (${kind}), а не страница: web_fetch читает страницы и текст. ` +
        'Файл скачивается терминалом (curl) или смотрится браузером.',
    );
  }

  const body = await readLimited(response, options.maxBytes ?? MAX_BODY_BYTES);
  const charset = /charset=([^;\s]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  const decoded = decodeBody(body.bytes, charset);

  const isHtml = kind === 'text/html' || kind === 'application/xhtml+xml' || kind === '';
  const text = isHtml ? htmlToText(decoded) : decoded.trim();
  const title = isHtml ? extractTitle(decoded) : '';
  const links = isHtml ? extractLinks(decoded, url) : [];
  const clamped = clampPageText(text, options.maxChars);

  return {
    url,
    finalUrl: response.url || url,
    contentType: kind || 'text/html',
    status: response.status,
    title,
    text: clamped.text,
    links,
    // Ответ мог быть длиннее потолка тела: тогда текста заведомо не всё.
    truncated: clamped.truncated || body.overflow,
    totalChars: body.overflow ? Math.max(clamped.text.length, text.length) : text.length,
  };
}

/** Тело ответа с потолком: лишнее не читаем вовсе, а не отбрасываем после. */
async function readLimited(response: Response, limit: number): Promise<{ bytes: Uint8Array; overflow: boolean }> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) {
    return { bytes: await readAll(response, limit), overflow: true };
  }
  if (!response.body) {
    return { bytes: new Uint8Array(await readArrayBuffer(response)), overflow: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (size + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - size));
      size = limit;
      overflow = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, overflow };
}

/** Прочитать не больше `limit` байт: остальное отбрасываем. */
async function readAll(response: Response, limit: number): Promise<Uint8Array> {
  const all = new Uint8Array(await readArrayBuffer(response));
  return all.byteLength > limit ? all.subarray(0, limit) : all;
}

async function readArrayBuffer(response: Response): Promise<ArrayBuffer> {
  try {
    return await response.arrayBuffer();
  } catch {
    return new ArrayBuffer(0);
  }
}

/**
 * Байты в строку по кодировке из заголовка. Без кодировки — UTF-8: так отдаёт
 * почти всё, а сервер, назвавший кодировку неправильно, всё равно виноват сам.
 */
function decodeBody(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/** Сетевые отказы словами: «fetch failed» модели ничего не говорит. */
function describeNetworkError(error: unknown, url: string): string {
  const host = safeHost(url);
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `Страница не ответила за ${Math.round(TIMEOUT_MS / 1000)} с: ${host}`;
  }
  const cause = error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
  const code = cause?.code;
  if (code === 'ENOTFOUND') return `Такого адреса нет: ${host}`;
  if (code === 'ECONNREFUSED') return `Соединение отклонено: ${host}`;
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code?.includes('CERT')) {
    return `Сертификат сайта не принят: ${host}`;
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return `Нет связи: ${host} не ответил`;
  const reason = error instanceof Error ? error.message : String(error);
  return `Не удалось открыть ${host}: ${reason}`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
