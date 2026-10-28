/**
 * Попап подсказок: дописывание списка (члены импортированного класса, ответ сервера).
 *
 * jsdom в проекте нет (vitest идёт в node), а виджету нужен лишь `document` да
 * несколько методов узла — рисуем минимальный DOM вручную, как в `lazy-popover`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Мини-узел: ровно то, что трогает виджет. */
class FakeNode {
  children: FakeNode[] = [];
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  hidden = false;
  className = '';
  textContent = '';
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  offsetTop = 0;
  offsetHeight = 0;
  classList = { add: vi.fn(), toggle: vi.fn() };
  private attrs: Record<string, string> = {};

  constructor(public tagName: string) {}

  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  append(...nodes: FakeNode[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: FakeNode[]) {
    this.children = [...nodes];
  }
  querySelector(selector: string): FakeNode | null {
    const cls = selector.replace(/^\./, '');
    for (const child of this.children) {
      if (child.className.split(' ').includes(cls)) return child;
      const deep = child.querySelector(selector);
      if (deep) return deep;
    }
    return null;
  }
  addEventListener() {}
}

const root = new FakeNode('html');

beforeEach(() => {
  root.children = [];
  const document = {
    createElement: (tag: string) => new FakeNode(tag),
    createDocumentFragment: () => new FakeNode('fragment'),
    body: root,
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.document = document;
  globals.window = { innerWidth: 1200, innerHeight: 900 };
  // Виджет проверяет узлы через `instanceof` — без этого класса проверка падала бы.
  globals.HTMLElement = FakeNode;
});

const { SuggestWidget } = await import('../src/renderer/editor/widgets/suggest-widget');

function item(label: string) {
  return { label, kind: 'language' as const, detail: '' };
}

function setup() {
  const host = new FakeNode('div');
  root.append(host);
  const widget = new SuggestWidget(host as unknown as HTMLElement);
  const popup = host.children[0]!;
  const list = popup.children[0]!;
  return { widget, popup, list };
}

describe('попап: дописывание списка', () => {
  it('append пересчитывает место от того же якоря', () => {
    const { widget, popup } = setup();
    widget.show([item('alpha')], { left: 100, top: 200, bottom: 220 }, 0);
    expect(popup.hidden).toBe(false);
    const left = popup.style.left;

    widget.append([item('beta'), item('gamma')]);
    expect(widget.labels()).toEqual(['alpha', 'beta', 'gamma']);
    // Каретка не двигалась — левый край тот же. Верх пересчитан от того же якоря:
    // попап встал над кареткой (места снизу в фейковом окне нет), а не там, где был
    // нарисован прежний, короткий список.
    expect(popup.style.left).toBe(left);
    const top = Number.parseInt(popup.style.top!, 10);
    expect(top).toBeGreaterThan(0);
    expect(top).not.toBe(Number.NaN);
  });

  it('дописывание в закрытый попап не раскрывает его', () => {
    const { widget, popup } = setup();
    widget.show([item('alpha')], { left: 100, top: 200, bottom: 220 }, 0);
    widget.hide();
    widget.append([item('beta')]);
    expect(widget.isVisible).toBe(false);
    expect(popup.hidden).toBe(true);
  });

  it('append без показа не рисует попап', () => {
    const { widget, popup } = setup();
    widget.append([item('alpha')]);
    expect(popup.hidden).toBe(true);
    expect(widget.isVisible).toBe(false);
  });

  it('пустой append ничего не меняет', () => {
    const { widget, popup } = setup();
    widget.show([item('alpha')], { left: 100, top: 200, bottom: 220 }, 0);
    const top = popup.style.top;
    widget.append([]);
    expect(widget.labels()).toEqual(['alpha']);
    expect(popup.style.top).toBe(top);
  });
});

describe('попап: высота по факту', () => {
  it('низкий список меряется по scrollHeight, а не по потолку', () => {
    const { widget, list } = setup();
    // Одна строка CSS-высотой 20px: арифметика «строки × ROW_HEIGHT + 8» дала бы 28,
    // мера — 20. Попап ставим по каретке у нижнего края: короткий список помещается
    // снизу только если взята настоящая высота.
    list.scrollHeight = 20;
    widget.show([item('alpha')], { left: 100, top: 700, bottom: 720 }, 0);
    // 700 + 2 (gap) + 20 = 722 < 900 − 2 (margin): снизу помещается.
    expect(list.style.maxHeight).toBe('200px');
  });

  it('мера берётся после потолка, а не до', () => {
    const { widget, list } = setup();
    // Список длиной больше MAX_VISIBLE: scrollHeight у настоящего узла уже с потолком.
    // Фейк отдаёт значение, которое выставил виджет, — потолок обязан стоять ДО меры.
    const seen: string[] = [];
    let height = 0;
    Object.defineProperty(list, 'scrollHeight', {
      get: () => {
        seen.push(list.style.maxHeight ?? '');
        return height;
      },
      set: (value: number) => {
        height = value;
      },
    });
    height = 160; // как у шести строк по 20px плюс отступы
    widget.show(
      Array.from({ length: 12 }, (_, index) => item(`row${index}`)),
      { left: 100, top: 200, bottom: 220 },
      0,
    );
    expect(seen[0]).toBe('200px');
  });

  it('без раскладки (мера 0) остаётся расчёт по строкам', () => {
    const { widget, popup } = setup();
    // scrollHeight = 0 — как в jsdom. Три строки дают 3 × 20 + 8 = 68.
    widget.show([item('a'), item('b'), item('c')], { left: 100, top: 200, bottom: 220 }, 0);
    expect(popup.style.top).toBe(`${200 - 2 - 68}px`);
  });
});
