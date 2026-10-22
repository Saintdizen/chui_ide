import { beforeEach, describe, expect, it, vi } from 'vitest';

const made = vi.hoisted(() => ({ count: 0 }));

/**
 * jsdom в проекте нет, а попапу нужен лишь `element` да пара методов — рисуем
 * минимальный узел вручную и подменяем `createPopover`.
 */
vi.mock('../src/renderer/ui/popover', () => ({
  createPopover: (content: HTMLElement) => {
    made.count += 1;
    const element = { classList: { add: vi.fn() } } as unknown as HTMLElement;
    let open = false;
    return {
      element,
      content,
      get isOpen() {
        return open;
      },
      toggle: () => {
        open = !open;
      },
      close: () => {
        open = false;
      },
    };
  },
}));

const { createLazyPopover } = await import('../src/renderer/ui/lazy-popover');

function content() {
  return {
    element: { tagName: 'DIV' } as unknown as HTMLElement,
    refresh: vi.fn(async () => undefined),
  };
}

const anchor = {} as HTMLElement;

describe('ленивый попап', () => {
  beforeEach(() => {
    made.count = 0;
  });

  it('строит содержимое только при первом открытии', () => {
    const create = vi.fn(() => content());
    const popover = createLazyPopover({ create, className: 'p' });
    expect(create).not.toHaveBeenCalled();
    popover.toggle(anchor);
    popover.toggle(anchor);
    expect(create).toHaveBeenCalledTimes(1);
    expect(made.count).toBe(1);
  });

  it('до первого открытия refresh и close безопасны и ничего не создают', () => {
    const create = vi.fn(() => content());
    const popover = createLazyPopover({ create, className: 'p' });
    popover.refresh();
    popover.close();
    expect(create).not.toHaveBeenCalled();
    expect(popover.view).toBeNull();
    expect(popover.isOpen).toBe(false);
  });

  it('перед показом обновляет снимок', () => {
    const view = content();
    const popover = createLazyPopover({ create: () => view, className: 'p' });
    popover.toggle(anchor);
    expect(view.refresh).toHaveBeenCalledTimes(1);
    popover.toggle(anchor);
    expect(view.refresh).toHaveBeenCalledTimes(2);
  });

  it('warm создаёт и обновляет, не показывая', () => {
    const view = content();
    const popover = createLazyPopover({ create: () => view, className: 'p' });
    popover.warm();
    expect(view.refresh).toHaveBeenCalledTimes(1);
    expect(popover.isOpen).toBe(false);
    expect(popover.view).toBe(view);
  });

  it('close, переданный в содержимое, закрывает попап после создания', () => {
    let inner: (() => void) | null = null;
    const popover = createLazyPopover({
      create: (close) => {
        inner = close;
        return content();
      },
      className: 'p',
    });
    // до создания внутренний close ещё некому адресовать — это no-op
    popover.toggle(anchor);
    expect(popover.isOpen).toBe(true);
    inner!();
    expect(popover.isOpen).toBe(false);
  });
});
