import { describe, expect, it, vi } from 'vitest';

/** Мок `ui/dom`: настоящие узлы здесь не нужны, важны обработчики и классы. */
interface FakeNode {
  tag: string;
  attrs: Record<string, unknown>;
  children: FakeNode[];
  parent: FakeNode | null;
  text: string;
  value: string;
  classes: Set<string>;
  handlers: Record<string, ((event: unknown) => void)[]>;
  scrolls: number[];
  appendChild(child: FakeNode): FakeNode;
  replaceChildren(...nodes: FakeNode[]): void;
  addEventListener(type: string, handler: (event: unknown) => void): void;
  classList: { add(name: string): void };
  scrollIntoView(): void;
  focus(): void;
  fire(type: string, event?: Record<string, unknown>): void;
  findAll(predicate: (node: FakeNode) => boolean): FakeNode[];
}

function node(tag: string, attrs: Record<string, unknown> = {}): FakeNode {
  const self: FakeNode = {
    tag,
    attrs,
    children: [],
    parent: null,
    text: '',
    value: String(attrs.value ?? ''),
    classes: new Set<string>(),
    handlers: {},
    scrolls: [],
    appendChild(child) {
      child.parent = self;
      self.children.push(child);
      return child;
    },
    replaceChildren(...nodes) {
      self.children = [];
      for (const child of nodes) self.appendChild(child);
    },
    addEventListener(type, handler) {
      (self.handlers[type] ??= []).push(handler);
    },
    classList: {
      add(name: string) {
        self.classes.add(name);
      },
    },
    scrollIntoView() {
      self.scrolls.push(1);
    },
    focus() {
      self.attrs.focused = true;
    },
    fire(type, event = {}) {
      for (const handler of self.handlers[type] ?? []) handler(event);
    },
    findAll(predicate) {
      const found: FakeNode[] = [];
      const walk = (current: FakeNode) => {
        if (predicate(current)) found.push(current);
        for (const child of current.children) walk(child);
      };
      walk(self);
      return found;
    },
  };
  return self;
}

function mountDom() {
  const h = (tag: string, attrs: Record<string, unknown> = {}, ...children: unknown[]) => {
    const created = node(tag, attrs);
    for (const [key, value] of Object.entries(attrs)) {
      if (typeof value === 'function' && key.startsWith('on'))
        created.addEventListener(key.slice(2).toLowerCase(), value as (event: unknown) => void);
    }
    for (const child of children) {
      if (typeof child === 'string') created.text += child;
      else if (child && typeof child === 'object') created.appendChild(child as FakeNode);
    }
    return created;
  };
  const svgIcon = (name: string) => node('svg', { 'data-icon': name });
  return { h, svgIcon };
}

function host() {
  const mounted: FakeNode[] = [];
  const cancels: (() => void)[] = [];
  return {
    mounted,
    cancels,
    host: {
      readText: async () => null,
      mount: (block: FakeNode) => mounted.push(block),
      scrollToEnd: () => {},
      register: (cancel: () => void) => {
        cancels.push(cancel);
        return () => {
          const index = cancels.indexOf(cancel);
          if (index >= 0) cancels.splice(index, 1);
        };
      },
    },
    interrupt() {
      for (const cancel of [...cancels]) cancel();
    },
  };
}

async function setup() {
  vi.doMock('../src/renderer/ui/dom', () => mountDom());
  const { createPlanApproval: create } = await import('../src/renderer/ui/chat-approvals');
  return create;
}

describe('chat-approvals: утверждение плана', () => {
  it('кнопка «Утвердить» отдаёт согласие и сворачивает карточку', async () => {
    const create = await setup();
    const { host: approvalHost, mounted } = host();
    const approval = create(approvalHost as never);

    const decision = approval.ask('план работ');
    expect(mounted).toHaveLength(1);
    expect(mounted[0]?.findAll((item) => item.text === 'план работ')).toHaveLength(1);

    const approve = mounted[0]?.findAll((item) => item.text === 'Утвердить')[0];
    approve?.fire('click');

    await expect(decision).resolves.toEqual({ approved: true, note: '' });
    expect(mounted[0]?.classes.has('decision-done')).toBe(true);
    expect(mounted[0]?.findAll((item) => item.text === 'План утверждён — работаю')).toHaveLength(1);
  });

  it('«Продолжить планировать» уводит план на доработку', async () => {
    const create = await setup();
    const { host: approvalHost, mounted } = host();
    const decision = create(approvalHost as never).ask('план');

    mounted[0]?.findAll((item) => item.text === 'Продолжить планировать')[0]?.fire('click');

    await expect(decision).resolves.toEqual({ approved: false, note: '' });
    expect(mounted[0]?.findAll((item) => item.text === 'План отправлен на доработку')).toHaveLength(1);
  });

  it('Enter без замечания — согласие, а с замечанием — доработка', async () => {
    const create = await setup();
    const { host: approvalHost, mounted } = host();
    const approval = create(approvalHost as never);

    const first = approval.ask('план');
    const note = mounted[0]?.findAll((item) => item.tag === 'input')[0];
    note?.fire('keydown', { key: 'Enter', preventDefault: () => {} });
    await expect(first).resolves.toEqual({ approved: true, note: '' });

    const second = approval.ask('план');
    const note2 = mounted[1]?.findAll((item) => item.tag === 'input')[0];
    if (note2) note2.value = 'переделай раздел 2';
    note2?.fire('keydown', { key: 'Enter', preventDefault: () => {} });
    await expect(second).resolves.toEqual({ approved: false, note: 'переделай раздел 2' });
  });

  it('не-Enter ничего не решает', async () => {
    const create = await setup();
    const { host: approvalHost, mounted } = host();
    let settled = false;
    void create(approvalHost as never)
      .ask('план')
      .then(() => {
        settled = true;
      });

    const note = mounted[0]?.findAll((item) => item.tag === 'input')[0];
    note?.fire('keydown', { key: 'a', preventDefault: () => {} });
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('прерванный прогон отправляет план на доработку и снимает регистрацию', async () => {
    const create = await setup();
    const { host: approvalHost, mounted, interrupt, cancels } = host();
    const decision = create(approvalHost as never).ask('план');
    expect(cancels).toHaveLength(1);

    interrupt();

    await expect(decision).resolves.toEqual({ approved: false, note: '' });
    expect(cancels).toHaveLength(0);
    expect(mounted[0]?.classes.has('decision-done')).toBe(true);
  });

  it('пустой план не рисует строку с текстом', async () => {
    const create = await setup();
    const { host: approvalHost, mounted } = host();
    void create(approvalHost as never).ask('   ');
    expect(mounted[0]?.findAll((item) => item.attrs.class === 'ask-question')).toHaveLength(0);
  });
});

describe('chat-approvals: вопрос ассистента', () => {
  async function setupAsk() {
    vi.doMock('../src/renderer/ui/dom', () => mountDom());
    const { createAskPrompt } = await import('../src/renderer/ui/chat-approvals');
    return createAskPrompt;
  }

  it('готовый вариант — это сразу ответ', async () => {
    const create = await setupAsk();
    const { host: approvalHost, mounted } = host();
    const decision = create(approvalHost as never).ask('какой язык?', ['TypeScript', 'Python']);
    mounted[0]?.findAll((item) => item.tag === 'button' && item.text === 'Python')[0]?.fire('click');
    await expect(decision).resolves.toBe('Python');
    expect(mounted[0]?.classes.has('decision-done')).toBe(true);
  });

  it('Enter отправляет набранный ответ', async () => {
    const create = await setupAsk();
    const { host: approvalHost, mounted } = host();
    const decision = create(approvalHost as never).ask('куда?');
    const input = mounted[0]?.findAll((item) => item.tag === 'input')[0];
    if (input) input.value = 'в корень';
    input?.fire('keydown', { key: 'Enter', preventDefault: () => {} });
    await expect(decision).resolves.toBe('в корень');
  });

  it('длинный ответ в строке итога обрезается, а отмена пишет «отменено»', async () => {
    const create = await setupAsk();
    const { host: approvalHost, mounted } = host();
    const long = 'а'.repeat(120);
    const first = create(approvalHost as never).ask('вопрос');
    const input = mounted[0]?.findAll((item) => item.tag === 'input')[0];
    if (input) input.value = long;
    input?.fire('keydown', { key: 'Enter', preventDefault: () => {} });
    await first;
    expect(mounted[0]?.findAll((item) => item.text === `${'а'.repeat(79)}…`)).toHaveLength(1);

    void create(approvalHost as never).ask('вопрос');
    mounted[1]?.findAll((item) => item.text === 'Отменить')[0]?.fire('click');
    expect(mounted[1]?.findAll((item) => item.text === 'отменено')).toHaveLength(1);
  });

  it('без вариантов строки вариантов нет', async () => {
    const create = await setupAsk();
    const { host: approvalHost, mounted } = host();
    void create(approvalHost as never).ask('вопрос');
    expect(mounted[0]?.findAll((item) => item.attrs.class === 'ask-options')).toHaveLength(0);
  });
});

describe('chat-approvals: команда в браузере и в терминале', () => {
  async function setupCommand() {
    vi.doMock('../src/renderer/ui/dom', () => mountDom());
    const { createCommandApproval } = await import('../src/renderer/ui/chat-approvals');
    return createCommandApproval;
  }

  it('«Выполнить» разрешает выполнение и показывает статус', async () => {
    const create = await setupCommand();
    const { host: approvalHost, mounted } = host();
    const decision = create(approvalHost as never).confirm('npm test', undefined);
    mounted[0]?.findAll((item) => item.text === 'Выполнить')[0]?.fire('click');
    await expect(decision).resolves.toBe(true);
    expect(mounted[0]?.findAll((item) => item.text === 'разрешено')).toHaveLength(1);
  });

  it('причина проверки модели стоит в карточке, а без неё строки нет', async () => {
    const create = await setupCommand();
    const { host: approvalHost, mounted } = host();
    void create(approvalHost as never).confirm('rm -rf build', 'модель не ответила');
    expect(mounted[0]?.findAll((item) => item.text === 'Проверка не решилась: модель не ответила')).toHaveLength(1);

    void create(approvalHost as never).confirm('npm test', undefined);
    expect(mounted[1]?.findAll((item) => item.attrs.class === 'approval-review-note')).toHaveLength(0);
  });

  it('действие в браузере рисуется своей подсказкой и отменяется', async () => {
    const create = await setupCommand();
    const { host: approvalHost, mounted } = host();
    const decision = create(approvalHost as never).confirmBrowser('открыть страницу');
    expect(mounted[0]?.findAll((item) => item.text === 'открыть страницу')).toHaveLength(1);
    mounted[0]?.findAll((item) => item.text === 'Отменить')[0]?.fire('click');
    await expect(decision).resolves.toBe(false);
    expect(mounted[0]?.findAll((item) => item.text === 'отменено')).toHaveLength(1);
  });
});
