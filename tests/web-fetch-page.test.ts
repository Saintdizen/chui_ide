import { describe, expect, it } from 'vitest';
import { fetchPage } from '../src/main/ai/web-fetch';

/**
 * Загрузка страницы: что делает `fetchPage` с ответом сервера.
 *
 * Сети здесь нет — `fetch` подменён, и это то, ради чего он вынесен параметром:
 * проверить надо наше поведение (отказы, обрезку, разбор), а не чужой сервер.
 * Отдельно проверяется то, что иначе видно только руками: ошибочный код, не
 * текстовая страница, слишком большое тело и кодировка из заголовка.
 */

const ok = (body: string, init: { type?: string; url?: string; status?: number } = {}): Response => {
  const headers = new Headers();
  headers.set('content-type', init.type ?? 'text/html; charset=utf-8');
  const response = new Response(body, { status: init.status ?? 200, headers });
  if (init.url) Object.defineProperty(response, 'url', { value: init.url });
  return response;
};

describe('fetchPage: что читается', () => {
  it('страница отдаётся текстом, с заголовком и ссылками', async () => {
    const page = await fetchPage('https://example.com/docs#top', {
      fetchImpl: async () =>
        ok(
          '<html><head><title>Документация</title></head><body>' +
            '<h1>Сборка</h1><p>Запусти <code>npm run build</code>.</p>' +
            '<a href="/install">Установка</a></body></html>',
          { url: 'https://example.com/docs' },
        ),
    });

    expect(page.url).toBe('https://example.com/docs');
    expect(page.finalUrl).toBe('https://example.com/docs');
    expect(page.title).toBe('Документация');
    expect(page.text).toContain('Запусти');
    expect(page.text).toContain('npm run build');
    // Разметки в тексте быть не должно: модель читает текст, а не теги.
    expect(page.text).not.toContain('<h1>');
    expect(page.links).toEqual([{ text: 'Установка', url: 'https://example.com/install' }]);
    expect(page.truncated).toBe(false);
  });

  it('переезд страницы виден: адрес берётся из ответа', async () => {
    const page = await fetchPage('https://example.com/old', {
      fetchImpl: async () => ok('<p>тут</p>', { url: 'https://example.com/new' }),
    });
    expect(page.finalUrl).toBe('https://example.com/new');
    expect(page.links).toEqual([]);
  });

  it('текст без разметки отдаётся как есть', async () => {
    const page = await fetchPage('https://example.com/robots.txt', {
      fetchImpl: async () => ok('User-agent: *\nDisallow:', { type: 'text/plain' }),
    });
    expect(page.text).toBe('User-agent: *\nDisallow:');
    expect(page.title).toBe('');
  });

  it('кодировка берётся из заголовка, а не угадывается', async () => {
    // Windows-1251: «Привет» в этой кодировке — байты CF F0 E8 E2 E5 F2.
    const bytes = Uint8Array.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    const headers = new Headers({ 'content-type': 'text/plain; charset=windows-1251' });
    const page = await fetchPage('https://example.com/win', {
      fetchImpl: async () => new Response(bytes, { status: 200, headers }),
    });
    expect(page.text).toBe('Привет');
  });
});

describe('fetchPage: отказы', () => {
  it('не http(s) — не ходим вовсе', async () => {
    let called = 0;
    await expect(
      fetchPage('file:///etc/passwd', {
        fetchImpl: async () => {
          called += 1;
          return ok('текст');
        },
      }),
    ).rejects.toThrow('http или https');
    expect(called).toBe(0);
  });

  it('ошибочный код назван, и 404 объясняется словами', async () => {
    await expect(
      fetchPage('https://example.com/gone', { fetchImpl: async () => ok('нет', { status: 404 }) }),
    ).rejects.toThrow('кодом 404 — такой страницы нет');
    await expect(
      fetchPage('https://example.com/secret', { fetchImpl: async () => ok('нет', { status: 403 }) }),
    ).rejects.toThrow('не пускает');
  });

  it('файл вместо страницы отвергается с объяснением', async () => {
    await expect(
      fetchPage('https://example.com/a.pdf', {
        fetchImpl: async () => ok('%PDF-1.7', { type: 'application/pdf' }),
      }),
    ).rejects.toThrow('лежит файл (application/pdf)');
  });

  it('сеть отказала — причина словами, а не «fetch failed»', async () => {
    const error = new TypeError('fetch failed');
    (error as unknown as { cause: { code: string } }).cause = { code: 'ENOTFOUND' };
    await expect(
      fetchPage('https://no-such-host.example/', {
        fetchImpl: async () => {
          throw error;
        },
      }),
    ).rejects.toThrow('Такого адреса нет: no-such-host.example');
  });

  it('таймаут назван отдельно от отказа соединения', async () => {
    const error = new Error('signal timed out');
    error.name = 'TimeoutError';
    await expect(
      fetchPage('https://slow.example/', {
        fetchImpl: async () => {
          throw error;
        },
      }),
    ).rejects.toThrow('не ответила за 20 с');
  });
});

describe('fetchPage: потолки', () => {
  it('текст режется по maxChars и помечается', async () => {
    const body = `<p>${'а'.repeat(5000)}</p>`;
    const page = await fetchPage('https://example.com/long', {
      fetchImpl: async () => ok(body),
      maxChars: 1000,
    });
    expect(page.truncated).toBe(true);
    expect(page.text.length).toBe(1000);
    expect(page.totalChars).toBe(5000);
  });

  it('тело сверх потолка не читается целиком', async () => {
    const big = `<p>${'а'.repeat(3000)}</p>`;
    const page = await fetchPage('https://example.com/big', {
      fetchImpl: async () => ok(big),
      maxBytes: 500,
    });
    expect(page.truncated).toBe(true);
    expect(page.text.length).toBeLessThan(3000);
  });

  it('content-length больше потолка — читаем только начало', async () => {
    const headers = new Headers({ 'content-type': 'text/html', 'content-length': '999999' });
    const page = await fetchPage('https://example.com/huge', {
      fetchImpl: async () => new Response(`<p>${'б'.repeat(800)}</p>`, { status: 200, headers }),
      maxBytes: 300,
    });
    expect(page.truncated).toBe(true);
  });
});
