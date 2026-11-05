import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Цепочка «точка → member-access → языковой сервер» на живом ассистенте.
 *
 * Разбор места (`memberAccessAt`) и ответ сервера (`toCompletions`) проверяются сами по
 * себе в других файлах. Здесь — стык: что доезжает до `lsp`-шва после точки, что видит
 * человек, когда сервер ответил `null`, промолчал ошибкой или отменил запрос.
 * Вызовов сервера никто не делает: `lsp` — обычная функция, её и подменяем.
 */

class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  textContent = '';
  className = '';
  style: Record<string, unknown> = { setProperty: () => {} };
  dataset: Record<string, string> = {};
  scrollHeight = 0;
  classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
  constructor(public tagName: string) {}
  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  insertBefore(node: FakeNode, before: FakeNode): void {
    node.parent = this;
    const at = this.children.indexOf(before);
    if (at < 0) this.children.push(node);
    else this.children.splice(at, 0, node);
  }
  appendChild(node: FakeNode): void {
    this.append(node);
  }
  removeChild(node: FakeNode): void {
    const at = this.children.indexOf(node);
    if (at >= 0) this.children.splice(at, 1);
    node.parent = null;
  }
  remove(): void {
    this.parent?.removeChild(this);
  }
  focus(): void {}
  setProperty(): void {}
  get clientWidth(): number {
    return 800;
  }
  get clientHeight(): number {
    return 600;
  }
  replaceChildren(...nodes: FakeNode[]): void {
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(): void {}
  removeAttribute(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  querySelector(): null {
    return null;
  }
  querySelectorAll(): FakeNode[] {
    return [];
  }
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  get offsetWidth(): number {
    return 0;
  }
  get offsetHeight(): number {
    return 0;
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
const root = new FakeNode('div');

beforeEach(() => {
  globals.document = {
    createElement: (tag: string) => new FakeNode(tag),
    createDocumentFragment: () => new FakeNode('fragment'),
    createTextNode: (text: string) => {
      const node = new FakeNode('#text');
      node.textContent = text;
      return node;
    },
    body: root,
    documentElement: root,
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
  };
  globals.window = {
    devicePixelRatio: 1,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    // Ассистент ставит через них отложенный повтор (isIncomplete, повтор при
    // пустом ответе). Без них промис уходит в `.catch`, и повтора не видно.
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  globals.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  globals.cancelAnimationFrame = () => {};
  globals.HTMLElement = FakeNode;
});

const { CompletionAssistant } = await import('../src/renderer/editor/complete/assistant');
const { TextBuffer } = await import('../src/renderer/editor/core/text-buffer');
const { EditorView } = await import('../src/renderer/editor/view/editor-view');
const { EditorController } = await import('../src/renderer/editor/input/editor-controller');

interface Ask {
  prefix: string;
  context: { triggerKind?: number; triggerCharacter?: string } | undefined;
}

/** Ассистент с подменённым `lsp`-швом: каждый спрос запоминается. */
async function open(
  text: string,
  answer: (ask: Ask) => Promise<{ items: readonly { label: string }[]; isIncomplete: boolean }>,
): Promise<{ asks: Ask[]; type(added: string): Promise<void>; labels(): string[]; wait(ms: number): Promise<void> }> {
  const host = new FakeNode('div');
  root.append(host);
  const buffer = new TextBuffer(text);
  const view = new EditorView(host as unknown as HTMLElement, buffer, {});
  const controller = new EditorController(buffer);

  const shown: string[] = [];
  let visible = false;
  const widget = {
    get isVisible(): boolean {
      return visible;
    },
    labels: () => [...shown],
    show: (items: readonly { label: string }[]) => {
      shown.length = 0;
      shown.push(...items.map((item) => item.label));
      visible = true;
    },
    append: (items: readonly { label: string }[]) => {
      shown.push(...items.map((item) => item.label));
    },
    hide: () => {
      visible = false;
    },
    patch: () => {},
    handleKey: () => false,
    get allItems(): readonly unknown[] {
      return [];
    },
    current: null,
  };

  const asks: Ask[] = [];
  const assistant = new CompletionAssistant(view, controller, buffer, widget as never, {
    currentPath: () => '/project/src/main.ts',
    projectFiles: async () => [],
    lsp: async (prefix, _position, context) => {
      const ask: Ask = { prefix, context };
      asks.push(ask);
      const result = await answer(ask);
      return result as never;
    },
  });
  assistant.setLanguage('typescript');
  view.clientPoint = () => ({ left: 10, top: 20, bottom: 40, height: 20 });
  view.tokenTypeAt = () => 'plain';

  return {
    asks,
    labels: () => [...shown],
    /** Дать отложенному повтору (300 мс) отработать — как в жизни. */
    wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    type: async (added: string) => {
      const from = buffer.text.length;
      buffer.insert(from, added);
      controller.setSelection({ anchor: buffer.text.length, active: buffer.text.length });
      assistant.onChange({ kind: 'insert', from, to: from + added.length } as never);
      // Ответ сервера приходит промисом — даём ему дойти.
      for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe('точка → member-access → сервер', () => {
  it('точка уходит серверу как triggerKind 2 со знаком .', async () => {
    const h = await open('const a = foo.', async () => ({ items: [], isIncomplete: false }));
    await h.type('');
    const ask = h.asks.find((item) => item.prefix === '');
    expect(ask?.context).toEqual({ triggerKind: 2, triggerCharacter: '.' });
  });

  it('члены из ответа сервера показываются после точки', async () => {
    const h = await open('const a = foo.', async () => ({
      items: [{ label: 'alpha' }, { label: 'beta' }],
      isIncomplete: false,
    }));
    await h.type('');
    expect(h.labels()).toEqual(expect.arrayContaining(['alpha', 'beta']));
  });

  it('ответ null не гасит список и не роняет ассистента: просто ничего не добавляет', async () => {
    const h = await open('const a = foo.', async () => null as never);
    await expect(h.type('')).resolves.toBeUndefined();
    expect(h.labels()).not.toContain(null as never);
  });

  it('ошибка сервера не роняет ввод: ассистент жив и отвечает на следующую точку', async () => {
    let fail = true;
    const h = await open('const a = foo.', async () => {
      if (fail) throw new Error('сервер отвалился');
      return { items: [{ label: 'later' }], isIncomplete: false };
    });
    await h.type('');
    fail = false;
    // Вторая точка в том же файле — новый запрос; первый провал его не отравил.
    await h.type('b.');
    expect(h.labels()).toContain('later');
  });

  it('обрезанный ответ (isIncomplete) догоняется повторным запросом с triggerKind 3', async () => {
    let call = 0;
    const h = await open('const a = foo.', async () => {
      call += 1;
      if (call === 1) return { items: [{ label: 'first' }], isIncomplete: true };
      return { items: [{ label: 'second' }], isIncomplete: false };
    });
    await h.type('');
    // Повтор по isIncomplete отложен на 300 мс — ждём его по-настоящему.
    await h.wait(350);
    expect(h.asks.some((ask) => ask.context?.triggerKind === 3)).toBe(true);
    // Повтор снимает пометку isIncomplete и перерисовывает список целиком,
    // поэтому виден окончательный ответ, а не два списка вместе.
    expect(h.labels()).toEqual(['second']);
  });
});
