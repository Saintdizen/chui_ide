import { beforeEach, describe, expect, it } from 'vitest';
import { FindWidget } from '../src/renderer/editor/widgets/find-widget';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Панель поиска и замены (`editor/widgets/find-widget.ts`).
 *
 * Поиск считается в `find/find-state.ts`, правки строит `find/replace.ts` — оба
 * проверены отдельно. Здесь вид: что человек видит в поле и счётчике, куда ведут
 * Enter, Escape и кнопки, и что замена идёт правкой контроллера (то есть отменяется).
 */

const TEXT = 'one two\none three\nfour';
/** Пауза больше задержки пересчёта: поиск идёт не на каждый символ. */
const typed = () => new Promise((resolve) => setTimeout(resolve, 250));

function setup(text = TEXT) {
  let state = {
    text,
    lineCount: text.split('\n').length,
    lineText: (line: number) => state.text.split('\n')[line - 1] ?? '',
    lineStart: (line: number) => {
      const lines = state.text.split('\n');
      let start = 0;
      for (let index = 0; index < line - 1; index += 1) start += (lines[index] ?? '').length + 1;
      return start;
    },
  };
  const applied: { start: number; removed: string; inserted: string }[] = [];
  const selected: number[] = [];

  const controller = {
    caret: 0,
    selectedText: () => '',
    selectRange(start: number) {
      selected.push(start);
    },
    applyEdit(edit: { start: number; removed: string; inserted: string }) {
      applied.push(edit);
      // Применяем как контроллер: иначе следующий поиск считался бы по старому тексту
      // и тест не отличил бы «заменил» от «показал, что заменил».
      const next = state.text.slice(0, edit.start) + edit.inserted + state.text.slice(edit.start + edit.removed.length);
      state = { ...state, text: next, lineCount: next.split('\n').length };
    },
  };
  const view = {
    element: document.createElement('div'),
    revealOffset() {},
    clearSearchHighlights() {},
    setSearchHighlights() {},
  };

  const widget = new FindWidget(view as never, controller as never, state as never);
  const root = (view.element as unknown as { querySelector(s: string): any }).querySelector('.own-editor-find');
  return { widget, view, controller, root, applied, selected, bufferText: () => state.text };
}

/** Поле ввода панели: ищем по `aria-label`, чтобы не зависеть от порядка узлов. */
function field(root: any, label: string): any {
  const fields = root.querySelectorAll('input') as unknown as {
    getAttribute(name: string): string | null;
  }[];
  return fields.find((input) => input.getAttribute('aria-label') === label);
}

function press(node: any, key: string, shiftKey = false): void {
  for (const handler of node.handlers.keydown ?? []) {
    handler({ key, shiftKey, ctrlKey: false, metaKey: false, preventDefault() {} });
  }
}

function click(root: any, title: string): void {
  const buttons = root.querySelectorAll('button') as unknown as { title: string; click(): void }[];
  buttons.find((button) => button.title === title)?.click();
}

describe('панель поиска', () => {
  beforeEach(() => {
    installMiniDom();
  });

  it('создаётся скрытой, показывается по команде и прячется по Escape', () => {
    const { widget, root } = setup();
    expect(root.hidden).toBe(true);

    widget.show('find');
    expect(root.hidden).toBe(false);

    press(field(root, 'Найти'), 'Escape');
    expect(root.hidden).toBe(true);
  });

  it('в режиме замены видно поле замены, в поиске — нет', () => {
    const { widget, root } = setup();
    widget.show('find');
    expect(root.classList.contains('is-replace')).toBe(false);

    widget.show('replace');
    expect(root.classList.contains('is-replace')).toBe(true);
  });

  it('после ввода показывает, который из скольких совпадений', async () => {
    const { widget, root } = setup();
    widget.show('find');

    const input = field(root, 'Найти');
    input.value = 'one';
    input.dispatchEvent({ type: 'input' });
    await typed();

    expect(root.querySelector('.own-editor-find-counter')?.textContent).toBe('1 из 2');
  });

  it('совпадений нет — так и пишет, а не пустой счётчик', async () => {
    const { widget, root } = setup();
    widget.show('find');

    const input = field(root, 'Найти');
    input.value = 'такого нет';
    input.dispatchEvent({ type: 'input' });
    await typed();

    expect(root.querySelector('.own-editor-find-counter')?.textContent).toContain('нет');
  });

  it('Enter идёт вперёд, Shift+Enter — назад', async () => {
    const { widget, root, selected } = setup();
    widget.show('find');
    const input = field(root, 'Найти');
    input.value = 'one';
    input.dispatchEvent({ type: 'input' });
    await typed();
    selected.length = 0;

    press(input, 'Enter');
    press(input, 'Enter', true);

    // Шаг — это выделение в редакторе: панель не правит текст, а водит каретку.
    expect(selected).toHaveLength(2);
  });

  it('переключатель регистра меняет число совпадений', async () => {
    const { widget, root } = setup('One one ONE');
    widget.show('find');
    const input = field(root, 'Найти');
    input.value = 'one';
    input.dispatchEvent({ type: 'input' });
    await typed();
    expect(root.querySelector('.own-editor-find-counter')?.textContent).toBe('1 из 3');

    click(root, 'Учитывать регистр');
    await typed();

    expect(root.querySelector('.own-editor-find-counter')?.textContent).toBe('1 из 1');
  });

  it('состояние переключателя читается с экрана', () => {
    const { widget, root } = setup();
    widget.show('find');

    const toggles = root.querySelectorAll('.is-toggle') as unknown as {
      title: string;
      getAttribute(name: string): string | null;
      click(): void;
    }[];
    expect(toggles).toHaveLength(3);
    const word = toggles.find((node) => node.title === 'Слово целиком');
    expect(word?.getAttribute('aria-pressed')).toBe('false');

    word?.click();

    // Скринридер узнаёт о нажатии только по этому атрибуту — его и держим в правде.
    expect(word?.getAttribute('aria-pressed')).toBe('true');
  });

  it('замена идёт правкой контроллера — значит отменяется Ctrl+Z', async () => {
    const { widget, root, applied } = setup();
    widget.show('replace');
    const input = field(root, 'Найти');
    input.value = 'one';
    input.dispatchEvent({ type: 'input' });
    await typed();
    field(root, 'Заменить').value = 'ONE';

    click(root, 'Заменить текущее совпадение');

    expect(applied).toHaveLength(1);
    expect(applied[0]?.inserted).toBe('ONE');
  });

  it('замена всего меняет все совпадения и говорит, сколько', async () => {
    const { widget, root, bufferText } = setup();
    widget.show('replace');
    const input = field(root, 'Найти');
    input.value = 'one';
    input.dispatchEvent({ type: 'input' });
    await typed();
    field(root, 'Заменить').value = 'ONE';

    click(root, 'Заменить все совпадения');

    expect(bufferText()).toBe('ONE two\nONE three\nfour');
    expect(root.querySelector('.own-editor-find-message')?.textContent).toContain('2');
  });

  it('поиск с регулярным выражением понимает шаблон', async () => {
    const { widget, root } = setup();
    widget.show('find');
    click(root, 'Регулярное выражение');
    const input = field(root, 'Найти');
    input.value = 'o.e';
    input.dispatchEvent({ type: 'input' });
    await typed();

    // `o.e` ловит «one» в двух строках — и не трогает «four».
    expect(root.querySelector('.own-editor-find-counter')?.textContent).toBe('1 из 2');
  });
});
