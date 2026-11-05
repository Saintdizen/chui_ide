import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Обход мест раскрытого сниппета по `Tab` (TASKS 45).
 *
 * Стенд тот же, что у `assistant-imports`: виджет — заглушка, вместо диска — пустой
 * проект. Проверяется стык: ассистент запомнил заготовку при вставке и дальше ведёт
 * каретку по её местам сам, не спрашивая буфер заново.
 */

class FakeNode {
  tagName: string;
  children: FakeNode[] = [];
  textContent = '';
  className = '';
  style: Record<string, unknown> = { setProperty: () => {} };
  dataset: Record<string, string> = {};
  hidden = false;
  scrollTop = 0;
  scrollHeight = 0;
  scrollWidth = 0;
  clientHeight = 0;
  clientWidth = 0;
  offsetHeight = 0;
  offsetTop = 0;
  offsetLeft = 0;
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.children[this.children.length - 1] ?? null;
  }
  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }
  appendChild(node: FakeNode): FakeNode {
    this.children.push(node);
    return node;
  }
  remove(): void {}
  removeChild(): void {}
  insertBefore(node: FakeNode, before: FakeNode): void {
    const at = this.children.indexOf(before);
    if (at < 0) this.children.push(node);
    else this.children.splice(at, 0, node);
  }
  replaceChildren(...nodes: FakeNode[]): void {
    this.children = nodes;
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
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  focus(): void {}
  blur(): void {}
  setProperty(): void {}
  classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
}

const root = new FakeNode('html');

beforeEach(() => {
  root.children = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.document = {
    createElement: (tag: string) => new FakeNode(tag),
    createDocumentFragment: () => new FakeNode('fragment'),
    createTextNode: (text: string) => {
      const node = new FakeNode('#text');
      node.textContent = text;
      return node;
    },
    body: root,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globals.window = {
    innerWidth: 1200,
    innerHeight: 900,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({
      fontSize: '13px',
      lineHeight: '20px',
      fontFamily: 'monospace',
      letterSpacing: '0px',
      getPropertyValue: () => '',
    }),
  };
  globals.HTMLElement = FakeNode;
});

const { CompletionAssistant } = await import('../src/renderer/editor/complete/assistant');
const { TextBuffer } = await import('../src/renderer/editor/core/text-buffer');
const { EditorView } = await import('../src/renderer/editor/view/editor-view');
const { EditorController } = await import('../src/renderer/editor/input/editor-controller');

/** Стенд: документ, каретка, виджет-заглушка с одним текущим элементом. */
function bench(text: string) {
  const host = new FakeNode('div');
  root.append(host);
  const buffer = new TextBuffer(text);
  const view = new EditorView(host as unknown as HTMLElement, buffer, {});
  const controller = new EditorController(buffer);
  const state: { current: unknown; visible: boolean } = { current: null, visible: false };
  const widget = {
    get isVisible() {
      return state.visible;
    },
    get current() {
      return state.current;
    },
    get replaces() {
      return 0;
    },
    labels: () => [],
    show: () => {
      state.visible = true;
    },
    append: () => {},
    hide: () => {
      state.visible = false;
    },
    patch: () => {},
    handleKey: () => false,
    allItems: () => [],
    onAccept: null as unknown,
    onSelect: null as unknown,
  };
  const assistant = new CompletionAssistant(view, controller, buffer, widget as never, {
    readSource: async () => null,
    currentPath: () => '/project/src/main.ts',
    projectFiles: async () => [],
  });
  assistant.setLanguage('typescript');
  view.clientPoint = () => ({ left: 10, top: 20, bottom: 40, height: 20 });
  view.tokenTypeAt = () => 'plain';
  const caretTo = (offset: number): void => controller.setSelection({ anchor: offset, active: offset });
  caretTo(text.length);
  return { assistant, controller, buffer, widget, state, caretTo };
}

/** Вставить заготовку так же, как её вставляет принятая подсказка. */
function insertSnippet(setup: ReturnType<typeof bench>, snippet: string): void {
  setup.state.current = { label: 'for', snippet };
  setup.state.visible = true;
  (setup.widget.onAccept as () => void)();
}

describe('Tab по местам сниппета', () => {
  it('после вставки каретка на первом месте, Tab ведёт по остальным', () => {
    const setup = bench('');
    insertSnippet(setup, 'for (const ${1:item} of ${2:list}) {\n\t$0\n}');
    // Первое место выделено целиком: набираемое заменит черновик.
    expect(setup.controller.selection).toEqual({ anchor: 11, active: 15 });
    expect(setup.assistant.goToSnippetStop('next')).toBe(true);
    expect(setup.controller.selection).toEqual({ anchor: 19, active: 23 });
  });

  it('после последнего места Tab уступает клавишу редактору', () => {
    const setup = bench('');
    insertSnippet(setup, '${1:a} ${2:b}');
    setup.assistant.goToSnippetStop('next');
    // Выходим за сниппет: `done`. Дальше Tab — уже отступ.
    expect(setup.assistant.goToSnippetStop('next')).toBe(true);
    expect(setup.assistant.goToSnippetStop('next')).toBe(false);
    // Каретка стоит за текстом заготовки, ничего не выделено.
    expect(setup.controller.selection).toEqual({ anchor: 3, active: 3 });
  });

  it('Shift+Tab возвращает назад, на первом месте не падает', () => {
    const setup = bench('');
    insertSnippet(setup, '${1:a} ${2:b}');
    expect(setup.assistant.goToSnippetStop('next')).toBe(true);
    expect(setup.assistant.goToSnippetStop('previous')).toBe(true);
    expect(setup.controller.selection).toEqual({ anchor: 0, active: 1 });
    // На первом — остаёмся, но клавишу всё равно не отдаём редактору.
    expect(setup.assistant.goToSnippetStop('previous')).toBe(true);
    expect(setup.controller.selection).toEqual({ anchor: 0, active: 1 });
  });

  it('без сниппета Tab свободен', () => {
    const setup = bench('const a = 1;');
    expect(setup.assistant.goToSnippetStop('next')).toBe(false);
  });

  it('правка в стороне обрывает обход', () => {
    const setup = bench('');
    insertSnippet(setup, '${1:a} ${2:b}');
    // Правка в начале файла, вне заготовки: места после неё сдвинулись, верить им нельзя.
    setup.assistant.onChange({ kind: 'text', from: 1000 } as never);
    expect(setup.assistant.goToSnippetStop('next')).toBe(false);
  });

  it('набор внутри места обход не рвёт', () => {
    const setup = bench('');
    insertSnippet(setup, '${1:a} ${2:b}');
    setup.assistant.onChange({ kind: 'text', from: 0 } as never);
    expect(setup.assistant.goToSnippetStop('next')).toBe(true);
  });
});
