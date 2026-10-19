/**
 * Прокси из окружения.
 *
 * В корпоративной сети наружу выходят только через прокси, и задают его
 * переменными `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`/`NO_PROXY` — так делают
 * curl, git и большинство инструментов. Мы их не читали вовсе: агент молча не
 * мог ни спросить модель, ни открыть страницу.
 *
 * Разбор переменных живёт здесь, в `shared`: он чистый, и его проверяют тесты.
 * Применение (диспетчер undici) — `main/net/proxy.ts`, потому что только в main
 * есть сеть.
 *
 * Чего сознательно не делаем: SOCKS (`socks5://` отвергаем словами, а не молча
 * игнорируем) и чтение системных настроек ОС — у нас переменные окружения, один
 * источник правды для IDE и её дочерних процессов.
 */

/** Окружение: значения могут отсутствовать, регистр имён у людей разный. */
export type ProxyEnv = Record<string, string | undefined>;

/** Что нашли в окружении. Пустая строка/пробелы — «не задано». */
export interface ProxySettings {
  /** Прокси для `http://`-запросов. */
  http?: string;
  /** Прокси для `https://`-запросов. */
  https?: string;
  /** `ALL_PROXY` — общий, если конкретного нет. */
  all?: string;
  /** `NO_PROXY` как список строк (запятые уже разобраны). */
  noProxy: string[];
}

/** Порт по умолчанию, если в переменной прокси его нет. */
export const PROXY_DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 };

/** Значение переменной без учёта регистра имени: `HTTPS_PROXY` и `https_proxy`. */
function envValue(env: ProxyEnv, name: string): string | undefined {
  const direct = env[name];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === name && typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** `NO_PROXY` — записи через запятую (пробелы вокруг — украшение). */
export function parseNoProxy(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '');
}

/**
 * Прочитать переменные окружения. Порядок важнее, чем кажется: у curl и git
 * `HTTPS_PROXY` — для https-запросов, `HTTP_PROXY` — для http, `ALL_PROXY` —
 * общий. Схема «https на http-прокси» законна: так устроены почти все прокси
 * в офисах (CONNECT через 80-й порт).
 */
export function readProxyEnv(env: ProxyEnv): ProxySettings {
  const http = envValue(env, 'HTTP_PROXY');
  const https = envValue(env, 'HTTPS_PROXY');
  const all = envValue(env, 'ALL_PROXY');
  return {
    ...(http ? { http } : {}),
    ...(https ? { https } : {}),
    ...(all ? { all } : {}),
    noProxy: parseNoProxy(envValue(env, 'NO_PROXY')),
  };
}

/** Есть ли в настройках хоть один прокси: пустые настройки применять незачем. */
export function hasProxy(settings: ProxySettings): boolean {
  return Boolean(settings.http || settings.https || settings.all);
}

/** Локальные адреса: туда прокси не нужен никогда — иначе IDE не увидит себя. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  // 127.0.0.0/8 — весь блок, а не только 127.0.0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

/**
 * Подходит ли запись `NO_PROXY` этому хосту и порту.
 *
 * Поддерживаем то, чем пользуются на практике: `*`, домен (`example.com` —
 * он же и поддомены, и `.example.com`), `host:port` и просто host. CIDR
 * (`10.0.0.0/8`) намеренно не разбираем: ошибиться в нём хуже, чем спросить
 * прокси, а маски в `NO_PROXY` встречаются куда реже доменов.
 */
export function noProxyMatches(entry: string, hostname: string, port: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const rule = entry.trim().toLowerCase().replace(/^\./, '');
  if (!rule) return false;
  if (rule === '*') return true;

  // `host:port` — исключение только для этого порта. У IPv6 запись выглядит
  // как `[::1]:8080`, поэтому двоеточие ищется после скобки.
  const at = rule.startsWith('[') ? rule.indexOf(']:') : rule.indexOf(':');
  if (at > 0) {
    const ruleHost = rule
      .slice(0, at)
      .replace(/^\[|\]$/g, '')
      .replace(/^\./, '');
    const rulePort = rule.slice(rule.startsWith('[') ? at + 2 : at + 1);
    return rulePort === port && (ruleHost === host || host.endsWith(`.${ruleHost}`));
  }

  // Голый домен — правило и для поддоменов: так же ведёт себя curl.
  return rule === host || host.endsWith(`.${rule}`);
}

/** Решение по одному адресу: через какой прокси идти или почему напрямую. */
export interface ProxyChoice {
  /** Адрес прокси, если он нужен. */
  proxy?: string;
  /** Почему без прокси — по-русски, для подсказки в ошибке. */
  reason?: string;
  /** Отказ: прокси этого вида мы не поддерживаем. */
  error?: string;
}

/**
 * Какой прокси применить к адресу. Пустая настройка — «напрямую».
 *
 * Loopback и `NO_PROXY` проверяются раньше прокси: иначе локальный сервер
 * языков или встроенный браузер уходили бы в корпоративный прокси, и IDE
 * переставала бы видеть саму себя.
 */
export function proxyForUrl(settings: ProxySettings, url: string): ProxyChoice {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { reason: 'адрес не разобран' };
  }

  const port = parsed.port || String(PROXY_DEFAULT_PORTS[parsed.protocol.replace(':', '')] ?? '');
  if (isLoopbackHost(parsed.hostname)) return { reason: 'локальный адрес — напрямую' };

  for (const entry of settings.noProxy) {
    if (noProxyMatches(entry, parsed.hostname, port)) return { reason: `адрес в NO_PROXY (${entry})` };
  }

  const chosen = (parsed.protocol === 'https:' ? settings.https : settings.http) ?? settings.all ?? settings.https;
  if (!chosen) return {};

  // SOCKS мы не умеем: молча игнорировать нельзя — человек будет искать причину.
  if (/^socks/i.test(chosen)) {
    return {
      error:
        `Прокси «${chosen}» не поддерживается: SOCKS в IDE не подключён. ` +
        'Задайте HTTP-прокси (http:// или https://) — или NO_PROXY для этого адреса.',
    };
  }
  return { proxy: chosen };
}

/**
 * Сводка «что включено» — одной строкой для уведомления при старте и для
 * трассы. Секретов в ней нет: логин и пароль из адреса прокси вырезаются.
 */
export function proxySummary(settings: ProxySettings): string {
  const parts: string[] = [];
  const safe = (value: string): string => {
    try {
      const parsed = new URL(value);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return value;
    }
  };
  if (settings.https) parts.push(`https: ${safe(settings.https)}`);
  if (settings.http) parts.push(`http: ${safe(settings.http)}`);
  if (!settings.http && !settings.https && settings.all) parts.push(`всё: ${safe(settings.all)}`);
  const bypass = settings.noProxy.length > 0 ? `; мимо: ${settings.noProxy.join(', ')}` : '';
  return `Прокси из окружения — ${parts.join(', ')}${bypass}`;
}
