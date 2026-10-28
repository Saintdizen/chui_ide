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
  /** Высота «по отрисовке»: у фейка раскладки нет, поэтому её задаёт тест. */
  rectHeight = 0;
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
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: this.rectHeight };
  }
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

const { SuggestWidget, docPreview } = await import('../src/renderer/editor/widgets/suggest-widget');

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
    // попап встал под кареткой, а не там, где был нарисован прежний, короткий список.
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
  it('длинный список не переворачивает попап над кареткой', () => {
    const { widget, popup, list } = setup();
    // Беда, ради которой мера заведена: у списка `scrollHeight` потолком не режется
    // и у длинного набора равен высоте ВСЕХ строк (в живой ИДЕ — 1000 при видимых 210).
    // С такой «высотой» попап не влезал ни вниз, ни вверх и прижимался к верхнему
    // краю окна, хотя каретка была посреди экрана.
    list.scrollHeight = 1000;
    popup.rectHeight = 210;
    widget.show(
      Array.from({ length: 40 }, (_, index) => item(`row${index}`)),
      { left: 100, top: 600, bottom: 620 },
      0,
    );
    // 620 + 2 = 622: растёт вниз от каретки, а не к потолку окна.
    expect(popup.style.top).toBe('622px');
    expect(list.style.maxHeight).toBe('200px');
  });

  it('без раскладки (мера 0) остаётся расчёт по строкам', () => {
    const { widget, popup } = setup();
    // Высота попапа 0 — как в jsdom. Три строки дают 3 × 20 + 8 = 68.
    // Якорь у каретки — список растёт ВНИЗ от строки, где набирают (220 + 2).
    widget.show([item('a'), item('b'), item('c')], { left: 100, top: 200, bottom: 220 }, 0);
    expect(popup.style.top).toBe(`${220 + 2}px`);
  });
});

/**
 * Строка «```c» — ограждение блока кода из описания сервера, а не подпись языка.
 * В списке она появлялась ровно на выбранной строке (до `completionItem/resolve`
 * описания нет) и не говорила ничего: человек уже знает, на каком языке файл.
 */
describe('описание в строке списка', () => {
  it('ограждение блока кода не выдаётся за описание', () => {
    expect(docPreview('```c\nint XATTR_SIZE_MAX;\n```')).toBe('int XATTR_SIZE_MAX;');
  });

  it('тильды считаются тем же ограждением', () => {
    expect(docPreview('~~~python\nprint(1)\n~~~')).toBe('print(1)');
  });

  it('первая содержательная строка идёт после пустых', () => {
    expect(docPreview('\n\nМаксимальный размер атрибута')).toBe('Максимальный размер атрибута');
  });

  it('из одних ограждений описание пустое — строка не рисуется', () => {
    expect(docPreview('```c\n```')).toBe('');
    expect(docPreview('')).toBe('');
  });

  it('patch кладёт в строку первую содержательную строку описания', () => {
    const { widget, list } = setup();
    const item = { label: 'XATTR_SIZE_MAX', kind: 'external' as const, detail: 'Auto-import' };
    widget.show([item], { left: 100, top: 200, bottom: 220 }, 0);
    const doc = list.children[0]!.children[0]!.children[2]!;

    // До ответа `completionItem/resolve` описания нет — строки под подписью тоже.
    expect(doc.hidden).toBe(true);

    widget.patch(item, { documentation: '```c\nint XATTR_SIZE_MAX;\n```' });
    expect(doc.textContent).toBe('int XATTR_SIZE_MAX;');
    expect(doc.hidden).toBe(false);
  });

  it('описание из одного ограждения подписи языка не показывает', () => {
    const { widget, list } = setup();
    const item = {
      label: 'XATTR_SIZE_MAX',
      kind: 'external' as const,
      detail: 'Auto-import',
      documentation: '```c\n```',
    };
    widget.show([item], { left: 100, top: 200, bottom: 220 }, 0);
    const doc = list.children[0]!.children[0]!.children[2]!;

    expect(doc.textContent).toBe('');
    expect(doc.hidden).toBe(true);
  });
});
