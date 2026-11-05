import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeNode {
  tag: string;
  attrs: Record<string, string>;
  children: FakeNode[];
  parent: FakeNode | null;
  text: string;
  removed: boolean;
  /** Живой узел — с `false` автоуход тоста не стартует, как и в настоящем DOM. */
  isConnected: boolean;
  handlers: Record<string, ((event: unknown) => void)[]>;
  classList: { add: (name: string) => void; classes: Set<string> };
  appendChild: (child: FakeNode) => FakeNode;
  addEventListener: (type: string, handler: (event: unknown) => void) => void;
  remove: () => void;
  click: () => void;
  /** Событие без клика: `mouseenter`, `mouseleave`, `focusin` — пауза автоухода. */
  fire: (type: string) => void;
  querySelector: (selector: string) => FakeNode | null;
}

function fakeNode(tag: string, attrs: Record<string, string> = {}): FakeNode {
  const node: FakeNode = {
    tag,
    attrs,
    children: [],
    parent: null,
    text: '',
    removed: false,
    isConnected: true,
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
      node.isConnected = false;
      if (!node.parent) return;
      node.parent.children = node.parent.children.filter((child) => child !== node);
      node.parent = null;
    },
    click: () => {
      for (const handler of node.handlers.click ?? []) handler({ stopPropagation: () => {} });
    },
    fire: (type) => {
      for (const handler of node.handlers[type] ?? []) handler({});
    },
    // Ровно та выборка, которая нужна `Esc`: верхний (последний добавленный)
    // тост, ещё не уехавший.
    querySelector: (selector) => {
      if (selector !== '.toast:not(.is-leaving)') return null;
      const live = node.children.filter(
        (child) =>
          child.tag === 'div' && child.attrs.class?.includes('toast') && !child.classList.classes.has('is-leaving'),
      );
      return live[live.length - 1] ?? null;
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
/** Слушатели, повешенные на `window`: Esc в уведомлениях и пауза автоухода. */
let windowHandlers: Record<string, ((event: unknown) => void)[]> = {};

/** Дождаться свежих таймеров после `showToast` и вызвать клавишу. */
function pressEscape(): void {
  for (const handler of windowHandlers.keydown ?? []) handler({ key: 'Escape', preventDefault: () => {} });
}

beforeEach(() => {
  all = [];
  windowHandlers = {};
  vi.resetModules();
  vi.useFakeTimers();
  const body = fakeNode('body');
  vi.stubGlobal('document', {
    body,
    querySelector: () => null,
    createElement: (tag: string) => {
      const node = fakeNode(tag);
      all.push(node);
      return node;
    },
  });
  vi.stubGlobal('window', {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      (windowHandlers[type] ??= []).push(handler);
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
    // Без действия — ни класса `is-actionable`, ни курсора-руки на плашке.
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

  // П.6: кнопка должна вести ТУДА, где видно, что случилось. Было: тост умел
  // только `run` — произвольное замыкание, которое нельзя записать в историю.
  it('кнопка с командой исполняет команду через переданный исполнитель', async () => {
    const { showToast } = await loadToast();
    const execute = vi.fn();
    showToast('подключены', 'success', {
      action: { label: 'Показать', command: 'view.lspLog' },
      execute,
    });
    all.find((node) => node.tag === 'button')?.click();
    expect(execute).toHaveBeenCalledWith('view.lspLog', undefined);
  });

  it('клик по самому уведомлению тоже ведёт по команде', async () => {
    const { showToast } = await loadToast();
    const execute = vi.fn();
    showToast('подключены', 'success', {
      action: { label: 'Показать', command: 'view.lspLog', args: [1] },
      execute,
    });
    toasts()[0]?.click();
    expect(execute).toHaveBeenCalledWith('view.lspLog', [1]);
    expect(toasts()[0]?.removed).toBe(true);
  });

  // Главная ловушка: команда есть, а исполнителя не дали — молча ронять нельзя,
  // иначе кнопка выглядит рабочей, но не делает ничего.
  it('без исполнителя команда не роняет уведомление, а просто закрывает', async () => {
    const { showToast } = await loadToast();
    showToast('подключены', 'success', { action: { label: 'Показать', command: 'view.lspLog' } });
    expect(() => all.find((node) => node.tag === 'button')?.click()).not.toThrow();
    expect(toasts()[0]?.removed).toBe(true);
  });

  it('история помнит шаг с командой, но не замыкание', async () => {
    const { showToast, notices } = await loadToast();
    showToast('подключены', 'success', {
      key: 'lsp:ready',
      action: { label: 'Показать', command: 'view.lspLog' },
    });
    showToast('сделано', 'success', {
      key: 'git:done',
      action: { label: 'Отменить', run: () => undefined },
    });
    // Свежее сверху: последний тост (`git:done`) — первый в истории.
    const [done, ready] = notices.history();
    expect(ready?.action?.command).toBe('view.lspLog');
    // Замыкание живёт только до перезагрузки окна — в истории ему не место.
    expect(done?.action ?? null).toBeNull();
  });

  // П.7: тост не отбирает ввод. Промах мимо плашки должен пройти насквозь —
  // под ней в правом нижнем углу низ чата с полем ввода.
  it('без действия тост не обещает быть кнопкой: ни курсора-руки, ни «нажмите»', async () => {
    const { showToast } = await loadToast();
    showToast('просто уведомление');
    const [toast] = toasts();
    expect(toast?.attrs.class).toBe('toast toast-info');
    expect(toast?.attrs.title).toBeUndefined();
  });

  it('тост с действием получает класс `is-actionable` и подсказку', async () => {
    const { showToast } = await loadToast();
    showToast('сделано', 'success', { action: { label: 'Отменить', run: () => {} } });
    const [toast] = toasts();
    expect(toast?.attrs.class).toBe('toast toast-success is-actionable');
    expect(toast?.attrs.title).toBe('Отменить');
  });

  it('Esc убирает верхний тост и не трогает остальные', async () => {
    const { showToast } = await loadToast();
    showToast('первый');
    showToast('второй');
    const [first, second] = toasts();
    pressEscape();
    // Верхний — тот, что добавлен последним.
    expect(second?.classList.classes.has('is-leaving')).toBe(true);
    expect(first?.classList.classes.has('is-leaving')).toBe(false);
    vi.advanceTimersByTime(220);
    expect(second?.removed).toBe(true);
    expect(first?.removed).toBe(false);
  });

  it('Esc отдаёт ход открытому меню или окну: тост остаётся', async () => {
    vi.stubGlobal('document', {
      body: fakeNode('body'),
      querySelector: (selector: string) => (selector.includes('context-menu') ? fakeNode('div') : null),
      createElement: (tag: string) => {
        const node = fakeNode(tag);
        all.push(node);
        return node;
      },
    });
    const { showToast } = await loadToast();
    showToast('Открыт рабочий каталог');
    pressEscape();
    expect(toasts()[0]?.classList.classes.has('is-leaving')).toBe(false);
  });

  // Четыре секунды — и плашка ушла бы из-под курсора в самый момент клика.
  it('пока курсор на уведомлении, автоуход ждёт; курсор ушёл — досчитывается', async () => {
    const { showToast } = await loadToast();
    showToast('почитай');
    const [toast] = toasts();
    toast?.fire('mouseenter');
    vi.advanceTimersByTime(10_000);
    expect(toast?.classList.classes.has('is-leaving')).toBe(false);
    toast?.fire('mouseleave');
    vi.advanceTimersByTime(4000);
    expect(toast?.classList.classes.has('is-leaving')).toBe(true);
  });

  it('фокус на кнопке тоже держит уведомление: с клавиатуры его не уберут из-под руки', async () => {
    const { showToast } = await loadToast();
    showToast('сделано', 'success', { action: { label: 'Отменить', run: () => {} } });
    const [toast] = toasts();
    toast?.fire('focusin');
    vi.advanceTimersByTime(10_000);
    expect(toast?.classList.classes.has('is-leaving')).toBe(false);
  });
});
