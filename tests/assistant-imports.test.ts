import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Полный путь ассистента: точка после имени класса, чьё тело лежит в соседнем файле.
 *
 * Здесь проверяется не разбор сам по себе (он в editor-member-access.test.ts), а связка:
 * какой файл ищется, что кладётся в кэш, когда кэш сбрасывается. DOM подменён руками —
 * jsdom в проекте нет (см. suggest-widget-position.test.ts).
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
  setProperty(): void {}
  remove(): void {
    this.parent?.removeChild(this);
  }
  focus(): void {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  get clientWidth(): number {
    return 800;
  }
  get clientHeight(): number {
    return 600;
  }
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
  };
  (globals.window as Record<string, unknown>).getComputedStyle = () => ({
    fontSize: '13px',
    lineHeight: '20px',
    fontFamily: 'monospace',
    letterSpacing: '0px',
    getPropertyValue: () => '',
  });
  globals.HTMLElement = FakeNode;
});

const { CompletionAssistant } = await import('../src/renderer/editor/complete/assistant');
const { TextBuffer } = await import('../src/renderer/editor/core/text-buffer');
const { EditorView } = await import('../src/renderer/editor/view/editor-view');
const { EditorController } = await import('../src/renderer/editor/input/editor-controller');

type Reader = (path: string) => Promise<string | null>;

interface Harness {
  assistant: InstanceType<typeof CompletionAssistant>;
  widget: { labels(): string[]; isVisible: boolean };
  /** Поставить каретку в конец и прислать правку — так же, как при вводе. */
  type(added: string): Promise<void>;
  reads: string[];
}

/**
 * Открыть файл в ассистенте. `sources` — что отдаст чтение с диска, `files` — карта
 * проекта. Каждое чтение записывается в `reads`: по нему видно, ходил ли ассистент на
 * диск повторно.
 */
async function open(
  text: string,
  options: {
    path?: string;
    sources?: Record<string, string>;
    files?: readonly string[];
    onDidWriteFile?: (listener: (path: string) => void) => () => void;
  } = {},
): Promise<Harness> {
  const host = new FakeNode('div');
  root.append(host);
  const buffer = new TextBuffer(text);
  const view = new EditorView(host as unknown as HTMLElement, buffer, {});
  const controller = new EditorController(buffer);
  const caretTo = (offset: number): void => controller.setSelection({ anchor: offset, active: offset });

  const reads: string[] = [];
  const files = options.files ?? Object.keys(options.sources ?? {});
  const read: Reader = async (path) => {
    reads.push(path);
    return options.sources?.[path] ?? null;
  };

  const shown: string[] = [];
  const state = { visible: false };
  const widget = {
    get isVisible(): boolean {
      return state.visible;
    },
    labels: () => [...shown],
    show: (items: readonly { label: string }[]) => {
      shown.length = 0;
      shown.push(...items.map((item) => item.label));
      state.visible = true;
    },
    append: (items: readonly { label: string }[]) => {
      shown.push(...items.map((item) => item.label));
    },
    hide: () => {
      state.visible = false;
    },
    patch: () => {},
    handleKey: () => false,
    allItems: () => [],
    current: null,
    onAccept: null as unknown,
    onSelect: null as unknown,
  };

  const assistant = new CompletionAssistant(view, controller, buffer, widget as never, {
    readSource: read,
    currentPath: () => options.path ?? '/project/src/main.ts',
    projectFiles: async () => files,
    onDidWriteFile: options.onDidWriteFile,
  });
  assistant.setLanguage('typescript');
  // Раскладки нет: точку привязки и тип токена задаём сами.
  view.clientPoint = () => ({ left: 10, top: 20, bottom: 40, height: 20 });
  view.tokenTypeAt = () => 'plain';

  return {
    assistant,
    widget: widget as unknown as Harness['widget'],
    reads,
    type: async (added: string) => {
      const from = buffer.text.length;
      buffer.insert(from, added);
      caretTo(buffer.text.length);
      assistant.onChange({ kind: 'insert', from, to: from + added.length } as never);
      // Ответ с диска приходит промисом — даём ему дойти.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe('члены класса из соседнего файла', () => {
  it('класс во ВТОРОМ импорте — члены всё равно находятся', async () => {
    // Первый спецификатор ведёт на файл, где класса нет вовсе, — раньше поиск
    // останавливался на нём и подсказка молчала.
    const harness = await open(
      "import { Icons } from './icons';\nimport { Elements } from './elements';\n\nElements.",
      {
        sources: {
          '/project/src/icons.ts': 'export const ICON_SIZE = 16;\n',
          '/project/src/elements.ts': 'export class Elements {\n  lkButton: number = 1;\n  render(): void {}\n}\n',
        },
      },
    );
    await harness.type('');
    expect(harness.widget.labels()).toContain('lkButton');
    expect(harness.widget.labels()).toContain('render');
  });

  it('файл только пересылает — идём на один уровень реэкспорта', async () => {
    const harness = await open("import { Elements } from './elements';\n\nElements.", {
      sources: {
        '/project/src/elements.ts': "export { Elements } from './core/elements';\n",
        '/project/src/core/elements.ts': 'export class Elements {\n  mount(): void {}\n}\n',
      },
    });
    await harness.type('');
    expect(harness.widget.labels()).toContain('mount');
  });

  it('реэкспорт глубже одного уровня не разматывается', async () => {
    // Ограничение намеренное: иначе точка в большом проекте тянула бы чтение дерева.
    const harness = await open("import { Elements } from './elements';\n\nElements.", {
      sources: {
        '/project/src/elements.ts': "export { Elements } from './a';\n",
        '/project/src/a.ts': "export { Elements } from './b';\n",
        '/project/src/b.ts': 'export class Elements {\n  deep(): void {}\n}\n',
      },
    });
    await harness.type('');
    expect(harness.widget.labels()).not.toContain('deep');
  });

  it('прочитанный файл берётся из кэша — второго чтения нет', async () => {
    const harness = await open("import { Elements } from './elements';\n\nElements.", {
      sources: {
        '/project/src/elements.ts': 'export class Elements {\n  mount(): void {}\n}\n',
      },
    });
    await harness.type('');
    const afterFirst = harness.reads.length;
    // Следующий знак после точки — тот же файл, но он уже в памяти.
    await harness.type('m');
    expect(harness.reads.length).toBe(afterFirst);
    expect(harness.widget.labels()).toContain('mount');
  });

  it('запись файла сбрасывает кэш — новое поле видно без перезапуска', async () => {
    type Fire = (path: string) => void;
    // В объекте, а не в переменной: TS не учитывает присваивание из замыкания
    // и сужает `let fire` до `null` там, где его зовут.
    const writes: { fire: Fire | null } = { fire: null };
    const sources: Record<string, string> = {
      '/project/src/elements.ts': 'export class Elements {\n  mount(): void {}\n}\n',
    };
    const harness = await open("import { Elements } from './elements';\n\nElements.", {
      sources,
      onDidWriteFile: (listener: Fire) => {
        writes.fire = listener;
        return () => {
          writes.fire = null;
        };
      },
    });
    await harness.type('');
    expect(harness.widget.labels()).not.toContain('refresh');

    // Файл дописали снаружи: поле `refresh` появилось.
    sources['/project/src/elements.ts'] = 'export class Elements {\n  mount(): void {}\n  refresh(): void {}\n}\n';
    writes.fire?.('/project/src/elements.ts');

    await harness.type('r');
    expect(harness.reads.length).toBeGreaterThan(1);
    expect(harness.widget.labels()).toContain('refresh');
  });
});

describe('гейт по языку', () => {
  it('в markdown после точки попап не открывается', async () => {
    const harness = await open('Смотри файл.', { path: '/project/README.md' });
    harness.assistant.setLanguage('markdown');
    await harness.type('');
    expect(harness.widget.isVisible).toBe(false);
  });

  it('в JSON после точки попап не открывается', async () => {
    const harness = await open('{"a": 1}', { path: '/project/config.json' });
    harness.assistant.setLanguage('json');
    await harness.type('');
    expect(harness.widget.isVisible).toBe(false);
  });

  it('в typescript членов ищет', async () => {
    const harness = await open('this.', { path: '/project/src/main.ts' });
    await harness.type('');
    expect(harness.widget.isVisible).toBe(true);
  });
});
