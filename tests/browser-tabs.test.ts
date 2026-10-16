import { describe, expect, it } from 'vitest';
import { BrowserTabs } from '../src/renderer/core/browser-tabs';

/**
 * Вкладки встроенного браузера: порядок, активность и закрытие. Ни сети, ни вложений
 * (`WebContentsView` живёт в main) тут нет — проверяется ровно модель полосы.
 */
describe('BrowserTabs', () => {
  it('открытая страница становится активной', () => {
    const tabs = new BrowserTabs();
    const id = tabs.open('https://example.com/');

    expect(tabs.active?.id).toBe(id);
    expect(tabs.active?.url).toBe('https://example.com/');
    // До загрузки заголовка в полосе виден адрес — вкладка без подписи выглядела бы сломанной.
    expect(tabs.active?.title).toBe('https://example.com/');
  });

  it('повторный адрес не заводит вторую вкладку, а показывает прежнюю', () => {
    const tabs = new BrowserTabs();
    const first = tabs.open('https://example.com/');
    tabs.open('https://other.example/');
    const again = tabs.open('https://example.com/');

    expect(again).toBe(first);
    expect(tabs.list).toHaveLength(2);
    expect(tabs.active?.id).toBe(first);
  });

  it('ключи не повторяются после закрытия', () => {
    const tabs = new BrowserTabs();
    const first = tabs.open('https://a.example/');
    tabs.close(first);
    const second = tabs.open('https://b.example/');

    expect(second).not.toBe(first);
  });

  it('закрытие активной встаёт на соседа', () => {
    const tabs = new BrowserTabs();
    const a = tabs.open('https://a.example/');
    const b = tabs.open('https://b.example/');
    const c = tabs.open('https://c.example/');

    tabs.close(b);
    // Сосед справа занимает место закрытой.
    expect(tabs.active?.id).toBe(c);

    tabs.close(c);
    expect(tabs.active?.id).toBe(a);
  });

  it('закрытие последней оставляет пустую полосу', () => {
    const tabs = new BrowserTabs();
    const id = tabs.open('https://a.example/');
    tabs.close(id);

    expect(tabs.list).toHaveLength(0);
    expect(tabs.active).toBeNull();
  });

  it('заголовок и адрес обновляются со страницы', () => {
    const tabs = new BrowserTabs();
    const id = tabs.open('https://example.com/');
    tabs.update(id, { title: 'Пример', url: 'https://example.com/page' });

    expect(tabs.active?.title).toBe('Пример');
    expect(tabs.active?.url).toBe('https://example.com/page');
  });

  it('показ файла снимает активность, но вкладку не убирает', () => {
    const tabs = new BrowserTabs();
    tabs.open('https://example.com/');
    tabs.deactivate();

    expect(tabs.activePageId).toBeNull();
    // Из полосы страница не исчезает: к ней вернутся щелчком.
    expect(tabs.list).toHaveLength(1);
  });

  it('событие приходит на каждое изменение', () => {
    const tabs = new BrowserTabs();
    let changes = 0;
    tabs.onDidChange(() => {
      changes += 1;
    });

    const id = tabs.open('https://example.com/');
    tabs.update(id, { title: 'Пример' });
    tabs.deactivate();
    tabs.close(id);

    expect(changes).toBe(4);
  });

  it('обновление без изменений события не шлёт', () => {
    const tabs = new BrowserTabs();
    const id = tabs.open('https://example.com/');
    let changes = 0;
    tabs.onDidChange(() => {
      changes += 1;
    });

    tabs.update(id, { url: 'https://example.com/' });

    expect(changes).toBe(0);
  });

  it('вкладка агента приходит со своим ключом и не путается с нашими', () => {
    const tabs = new BrowserTabs();
    tabs.adopt('agent-1', 'https://example.com/');

    expect(tabs.active?.id).toBe('agent-1');
    expect(tabs.active?.url).toBe('https://example.com/');
    // Свой счётчик полосы даёт ключи `page-N`: совпасть с ключом main они не должны.
    const own = tabs.open('https://other.example/');
    expect(own).not.toBe('agent-1');
    expect(tabs.list).toHaveLength(2);
  });

  it('повторное усыновление того же ключа вкладку не двоит', () => {
    const tabs = new BrowserTabs();
    tabs.adopt('agent-1', 'https://example.com/');
    tabs.adopt('agent-1', 'https://example.com/next');

    expect(tabs.list).toHaveLength(1);
    expect(tabs.active?.url).toBe('https://example.com/next');
  });
});
