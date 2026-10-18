import { describe, expect, it } from 'vitest';
import {
  formatBrowserSnapshot,
  formatPickedElement,
  isLocalHost,
  isLocalUrl,
  MAX_SNAPSHOT_ELEMENTS,
  MAX_SNAPSHOT_TEXT,
  normalizeBrowserUrl,
  parseDevToolsEndpoint,
  sanitizePickedElement,
  SNAPSHOT_SCRIPT,
  sanitizeSnapshot,
} from '../src/shared/browser';

describe('normalizeBrowserUrl', () => {
  it('адрес без схемы идёт по https', () => {
    expect(normalizeBrowserUrl('example.com/docs')).toEqual({ ok: true, url: 'https://example.com/docs' });
  });

  it('локальные адреса — по http: у них нет сертификата', () => {
    expect(normalizeBrowserUrl('localhost:3000/app')).toEqual({ ok: true, url: 'http://localhost:3000/app' });
    expect(normalizeBrowserUrl('127.0.0.1:8080')).toEqual({ ok: true, url: 'http://127.0.0.1:8080/' });
  });

  it('явную схему не переписываем', () => {
    expect(normalizeBrowserUrl('http://example.com')).toEqual({ ok: true, url: 'http://example.com/' });
    expect(normalizeBrowserUrl('https://example.com')).toEqual({ ok: true, url: 'https://example.com/' });
  });

  it('чужие схемы отвергаются с причиной', () => {
    for (const raw of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<h1>x']) {
      const result = normalizeBrowserUrl(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/http/);
    }
  });

  it('пустой адрес и пробел — это ошибка, а не догадка', () => {
    expect(normalizeBrowserUrl('   ').ok).toBe(false);
    const spaced = normalizeBrowserUrl('example.com/две части');
    expect(spaced.ok).toBe(false);
    if (!spaced.ok) expect(spaced.reason).toContain('пробел');
  });

  it('мусор без хоста не проходит', () => {
    expect(normalizeBrowserUrl('https://').ok).toBe(false);
  });
});

describe('isLocalHost', () => {
  it('узнаёт localhost и петлевые адреса, но не похожие имена', () => {
    expect(isLocalHost('localhost:5173')).toBe(true);
    expect(isLocalHost('127.0.0.1')).toBe(true);
    expect(isLocalHost('[::1]:8080')).toBe(true);
    expect(isLocalHost('localhost.example.com')).toBe(false);
    expect(isLocalHost('127.0.0.1.example.com')).toBe(false);
  });

  it('«все интерфейсы» — тоже своя машина', () => {
    expect(isLocalHost('0.0.0.0:8080')).toBe(true);
    expect(isLocalHost('[::]:3000')).toBe(true);
  });
});

describe('isLocalUrl', () => {
  it('локальные адреса узнаёт, чужие — нет', () => {
    expect(isLocalUrl('http://localhost:3000/app')).toBe(true);
    expect(isLocalUrl('http://127.0.0.1/')).toBe(true);
    expect(isLocalUrl('http://0.0.0.0:8080/')).toBe(true);
    expect(isLocalUrl('https://example.com/')).toBe(false);
    expect(isLocalUrl('https://localhost.example.com/')).toBe(false);
  });

  it('не сетевая схема — не наш случай, даже если хост локальный', () => {
    expect(isLocalUrl('file:///etc/passwd')).toBe(false);
    expect(isLocalUrl('не адрес')).toBe(false);
  });
});

describe('parseDevToolsEndpoint', () => {
  it('вытаскивает ws-адрес и http-корень из строки Chromium', () => {
    const line =
      '[1011:1011:1101/120000.000000:ERROR] DevTools listening on ws://127.0.0.1:45123/devtools/browser/abc-123';
    expect(parseDevToolsEndpoint(line)).toEqual({
      wsUrl: 'ws://127.0.0.1:45123/devtools/browser/abc-123',
      httpUrl: 'http://127.0.0.1:45123',
    });
  });

  it('в чужих строках ничего не находит', () => {
    expect(parseDevToolsEndpoint('[chui] запускаю chrome')).toBeNull();
    expect(parseDevToolsEndpoint('DevTools listening on ws://')).toBeNull();
  });
});

describe('sanitizeSnapshot', () => {
  it('чистит данные со страницы: типы, длину и пустые метки', () => {
    const snapshot = sanitizeSnapshot({
      title: 'Пример',
      url: 'https://example.com/',
      elements: [
        { ref: '1', tag: 'button', role: 'button', name: 'Войти' },
        { ref: '', tag: 'a', role: 'link', name: 'пустая метка' },
        { ref: '2', tag: 'a', role: 'link', name: '   ' },
        'мусор',
        null,
      ],
      text: 'текст',
      truncated: true,
    });

    expect(snapshot.title).toBe('Пример');
    expect(snapshot.elements).toHaveLength(2);
    expect(snapshot.elements[1]).toMatchObject({ ref: '2', name: '(без подписи)' });
    expect(snapshot.truncated).toBe(true);
  });

  it('обрезает список элементов и текст по потолкам', () => {
    const many = Array.from({ length: MAX_SNAPSHOT_ELEMENTS + 20 }, (_, index) => ({
      ref: String(index + 1),
      tag: 'a',
      role: 'link',
      name: 'ссылка',
    }));
    const snapshot = sanitizeSnapshot({ elements: many, text: 'я'.repeat(MAX_SNAPSHOT_TEXT + 500) });

    expect(snapshot.elements).toHaveLength(MAX_SNAPSHOT_ELEMENTS);
    expect(snapshot.text.length).toBe(MAX_SNAPSHOT_TEXT);
    expect(snapshot.truncated).toBe(true);
  });

  it('пустой ответ не роняет разбор', () => {
    expect(sanitizeSnapshot(null)).toEqual({ title: '', url: '', elements: [], text: '' });
    expect(sanitizeSnapshot({ elements: 'нет' }).elements).toEqual([]);
  });
});

describe('formatBrowserSnapshot', () => {
  it('показывает заголовок, адрес, элементы с номерами и текст', () => {
    const text = formatBrowserSnapshot({
      title: 'Вход',
      url: 'https://example.com/login',
      elements: [
        { ref: '1', tag: 'input', role: 'textbox', name: 'Логин' },
        { ref: '2', tag: 'button', role: 'button', name: 'Войти', note: 'submit' },
        { ref: '3', tag: 'button', role: 'button', name: 'Отмена', disabled: true },
      ],
      text: 'Войдите в систему',
    });

    expect(text).toContain('Страница: Вход');
    expect(text).toContain('Адрес: https://example.com/login');
    expect(text).toContain('1. textbox «Логин»');
    expect(text).toContain('2. button «Войти» → submit');
    expect(text).toContain('3. button «Отмена» [недоступен]');
    expect(text).toContain('Войдите в систему');
  });

  it('пустая страница говорит об этом словами, а не пустотой', () => {
    const text = formatBrowserSnapshot({ title: '', url: 'about:blank', elements: [], text: '' });
    expect(text).toContain('(без заголовка)');
    expect(text).toContain('Интерактивных элементов не видно.');
    expect(text).toContain('(текста нет)');
  });

  it('обрезка текста помечена', () => {
    const text = formatBrowserSnapshot({ title: 't', url: 'u', elements: [], text: 'x', truncated: true });
    expect(text).toContain('текст страницы обрезан');
  });
});

describe('sanitizePickedElement', () => {
  it('оставляет описание элемента и обрезает длинные поля', () => {
    const element = sanitizePickedElement({
      tag: 'BUTTON',
      selector: 'main.form > button#send',
      name: '  Отправить  ',
      role: 'button',
      text: 'Отправить форму',
      html: '<button id="send">Отправить форму</button>',
      styles: { display: 'block', color: 'rgb(0, 0, 0)' },
      rect: { x: 10.4, y: 20.6, width: 120, height: 32 },
    });

    expect(element).not.toBeNull();
    expect(element?.tag).toBe('button');
    expect(element?.name).toBe('Отправить');
    expect(element?.rect).toEqual({ x: 10, y: 21, width: 120, height: 32 });
    expect(element?.styles.color).toBe('rgb(0, 0, 0)');

    const long = sanitizePickedElement({ tag: 'div', html: 'я'.repeat(5000), text: 'я'.repeat(5000) });
    expect(long?.html.length).toBe(1200);
    expect(long?.text.length).toBe(600);
  });

  it('без тега элемента нет: описание без него бесполезно', () => {
    expect(sanitizePickedElement(null)).toBeNull();
    expect(sanitizePickedElement({ selector: 'div' })).toBeNull();
    expect(sanitizePickedElement({ tag: '   ' })).toBeNull();
  });

  it('чужие типы не пролезают: только строки, только числа', () => {
    const element = sanitizePickedElement({
      tag: 'div',
      selector: { $: 'div' },
      styles: { display: 42, color: 'red', '': 'x' },
      rect: { width: 'много', height: -5 },
    });
    expect(element?.selector).toBe('');
    expect(element?.styles).toEqual({ color: 'red' });
    expect(element?.rect.height).toBe(0);
  });
});

describe('formatPickedElement', () => {
  it('пишет, что за элемент, где он и как выглядит', () => {
    const text = formatPickedElement(
      {
        tag: 'button',
        selector: 'form > button.primary',
        name: 'Отправить',
        role: 'button',
        text: 'Отправить',
        html: '<button class="primary">Отправить</button>',
        styles: { display: 'inline-flex', color: 'rgb(255, 255, 255)' },
        rect: { x: 12, y: 40, width: 120, height: 32 },
      },
      'http://localhost:3000/form',
    );

    expect(text).toContain('Элемент: <button> «Отправить»');
    expect(text).toContain('Роль: button');
    expect(text).toContain('Страница: http://localhost:3000/form');
    expect(text).toContain('Селектор: form > button.primary');
    expect(text).toContain('Место на странице: 12, 40 · 120 × 32');
    expect(text).toContain('  color: rgb(255, 255, 255)');
    expect(text).toContain('Разметка:');
  });

  it('скудный элемент не оставляет пустых разделов', () => {
    const text = formatPickedElement({
      tag: 'div',
      selector: '',
      name: '',
      role: '',
      text: '',
      html: '',
      styles: {},
      rect: { x: 0, y: 0, width: 0, height: 0 },
    });
    expect(text.split('\n')[0]).toBe('Элемент: <div>');
    expect(text).not.toContain('Стили:');
    expect(text).not.toContain('Текст:');
    expect(text).not.toContain('Разметка:');
  });
});

describe('SNAPSHOT_SCRIPT', () => {
  it('ставит метки data-chui-ref и возвращает объект', () => {
    // Скрипт уходит на страницу текстом, поэтому проверяем его форму: метка,
    // потолки и то, что он не полагается на наши модули.
    expect(SNAPSHOT_SCRIPT).toContain('data-chui-ref');
    expect(SNAPSHOT_SCRIPT).toContain(String(MAX_SNAPSHOT_ELEMENTS));
    expect(SNAPSHOT_SCRIPT).toContain(String(MAX_SNAPSHOT_TEXT));
    expect(SNAPSHOT_SCRIPT.trim().startsWith('(() =>')).toBe(true);
  });
});
