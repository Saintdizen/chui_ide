import { describe, expect, it } from 'vitest';
import {
  defaultWebSearchEndpoint,
  formatWebResults,
  isAllowedSearchEndpoint,
  isWebSearchProvider,
  parseSearchResponse,
  stripTags,
} from '../src/shared/web-search';

/**
 * Разбор ответа и допуск адреса. Ошибка в разборе выглядит как «поиск ничего не
 * нашёл», поэтому обе схемы проверяются на настоящих формах ответов вендоров.
 */
describe('parseSearchResponse', () => {
  it('SearxNG: результаты в корне, описание в content', () => {
    const hits = parseSearchResponse('searxng', {
      query: 'x',
      results: [
        { title: 'Первая', url: 'https://a.example/1', content: 'описание первой' },
        { title: 'Вторая', url: 'https://b.example/2', content: 'описание второй' },
      ],
    });

    expect(hits).toEqual([
      { title: 'Первая', url: 'https://a.example/1', snippet: 'описание первой' },
      { title: 'Вторая', url: 'https://b.example/2', snippet: 'описание второй' },
    ]);
  });

  it('Brave: результаты внутри web, описание в description', () => {
    const hits = parseSearchResponse('brave', {
      web: { results: [{ title: 'Док', url: 'https://doc.example', description: 'как это работает' }] },
    });

    expect(hits).toEqual([{ title: 'Док', url: 'https://doc.example', snippet: 'как это работает' }]);
  });

  it('разметку в описании снимаем', () => {
    const hits = parseSearchResponse('brave', {
      web: {
        results: [{ title: '<b>API</b>', url: 'https://d.example', description: 'про <b>embed</b> &amp; токены' }],
      },
    });

    expect(hits[0]).toEqual({ title: 'API', url: 'https://d.example', snippet: 'про embed & токены' });
  });

  it('мусор вместо ответа не роняет разбор', () => {
    expect(parseSearchResponse('searxng', null)).toEqual([]);
    expect(parseSearchResponse('searxng', 'строка')).toEqual([]);
    expect(parseSearchResponse('brave', { web: {} })).toEqual([]);
    expect(parseSearchResponse('searxng', { results: 'нет' })).toEqual([]);
  });

  it('результат без url пропускаем, без заголовка — берём url', () => {
    const hits = parseSearchResponse('searxng', {
      results: [{ title: 'Пусто', content: 'x' }, { url: 'https://e.example' }],
    });

    expect(hits).toEqual([{ title: 'https://e.example', url: 'https://e.example', snippet: '' }]);
  });
});

describe('isAllowedSearchEndpoint', () => {
  it('https разрешён всегда', () => {
    expect(isAllowedSearchEndpoint('https://searx.example.org')).toBe(true);
    expect(isAllowedSearchEndpoint('https://api.search.brave.com/res/v1/web/search')).toBe(true);
  });

  it('открытый http — только для своего', () => {
    expect(isAllowedSearchEndpoint('http://localhost:8080')).toBe(true);
    expect(isAllowedSearchEndpoint('http://127.0.0.1:8080')).toBe(true);
    expect(isAllowedSearchEndpoint('http://192.168.1.5:8080')).toBe(true);
    expect(isAllowedSearchEndpoint('http://searx:8080')).toBe(true);
    // Публичный http — это запрос по сети в открытом виде.
    expect(isAllowedSearchEndpoint('http://searx.example.org')).toBe(false);
    expect(isAllowedSearchEndpoint('http://8.8.8.8')).toBe(false);
  });

  it('чужая схема не проходит', () => {
    expect(isAllowedSearchEndpoint('file:///etc/passwd')).toBe(false);
    expect(isAllowedSearchEndpoint('ftp://host/')).toBe(false);
    expect(isAllowedSearchEndpoint('javascript:alert(1)')).toBe(false);
    expect(isAllowedSearchEndpoint('не адрес')).toBe(false);
    expect(isAllowedSearchEndpoint('')).toBe(false);
  });

  it('адреса по умолчанию допустимы', () => {
    expect(isAllowedSearchEndpoint(defaultWebSearchEndpoint('searxng'))).toBe(true);
    expect(isAllowedSearchEndpoint(defaultWebSearchEndpoint('brave'))).toBe(true);
  });
});

describe('isWebSearchProvider', () => {
  it('знает только свои виды поиска', () => {
    expect(isWebSearchProvider('brave')).toBe(true);
    expect(isWebSearchProvider('searxng')).toBe(true);
    expect(isWebSearchProvider('google')).toBe(false);
    expect(isWebSearchProvider(undefined)).toBe(false);
  });
});

describe('stripTags', () => {
  it('снимает теги, сущности и лишние пробелы', () => {
    expect(stripTags('<p>a &amp; b</p>\n\n <b>c</b>')).toBe('a & b c');
    expect(stripTags('без тегов')).toBe('без тегов');
  });
});

describe('formatWebResults', () => {
  it('нумерует результаты и предупреждает, что страницу не читали', () => {
    const { summary, detail } = formatWebResults('ffmpeg scale', 'Brave', [
      { title: 'Документация', url: 'https://ffmpeg.org/scale', snippet: 'фильтр scale' },
      { title: 'Пример', url: 'https://ex.example', snippet: '' },
    ]);

    expect(summary).toBe('«ffmpeg scale»: результатов 2 (Brave)');
    expect(detail).toContain('1. Документация\n   https://ffmpeg.org/scale\n   фильтр scale');
    expect(detail).toContain('2. Пример\n   https://ex.example');
    expect(detail).toContain('на страницу по ссылке агент не ходил');
  });

  it('пустая выдача — это не ошибка, но и не ответ', () => {
    const { summary, detail } = formatWebResults('нечто', 'SearxNG', []);
    expect(summary).toContain('ничего не найдено');
    expect(detail).toContain('другую формулировку');
  });
});

describe('isAllowedSearchEndpoint: частные диапазоны и имена', () => {
  it('частные диапазоны считаются своими', () => {
    expect(isAllowedSearchEndpoint('http://127.0.0.5:8080')).toBe(true);
    expect(isAllowedSearchEndpoint('http://10.1.2.3:8080')).toBe(true);
    expect(isAllowedSearchEndpoint('http://172.16.0.1:8080')).toBe(true);
    expect(isAllowedSearchEndpoint('http://172.31.255.254')).toBe(true);
  });

  it('172 вне диапазона 16–31 — уже не свой', () => {
    expect(isAllowedSearchEndpoint('http://172.15.0.1')).toBe(false);
    expect(isAllowedSearchEndpoint('http://172.32.0.1')).toBe(false);
  });

  it('IPv6-петля в скобках — локальная', () => {
    expect(isAllowedSearchEndpoint('http://[::1]:8080')).toBe(true);
  });
});

describe('parseSearchResponse: мусор внутри выдачи', () => {
  it('не-объекты в списке результатов пропускаются', () => {
    const hits = parseSearchResponse('searxng', {
      results: [null, 'строка', 42, { url: 'https://ok.example' }],
    });
    expect(hits).toEqual([{ title: 'https://ok.example', url: 'https://ok.example', snippet: '' }]);
  });
});
