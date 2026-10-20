import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMarkdownRenderer } from '../src/renderer/ui/chat-markdown';

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
});
