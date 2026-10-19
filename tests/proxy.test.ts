import { describe, expect, it } from 'vitest';
import {
  hasProxy,
  isLoopbackHost,
  noProxyMatches,
  parseNoProxy,
  proxyForUrl,
  proxySummary,
  readProxyEnv,
} from '../src/shared/proxy';

/**
 * Прокси из окружения. Разбор проверяем до последней запятой: ошибка здесь не
 * видна глазами — запросы просто уходят не туда, а человек ищет причину в ключе
 * и модели.
 */
describe('readProxyEnv', () => {
  it('читает три переменные и список исключений', () => {
    const settings = readProxyEnv({
      HTTP_PROXY: 'http://proxy.corp:3128',
      HTTPS_PROXY: 'http://proxy.corp:3129',
      ALL_PROXY: 'http://all.corp:8080',
      NO_PROXY: 'localhost, .corp.local ,10.0.0.5',
    });

    expect(settings.http).toBe('http://proxy.corp:3128');
    expect(settings.https).toBe('http://proxy.corp:3129');
    expect(settings.all).toBe('http://all.corp:8080');
    expect(settings.noProxy).toEqual(['localhost', '.corp.local', '10.0.0.5']);
  });

  it('регистр имени не важен: строчные встречаются чаще, чем кажется', () => {
    expect(readProxyEnv({ https_proxy: 'http://p:1' }).https).toBe('http://p:1');
    expect(readProxyEnv({ https_proxy: 'http://p:1' }).http).toBeUndefined();
  });

  it('пустое значение — не прокси', () => {
    const settings = readProxyEnv({ HTTP_PROXY: '   ', NO_PROXY: '' });
    expect(hasProxy(settings)).toBe(false);
    expect(settings.noProxy).toEqual([]);
  });

  it('разбор NO_PROXY выбрасывает пустые записи', () => {
    expect(parseNoProxy('a,, b , ')).toEqual(['a', 'b']);
    expect(parseNoProxy(undefined)).toEqual([]);
  });
});

describe('isLoopbackHost', () => {
  it('локальные адреса узнаются целиком, а не только 127.0.0.1', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('api.localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.15.0.9')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('example.com')).toBe(false);
    // Похоже на локальный, но не он: иначе весь этот блок ушёл бы мимо прокси.
    expect(isLoopbackHost('128.0.0.1')).toBe(false);
    expect(isLoopbackHost('localhost.example.com')).toBe(false);
  });
});

describe('noProxyMatches', () => {
  it('домен исключает и поддомены', () => {
    expect(noProxyMatches('corp.local', 'corp.local', '443')).toBe(true);
    expect(noProxyMatches('corp.local', 'git.corp.local', '443')).toBe(true);
    expect(noProxyMatches('.corp.local', 'git.corp.local', '443')).toBe(true);
    expect(noProxyMatches('corp.local', 'notcorp.local', '443')).toBe(false);
  });

  it('порт важен: host:port исключает только свой порт', () => {
    expect(noProxyMatches('db:5432', 'db', '5432')).toBe(true);
    expect(noProxyMatches('db:5432', 'db', '443')).toBe(false);
  });

  it('IPv6 в скобках с портом разбирается', () => {
    expect(noProxyMatches('[::1]:8080', '::1', '8080')).toBe(true);
    expect(noProxyMatches('[::1]:8080', '::1', '443')).toBe(false);
  });

  it('звёздочка исключает всё', () => {
    expect(noProxyMatches('*', 'example.com', '443')).toBe(true);
    expect(noProxyMatches('', 'example.com', '443')).toBe(false);
  });
});

describe('proxyForUrl', () => {
  const settings = readProxyEnv({
    HTTP_PROXY: 'http://proxy.corp:3128',
    HTTPS_PROXY: 'http://proxy.corp:3129',
    NO_PROXY: 'corp.local,internal:8443',
  });

  it('https идёт через https-прокси, http — через http-прокси', () => {
    expect(proxyForUrl(settings, 'https://api.openai.com/v1/chat').proxy).toBe('http://proxy.corp:3129');
    expect(proxyForUrl(settings, 'http://example.com/').proxy).toBe('http://proxy.corp:3128');
  });

  it('локальный адрес всегда напрямую', () => {
    const choice = proxyForUrl(settings, 'http://127.0.0.1:8123/status');
    expect(choice.proxy).toBeUndefined();
    expect(choice.reason).toContain('локальный');
  });

  it('NO_PROXY действует и на поддомены, и на конкретный порт', () => {
    expect(proxyForUrl(settings, 'https://git.corp.local/repo').proxy).toBeUndefined();
    expect(proxyForUrl(settings, 'https://internal:8443/x').reason).toContain('NO_PROXY');
    // Тот же хост по другому порту — уже через прокси.
    expect(proxyForUrl(settings, 'https://internal:443/x').proxy).toBe('http://proxy.corp:3129');
  });

  it('ALL_PROXY годится обоим протоколам, если конкретных нет', () => {
    const onlyAll = readProxyEnv({ ALL_PROXY: 'http://all:8080' });
    expect(proxyForUrl(onlyAll, 'https://a.example/').proxy).toBe('http://all:8080');
    expect(proxyForUrl(onlyAll, 'http://b.example/').proxy).toBe('http://all:8080');
  });

  it('SOCKS отвергаем словами, а не молча', () => {
    const socks = readProxyEnv({ ALL_PROXY: 'socks5://127.0.0.1:1080' });
    const choice = proxyForUrl(socks, 'https://a.example/');
    expect(choice.proxy).toBeUndefined();
    expect(choice.error).toContain('SOCKS');
    expect(choice.error).toContain('http://');
  });

  it('без настроек — напрямую и без объяснений', () => {
    expect(proxyForUrl(readProxyEnv({}), 'https://a.example/')).toEqual({});
  });
});

describe('proxySummary', () => {
  it('называет протоколы и исключения, но не логин с паролем', () => {
    const settings = readProxyEnv({
      HTTPS_PROXY: 'http://user:secret@proxy.corp:3129',
      NO_PROXY: 'corp.local',
    });
    const text = proxySummary(settings);
    // Адрес прокси со схемой http — так его и показываем: https здесь про запрос.
    expect(text).toContain('http://proxy.corp:3129');
    expect(text).toContain('corp.local');
    expect(text).not.toContain('secret');
  });
});
