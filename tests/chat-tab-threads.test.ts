import { beforeAll, describe, expect, it } from 'vitest';
import { installMiniDom } from './helpers/mini-dom';
import { createChatTabs } from '../src/renderer/ui/chat-tabs';
import { describeThread } from '../src/shared/chat-threads';

beforeAll(() => installMiniDom());

function view() {
  return createChatTabs({
    onPick: () => undefined,
    onClose: () => undefined,
    onMenu: () => undefined,
    onAdd: () => undefined,
    search: () => [],
    onPickSearch: () => undefined,
  } as any);
}

const threads = [
  describeThread({ id: 1, running: true, hasHistory: true }),
  describeThread({ id: 2, running: false, hasHistory: true }),
  describeThread({
    id: 3,
    running: false,
    hasHistory: true,
    model: 'gpt-4o',
    trace: { steps: 1, toolCalls: 0, usage: { promptTokens: 1000, completionTokens: 500 } },
  }),
];

describe('нити в полосе вкладок', () => {
  it('идущая, ждущая и пустая вкладки различимы классом', () => {
    const tabs = view();
    tabs.render(
      [
        { id: 1, title: 'a', streaming: true, thread: threads[0] },
        { id: 2, title: 'b', streaming: false, thread: threads[1] },
        { id: 3, title: 'c', streaming: false, thread: describeThread({ id: 3, running: false, hasHistory: false }) },
      ],
      1,
    );

    const items = tabs.element.querySelectorAll('.chat-tab');
    expect(items[0]!.className).toContain('is-running');
    expect(items[1]!.className).toContain('is-idle');
    expect(items[2]!.className).toContain('is-empty');
  });

  it('цена показывается только там, где она известна', () => {
    const tabs = view();
    tabs.render(
      [
        { id: 1, title: 'a', streaming: false, thread: threads[1] },
        { id: 2, title: 'b', streaming: false, thread: threads[2] },
      ],
      1,
    );

    const items = tabs.element.querySelectorAll('.chat-tab');
    // Без следов цены — приглушённой цифры нет: прочерк читался бы как «бесплатно».
    expect(items[0]!.querySelectorAll('.chat-tab-cost')).toHaveLength(0);
    expect(items[1]!.querySelectorAll('.chat-tab-cost')).toHaveLength(1);
  });

  it('без нити вкладка рисуется как раньше', () => {
    const tabs = view();
    tabs.render([{ id: 1, title: 'a', streaming: true }], 1);

    const item = tabs.element.querySelectorAll('.chat-tab')[0]!;
    expect(item.className).toContain('is-busy');
    expect(item.className).not.toContain('is-running');
    expect(item.querySelectorAll('.chat-tab-cost')).toHaveLength(0);
  });
});
