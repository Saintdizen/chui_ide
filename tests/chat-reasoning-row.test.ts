import { beforeAll, describe, expect, it } from 'vitest';
import { installMiniDom } from './helpers/mini-dom';

beforeAll(() => installMiniDom());

/**
 * Размышления модели — отдельный блок: свёрнут по умолчанию, с длительностью
 * и «показать полностью». Пока длительности нет, по ленте нельзя понять, что
 * модель думала сорок секунд, — а именно это и объясняет долгое ожидание.
 */
const load = async () => import('../src/renderer/ui/chat-tools');

const el = (host: HTMLElement, selector: string): HTMLElement | null =>
  host.querySelector(selector) as HTMLElement | null;

describe('блок размышлений', () => {
  it('в шапке видна длительность', async () => {
    const { createToolFeed } = await load();
    const host = document.createElement('div');
    const feed = createToolFeed(host);
    const view = feed.reasoning();
    view.push('думаю');
    view.collapse();
    expect(el(host, '.reasoning-time')?.textContent ?? '').toMatch(/\d/);
  });

  it('свёрнут по умолчанию, «показать полностью» раскрывает', async () => {
    const { createToolFeed } = await load();
    const host = document.createElement('div');
    const feed = createToolFeed(host);
    const view = feed.reasoning();
    view.push('первая мысль');
    view.collapse();

    // Свернулось — панель скрыта целиком (её скрывает сама строка, а не текст).
    expect(el(host, '.tool-panel')?.hidden).toBe(true);
    expect(el(host, '.reasoning-time')?.textContent ?? '').not.toBe('');

    // Раскрываем шапку: текст виден без всяких «показать полностью» — он короткий.
    el(host, '.tool-head')?.click();
    expect(el(host, '.tool-panel')?.hidden).toBe(false);
    expect((el(host, '.reasoning-text')?.textContent ?? '').length).toBe('первая мысль'.length);
  });

  it('длинный текст усечён, раскрытие показывает всё', async () => {
    const { createToolFeed } = await load();
    const { MAX_REASONING_CHARS } = await import('../src/renderer/ui/chat-tools');
    const host = document.createElement('div');
    const feed = createToolFeed(host);
    const view = feed.reasoning();
    const long = 'я'.repeat(MAX_REASONING_CHARS + 500);
    view.push(long);
    view.collapse();

    const panel = el(host, '.reasoning-text');
    expect((panel?.textContent ?? '').length).toBeLessThanOrEqual(MAX_REASONING_CHARS * 2);

    // Кнопка нужна именно здесь: без неё хвост размышлений недоступен вовсе.
    const more = el(host, '.reasoning-more');
    expect(more?.hidden).toBe(false);
    more?.click();
    expect((panel?.textContent ?? '').length).toBeGreaterThan(MAX_REASONING_CHARS);
    expect(more?.hidden).toBe(true);
  });
});
