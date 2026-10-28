import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeNode {
  tag: string;
  attrs: Record<string, string>;
  children: FakeNode[];
  parent: FakeNode | null;
  text: string;
  removed: boolean;
  handlers: Record<string, ((event: unknown) => void)[]>;
  classList: { add: (name: string) => void; classes: Set<string> };
  appendChild: (child: FakeNode) => FakeNode;
  addEventListener: (type: string, handler: (event: unknown) => void) => void;
  remove: () => void;
  click: () => void;
}

function fakeNode(tag: string, attrs: Record<string, string> = {}): FakeNode {
  const node: FakeNode = {
    tag,
    attrs,
    children: [],
    parent: null,
    text: '',
    removed: false,
    handlers: {},
    classList: { classes: new Set<string>(), add: (name) => node.classList.classes.add(name) },
    appendChild: (child) => {
      child.parent = node;
      node.children.push(child);
      return child;
    },
    addEventListener: (type, handler) => {
      (node.handlers[type] ??= []).push(handler);
    },
    remove: () => {
      node.removed = true;
      if (!node.parent) return;
      node.parent.children = node.parent.children.filter((child) => child !== node);
      node.parent = null;
    },
    click: () => {
      for (const handler of node.handlers.click ?? []) handler({ stopPropagation: () => {} });
    },
  };
  all.push(node);
  return node;
}

function domModule() {
  const h = (tag: string, attrs: Record<string, unknown>, ...children: unknown[]) => {
    const node = fakeNode(
      tag,
      Object.fromEntries(Object.entries(attrs ?? {}).map(([key, value]) => [key, String(value)])),
    );
    for (const [key, value] of Object.entries(attrs ?? {})) {
      if (typeof value === 'function' && key.startsWith('on'))
        node.addEventListener(key.slice(2), value as (event: unknown) => void);
    }
    for (const child of children) {
      if (typeof child === 'string') node.text += child;
      else if (child && typeof child === 'object') node.appendChild(child as FakeNode);
    }
    return node;
  };
  const svgIcon = (name: string, size: number) => fakeNode('svg', { 'data-icon': name, width: String(size) });
  return { h, svgIcon };
}

let all: FakeNode[] = [];

beforeEach(() => {
  all = [];
  vi.resetModules();
  vi.useFakeTimers();
  const body = fakeNode('body');
  vi.stubGlobal('document', {
    body,
    createElement: (tag: string) => {
      const node = fakeNode(tag);
      all.push(node);
      return node;
    },
  });
});

async function loadToast() {
  vi.doMock('../src/renderer/ui/dom', () => domModule());
  return import('../src/renderer/ui/toast');
}

const toasts = () => all.filter((node) => node.attrs.class?.startsWith('toast '));

describe('ui/toast', () => {
  it('область уведомлений создаётся один раз и остаётся в документе', async () => {
    const { showToast } = await loadToast();
    showToast('раз');
    showToast('два');
    const regions = all.filter((node) => node.attrs.class === 'toasts');
    expect(regions).toHaveLength(1);
    expect(regions[0]?.parent?.tag).toBe('body');
    expect(regions[0]?.children).toHaveLength(2);
  });

  it('ошибка объявляется сразу, обычное уведомление — по очереди', async () => {
    const { showToast } = await loadToast();
    showToast('беда', 'error');
    showToast('мелочь', 'info');
    const [error, info] = toasts();
    expect(error?.attrs.role).toBe('alert');
    expect(info?.attrs.role).toBe('status');
    expect(error?.attrs.class).toBe('toast toast-error');
  });

  it('значок соответствует роли уведомления', async () => {
    const { showToast } = await loadToast();
    showToast('готово', 'success');
    showToast('беда', 'error');
    showToast('так', 'info');
    const icons = toasts().map((node) => node.children[0]?.attrs['data-icon']);
    expect(icons).toEqual(['check', 'warning', 'sparkle']);
  });

  it('обычное уведомление уходит через 4 секунды, а с действием живёт 8', async () => {
    const { showToast } = await loadToast();
    showToast('обычное');
    showToast('с отменой', 'info', { action: { label: 'Отменить', run: () => {} } });
    const [plain, withAction] = toasts();
    vi.advanceTimersByTime(4000);
    expect(plain?.classList.classes.has('is-leaving')).toBe(true);
    expect(withAction?.classList.classes.has('is-leaving')).toBe(false);
    vi.advanceTimersByTime(4000);
    expect(withAction?.classList.classes.has('is-leaving')).toBe(true);
  });

  it('ошибка живёт дольше обычного уведомления', async () => {
    const { showToast } = await loadToast();
    showToast('беда', 'error');
    const [error] = toasts();
    vi.advanceTimersByTime(4000);
    expect(error?.classList.classes.has('is-leaving')).toBe(false);
    vi.advanceTimersByTime(4000);
    expect(error?.classList.classes.has('is-leaving')).toBe(true);
  });

  it('уведомление удаляется из документа, а не просто помечается', async () => {
    const { showToast } = await loadToast();
    showToast('уйди');
    const region = all.find((node) => node.attrs.class === 'toasts');
    expect(region?.children).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    vi.advanceTimersByTime(220);
    expect(region?.children).toHaveLength(0);
  });

  it('клик по уведомлению закрывает его сразу', async () => {
    const { showToast } = await loadToast();
    showToast('закрой меня');
    const [toast] = toasts();
    toast?.click();
    expect(toast?.removed).toBe(true);
  });

  it('кнопка действия закрывает уведомление и вызывает своё действие', async () => {
    const { showToast } = await loadToast();
    const run = vi.fn();
    showToast('сделано', 'success', { action: { label: 'Отменить', run } });
    const button = all.find((node) => node.tag === 'button');
    expect(button?.attrs.type).toBe('button');
    expect(button?.text).toBe('Отменить');
    button?.click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(toasts()[0]?.removed).toBe(true);
  });
});
