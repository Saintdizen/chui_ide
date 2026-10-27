/**
 * Прокси для HTTP-вызовов из main.
 *
 * У `fetch` в Node нет прокси вовсе: в корпоративной сети модель не отвечала, а
 * `web_fetch` молчал, и причину приходилось угадывать. Здесь прокси из
 * окружения (разбор — `shared/proxy.ts`) применяется в одном месте, а дальше им
 * пользуются все сетевые вызовы: провайдеры, веб-поиск, чтение страниц.
 *
 * Диспетчер — `EnvHttpProxyAgent` из undici, а не `ProxyAgent`: первый для
 * `http://` отправляет запрос прокси как есть (absolute URI), а туннель
 * `CONNECT` оставляет только для `https://`. Голый `ProxyAgent` туннелирует всё
 * подряд, и на прокси, который не пускает `CONNECT` на 80-й порт, обычный
 * http-запрос просто зависал.
 *
 * Через undici идём только когда прокси действительно есть: без него глобальный
 * `fetch` ведёт себя ровно как раньше, и лишнего посредника в пути нет.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { hasProxy, proxyForUrl, readProxyEnv, type ProxyEnv, type ProxySettings } from '../../shared/proxy';

/** Настройки, прочитанные при старте: окружение за время работы не меняется. */
let settings: ProxySettings = readProxyEnv({});

/** Диспетчер с прокси; `null` — ходим напрямую. */
let dispatcher: Dispatcher | null = null;

/**
 * Перечитать окружение и собрать диспетчер. Возвращает настройки — их видно в
 * логе и в трассе, чтобы вопрос «идёт ли трафик через прокси» не гадался.
 */
export function installProxyFromEnv(env: ProxyEnv = process.env): ProxySettings {
  settings = readProxyEnv(env);

  const previous = dispatcher;
  dispatcher = null;
  if (previous) void previous.close().catch(() => undefined);

  if (!hasProxy(settings)) return settings;

  // ALL_PROXY закрывает то, чего нет по конкретной схеме. Если задан только
  // https-прокси, http-запросы тоже через него: в офисах это один и тот же хост.
  dispatcher = new EnvHttpProxyAgent({
    httpProxy: settings.http ?? settings.all ?? settings.https,
    httpsProxy: settings.https ?? settings.all ?? settings.http,
    noProxy: settings.noProxy.join(','),
  });
  return settings;
}

/** Что включено сейчас — для подсказок и проверок. */
export function proxySettings(): ProxySettings {
  return settings;
}

/**
 * `fetch` с прокси из окружения. Подпись намеренно совпадает с глобальным:
 * вызывающий код не должен знать, идёт запрос напрямую или через прокси.
 *
 * Отказ (`socks5://`) — исключение с объяснением: молча идти напрямую было бы
 * хуже, ответ пришёл бы не туда и не тот.
 */
export async function netFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const choice = proxyForUrl(settings, url);
  if (choice.error) throw new Error(choice.error);
  if (!choice.proxy || !dispatcher) return fetch(input, init);

  // http:// идёт обычным запросом к прокси, https:// — туннелем: см. `httpViaProxy`.
  if (url.startsWith('http://')) return httpViaProxy(new URL(url), new URL(choice.proxy), init);

  // Типы undici и глобального `fetch` расходятся только объявлением: и там, и
  // там `Response` — структура с потоком в теле.
  const undiciInit = { ...init, dispatcher } as unknown as Parameters<typeof undiciFetch>[1];
  return (await undiciFetch(input as unknown as Parameters<typeof undiciFetch>[0], undiciInit)) as unknown as Response;
}

/**
 * `http://`-цель через HTTP-прокси — обычным запросом с абсолютным адресом.
 *
 * Так делает и curl: для `http://` туннель `CONNECT` не нужен, а многие
 * корпоративные прокси на 80-й порт его и не пускают. `undici` же туннелирует
 * всё подряд (проверено на заглушке: запрос просто висит), поэтому этот путь
 * собран на `node:http` — здесь он короткий и предсказуемый.
 *
 * Тело — строка или Buffer: ровно столько нужно нашим вызовам (JSON провайдеру).
 * Потоковое тело не поддерживаем сознательно: ошибиться в ручной перекачке
 * проще, чем выиграть, а используется у нас только строка.
 */
function httpViaProxy(target: URL, proxy: URL, init: RequestInit, redirectsLeft = 5): Promise<Response> {
  return new Promise((resolve, reject) => {
    const secure = proxy.protocol === 'https:';
    // Обе функции перегружены одинаково; приводим тип один раз, чтобы вызов ниже
    // читался как обычный `request(options, callback)`.
    type RequestFn = (
      options: https.RequestOptions,
      callback: (response: http.IncomingMessage) => void,
    ) => http.ClientRequest;
    const transport: RequestFn = secure ? (https.request as RequestFn) : (http.request as RequestFn);
    const headers: Record<string, string> = { host: target.host };
    new Headers(init.headers ?? {}).forEach((value, key) => {
      if (key.toLowerCase() !== 'host') headers[key] = value;
    });

    const body = init.body;
    if (body !== undefined && body !== null && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      reject(new Error('Прокси не поддерживает потоковое тело запроса'));
      return;
    }
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      headers['content-length'] = String(Buffer.byteLength(body));
    }

    const request = transport(
      {
        host: proxy.hostname,
        port: proxy.port || (secure ? 443 : 80),
        method: init.method ?? 'GET',
        // Абсолютный адрес — так прокси понимает, куда идти.
        path: target.toString(),
        headers,
        ...(secure ? { servername: proxy.hostname } : {}),
      },
      (response) => {
        const status = response.statusCode ?? 502;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location && redirectsLeft > 0 && init.redirect !== 'manual') {
          response.resume();
          httpViaProxy(new URL(location, target), proxy, init, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        const outHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') outHeaders.set(key, value);
          else if (Array.isArray(value)) outHeaders.set(key, value.join(', '));
        }
        // Поток ответа отдаём глобальному `Response` как есть: он его и читает.
        const stream = response as unknown as ReadableStream<Uint8Array>;
        // `url` у глобального `Response` только для чтения, а `web_fetch` по нему
        // показывает, куда в итоге пришёл редирект: подставляем адрес сами.
        const out = new Response(stream, { status, headers: outHeaders });
        Object.defineProperty(out, 'url', { value: target.toString() });
        resolve(out);
      },
    );

    request.on('error', reject);
    const signal = init.signal;
    if (signal) {
      const abort = (): void => {
        request.destroy(new DOMException('Aborted', 'AbortError'));
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }

    if (body === undefined || body === null) request.end();
    else request.end(body as string | Buffer);
  });
}
