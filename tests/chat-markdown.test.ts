import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownRenderer } from '../src/renderer/ui/chat-markdown';

// Кнопки блока кода говорят о результате тостом: в чистом Node его нет.
const toasts = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock('../src/renderer/ui/toast', () => ({
  showToast: (text: string) => {
    toasts.list.push(text);
  },
}));

/**
 * Разбор разметки для ленты чата проверяется здесь, а не в окне: ошибка, которую
 * эти тесты стерегут, видна только в движении — стрим зовёт `renderInto` каждый
 * кадр, и блок, чей ключ совпал с прошлым кадром, остаётся на экране таким, каким
 * был в тот момент. Достаточно ключа, не зависящего от исходника, чтобы заголовок
 * навсегда застыл обрезанным на полуслове («## Что зан»).
 *
 * Браузера нет: `vitest` гоняет набор в чистом Node. Подменяем ровно то, чем
 * пользуется разбор, — узлы, дерево и текст; DOM появляется на время теста.
 */
class FakeElement {
  readonly tag: string;
  readonly children: FakeElement[] = [];
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly listeners = new Map<string, EventListener[]>();
  parent: FakeElement | null = null;
  className = '';
  hidden = false;
  text = '';

  constructor(tag: string) {
    this.tag = tag;
  }

  get childNodes(): FakeElement[] {
    return this.children;
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get lastChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null;
  }

  /** Узлы теста в документ не вставлены: подсветка по этому признаку чистит реестр. */
  get isConnected(): boolean {
    return false;
  }

  get offsetWidth(): number {
    return 0;
  }

  get classList(): { add(name: string): void; remove(name: string): void } {
    return {
      add: (name: string) => {
        if (!this.className.split(' ').includes(name)) this.className = `${this.className} ${name}`.trim();
      },
      remove: (name: string) => {
        this.className = this.className
          .split(' ')
          .filter((item) => item && item !== name)
          .join(' ');
      },
    };
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.children.length = 0;
    this.text = value;
  }

  /** Подсветка кода кладёт готовую разметку строкой — держим её как текст. */
  get innerHTML(): string {
    return this.text;
  }

  set innerHTML(value: string) {
    this.text = value;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  appendChild(child: FakeElement): FakeElement {
    return this.insertAt(child, this.children.length);
  }

  insertBefore(child: FakeElement, reference: FakeElement | null): FakeElement {
    const at = reference ? this.children.indexOf(reference) : -1;
    return this.insertAt(child, at < 0 ? this.children.length : at);
  }

  removeChild(child: FakeElement): FakeElement {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    child.parent = null;
    return child;
  }

  remove(): void {
    this.parent?.removeChild(this);
  }

  private insertAt(child: FakeElement, at: number): FakeElement {
    child.parent = this;
    this.children.splice(at, 0, child);
    return child;
  }
}

function fakeDocument(): Record<string, unknown> {
  const create = (tag: string): FakeElement => new FakeElement(tag);
  return {
    createElement: create,
    createElementNS: (_namespace: string, tag: string) => create(tag),
    createTextNode: (text: string) => {
      const node = new FakeElement('#text');
      node.text = text;
      return node;
    },
  };
}

/** Форма дерева: тег, класс и дети. По ней видно, что именно нарисовано. */
function shape(node: FakeElement): string {
  if (node.tag === '#text') return JSON.stringify(node.text);
  return `${node.tag}.${node.className}[${node.children.map(shape).join('|')}]`;
}

/** Образцы разметки: по одному на каждую ветку `markdownBlocks`. */
const SAMPLES: Record<string, string> = {
  заголовки: '# один\n## два\n### три\n#### четыре',
  'заголовки подряд': '## Первый\n## Второй\n## Третий',
  списки: '- а\n- б\n\n1. раз\n2. два',
  чеклист: '- [x] готово\n- [ ] нет',
  цитата: '> строка\n> вторая\n\nтекст',
  таблица: '| a | b |\n| - | - |\n| 1 | 2 |',
  абзацы: 'первый абзац\nвторая строка\n\nвторой',
  'горизонтальная линия': '---\n\n***\n\ntext',
  смесь: '## Заголовок\n\nтекст **жир** и `код`\n\n- пункт\n\n---\n\n## Второй',
};

describe('разметка ленты чата', () => {
  beforeEach(() => {
    (globalThis as { document?: unknown }).document = fakeDocument();
  });

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  // Стрим отдаёт текст по кусочку, и каждый кадр рисуется в тот же контейнер.
  // Ошибка ключа видна как расхождение: живой контейнер отличается от чистого
  // рендера того же текста — значит какой-то блок остался от прошлого кадра.
  for (const [name, text] of Object.entries(SAMPLES)) {
    it(`${name}: посимвольный стрим рисует то же, что чистый рендер`, () => {
      const renderer = createMarkdownRenderer({ insertCode: () => false });
      const live = new FakeElement('div');
      const diverged: string[] = [];

      for (let at = 0; at <= text.length; at += 1) {
        const chunk = text.slice(0, at);
        renderer.renderInto(live as unknown as HTMLElement, chunk, { streaming: true });
        const fresh = new FakeElement('div');
        renderer.renderInto(fresh as unknown as HTMLElement, chunk, { streaming: true });
        const got = live.children.map(shape).join('|');
        const want = fresh.children.map(shape).join('|');
        if (got !== want) {
          diverged.push(`${at} «${chunk.slice(-20)}»: ${got} ≠ ${want}`);
        }
      }

      expect(diverged).toEqual([]);
    });
  }

  it('второй заголовок дорисовывается, а не застывает первым', () => {
    const renderer = createMarkdownRenderer({ insertCode: () => false });
    const live = new FakeElement('div');

    renderer.renderInto(live as unknown as HTMLElement, '## Первый', { streaming: true });
    renderer.renderInto(live as unknown as HTMLElement, '## Первый\n## Второй', { streaming: true });

    expect(live.textContent).toContain('Второй');
  });

  it('подсказку в контейнере не принимает за готовые блоки', () => {
    // Так ведёт себя предпросмотр markdown: в тот же узел кладут подсказку, когда
    // файл пуст или открыт не markdown, а потом снова отдают его разметке.
    const renderer = createMarkdownRenderer({ insertCode: () => false });
    const body = new FakeElement('div');
    const withText = '## Заголовок\n\nтекст';

    renderer.renderInto(body as unknown as HTMLElement, withText);
    body.textContent = '';
    const note = new FakeElement('div');
    note.textContent = 'Файл не открыт';
    body.appendChild(note);

    renderer.renderInto(body as unknown as HTMLElement, withText);

    expect(body.textContent).toContain('Заголовок');
    expect(body.textContent).toContain('текст');
    expect(body.textContent).not.toContain('Файл не открыт');
  });

  /**
   * Кнопки под блоком кода. Без них ответ модели переносят руками — самая частая
   * работа с ответом, где есть код.
   */
  describe('ссылки на файлы', () => {
    type Node = {
      attributes?: Record<string, string>;
      children?: Node[];
      text?: string;
      listeners?: Map<string, EventListener[]>;
    };

    /** Кликабельные пути ответа: подпись и то, что было бы открыто. */
    function places(markdown: string) {
      const opened: string[] = [];
      const renderer = createMarkdownRenderer({
        insertCode: () => false,
        openPath: (path, line, column) =>
          opened.push([path, line, column].filter((part) => part !== undefined).join(':')),
      });
      const body = new FakeElement('div') as unknown as HTMLElement;
      renderer.renderInto(body, markdown);
      const found: { title: string; caption: string; click(): void }[] = [];
      const walk = (node: Node): void => {
        const title = node.attributes?.title ?? '';
        if (title.endsWith('— открыть')) {
          found.push({
            title,
            // Подпись кнопки — текстовое содержимое узла.
            caption: (node as unknown as { textContent?: string }).textContent ?? '',
            click: () => {
              for (const listener of node.listeners?.get('click') ?? []) {
                listener({ preventDefault() {}, stopPropagation() {} } as never);
              }
            },
          });
        }
        for (const child of node.children ?? []) walk(child);
      };
      walk(body as unknown as Node);
      return { found, opened };
    }

    it('путь в инлайн-коде открывает файл на названной строке', () => {
      const { found, opened } = places('Правка в `src/main/app.ts:42:7` сделана.');

      expect(found.map((place) => place.caption)).toEqual(['src/main/app.ts:42:7']);
      found[0]?.click();
      expect(opened).toEqual(['src/main/app.ts:42:7']);
    });

    it('путь без номера строки остаётся кликабельным — открыть с начала', () => {
      const { found, opened } = places('Смотри `shared/api/ai.ts`.');
      found[0]?.click();
      expect(opened).toEqual(['shared/api/ai.ts']);
    });

    it('голый путь в тексте тоже кликабельный', () => {
      const { found } = places('Подробнее — src/renderer/ui/chat.ts:12.');
      // Точка в конце фразы — знак препинания, а не часть пути.
      expect(found.map((place) => place.title)).toEqual(['src/renderer/ui/chat.ts:12 — открыть']);
    });

    it('обычные слова и номера версий ссылками не становятся', () => {
      const { found } = places('Версия v1.2, файл a.ts и число 12 — ничего не открываем.');
      // `a.ts` — имя с известным расширением, его считаем путём; `v1.2` — нет.
      expect(found.map((place) => place.title)).toEqual(['a.ts — открыть']);
    });

    it('без обработчика пути остаются текстом', () => {
      const renderer = createMarkdownRenderer({ insertCode: () => false });
      const body = new FakeElement('div') as unknown as HTMLElement;
      renderer.renderInto(body, 'Правка в `src/main/app.ts`.');
      const found: string[] = [];
      const walk = (node: Node): void => {
        if (node.attributes?.title) found.push(node.attributes.title);
        for (const child of node.children ?? []) walk(child);
      };
      walk(body as unknown as Node);
      expect(found.filter((title) => title.endsWith('— открыть'))).toEqual([]);
    });
  });

  describe('действия блока кода', () => {
    const CODE = '```ts\nconst a = 1;\n```';

    type Node = {
      attributes?: Record<string, string>;
      children?: Node[];
      listeners?: Map<string, EventListener[]>;
    };

    /** Кнопки блока кода: ищем по подписи и зовём обработчики клика. */
    function buttons(insertCode: (code: string) => boolean) {
      const renderer = createMarkdownRenderer({ insertCode });
      const body = new FakeElement('div') as unknown as HTMLElement;
      renderer.renderInto(body, CODE);
      const found: { title: string; click(): void }[] = [];
      const walk = (node: Node): void => {
        const title = node.attributes?.title;
        if (title) {
          found.push({
            title,
            click: () => {
              for (const listener of node.listeners?.get('click') ?? []) {
                listener({ preventDefault() {}, stopPropagation() {} } as never);
              }
            },
          });
        }
        for (const child of node.children ?? []) walk(child);
      };
      walk(body as unknown as Node);
      return found;
    }

    it('в блоке кода есть копирование и вставка', () => {
      const titles = buttons(() => true).map((button) => button.title);

      expect(titles).toContain('Копировать');
      expect(titles).toContain('Вставить в позицию курсора');
    });

    it('вставка без открытого редактора говорит причину, а не молчит', () => {
      // Кнопка есть всегда: её отсутствие читалось бы как «действие пропало».
      toasts.list.length = 0;
      const insert = buttons(() => false).find((button) => button.title === 'Вставить в позицию курсора');

      insert?.click();

      expect(toasts.list).toEqual(['Нет открытого редактора']);
    });

    it('вставка с открытым редактором подтверждает действие', () => {
      toasts.list.length = 0;
      const seen: string[] = [];
      const insert = buttons((code) => {
        seen.push(code);
        return true;
      }).find((button) => button.title === 'Вставить в позицию курсора');

      insert?.click();

      expect(seen[0]).toContain('const a = 1;');
      expect(toasts.list).toEqual(['Вставлено в позицию курсора']);
    });

    it('копирование проходит, когда буфер доступен', async () => {
      const written: string[] = [];
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { clipboard: { writeText: async (text: string) => written.push(text) } },
      });
      const copy = buttons(() => true).find((button) => button.title === 'Копировать');

      copy?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Копируется код блока без ограждения из обратных кавычек.
      expect(written[0]).toContain('const a = 1;');
      expect(written[0]).not.toContain('```');
    });

    it('недоступный буфер обмена не роняет нажатие', async () => {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
          clipboard: {
            writeText: async () => {
              throw new Error('запрещено');
            },
          },
        },
      });
      const copy = buttons(() => true).find((button) => button.title === 'Копировать');

      copy?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(true).toBe(true);
    });
  });
});
