import { beforeAll, describe, expect, it } from 'vitest';
import { installMiniDom } from './helpers/mini-dom';

beforeAll(() => installMiniDom());

/**
 * Прыжок в файл из ленты прогона: путь в шапке карточки инструмента —
 * ссылка, клик открывает файл на той строке, о которой говорит вызов.
 * Без этого «read src/main/app.ts:120» в ленте остаётся текстом, и найти
 * место в файле по нему нельзя.
 */
const load = async () => import('../src/renderer/ui/chat-tools');

describe('путь в карточке инструмента', () => {
  it('клик по пути открывает файл на нужной строке', async () => {
    const { createToolFeed } = await load();
    const opened: { path: string; line?: number }[] = [];
    const host = document.createElement('div');
    const feed = createToolFeed(host, null, undefined, async (path, position) => {
      opened.push({ path, line: position?.line });
    });
    feed.add({ id: 'c1', name: 'read', args: JSON.stringify({ path: '/p/src/main/app.ts', line: 120 }) });

    const link = host.querySelector('.tool-path') as HTMLElement;
    expect(link).not.toBeNull();
    link.click();
    expect(opened).toEqual([{ path: '/p/src/main/app.ts', line: 120 }]);
  });

  it('без обработчика открытия путь показан, клик не падает', async () => {
    const { createToolFeed } = await load();
    const host = document.createElement('div');
    const feed = createToolFeed(host);
    feed.add({ id: 'c2', name: 'read', args: JSON.stringify({ path: '/p/src/a.ts' }) });
    const link = host.querySelector('.tool-path') as HTMLElement;
    expect(link.textContent).toBe('src/a.ts');
    expect(() => link.click()).not.toThrow();
  });

  it('у вызова без пути ссылки нет', async () => {
    const { createToolFeed } = await load();
    const host = document.createElement('div');
    const feed = createToolFeed(host);
    feed.add({ id: 'c3', name: 'web', args: JSON.stringify({ url: 'https://example.com' }) });
    expect(host.querySelector('.tool-path')).toBeNull();
  });
});
