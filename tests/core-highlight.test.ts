import { beforeEach, describe, expect, it } from 'vitest';
import { diagnoseHighlighting, highlightInto, refreshHighlight } from '../src/renderer/core/highlight';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Подсветка кода вне редактора — блоки кода в чате (`renderer/core/highlight.ts`).
 *
 * Грамматики и токенизатор проверены отдельно (`editor-highlighter`,
 * `editor-highlight-grammars`). Здесь то, что делает именно этот модуль: псевдонимы
 * языков, экранирование разметки, кеш и перекраска при смене темы.
 *
 * Грамматики грузятся динамическим `import()` — поэтому проверки ждут кадр.
 */

// Грамматика грузится динамическим `import()`: первый раз это десятки миллисекунд
// (разбор модуля), дальше — из кеша. Ждём с запасом, иначе тест проверяет не то.
const settled = () => new Promise((resolve) => setTimeout(resolve, 400));

/** Узел блока кода. Мини-DOM не хранит `innerHTML`, поэтому помним его сами. */
function codeNode() {
  const element = document.createElement('div') as unknown as {
    innerHTML: string;
    textContent: string;
  };
  let html = '';
  Object.defineProperty(element, 'innerHTML', {
    get: () => html,
    set: (value: string) => {
      html = value;
    },
  });
  return element;
}

describe('подсветка блоков кода в чате', () => {
  beforeEach(() => {
    installMiniDom();
  });

  it('до загрузки грамматики в узле уже лежит текст блока', () => {
    // Иначе в первом кадре блок кода был бы пустым местом.
    const element = codeNode();

    highlightInto(element as never, 'const a = 1;', 'js');

    expect(element.textContent).toBe('const a = 1;');
  });

  it('после загрузки в узле появляется разметка с цветами', async () => {
    const element = codeNode();

    highlightInto(element as never, 'const a = 1;', 'js');
    await settled();

    expect(element.innerHTML).toContain('<span style=');
    expect(element.innerHTML).toContain('const');
  });

  it('угловые скобки экранированы: разметка блока — правильный HTML', async () => {
    // Разметка собирается строкой, значит текст обязан быть экранирован — иначе
    // HTML из блока кода выполнится в окне чата.
    const element = codeNode();

    highlightInto(element as never, 'const html = "<b>&</b>";', 'js');
    await settled();

    expect(element.innerHTML).toContain('&lt;b&gt;');
    expect(element.innerHTML).toContain('&amp;');
    expect(element.innerHTML).not.toContain('<b>');
  });

  it('псевдонимы языков ведут к настоящей грамматике', async () => {
    // Модель пишет «js», «py», «bash» — подсветка обязана это понимать.
    const cases: [string, string][] = [
      ['js', 'const a = 1;'],
      ['ts', 'const a = 1;'],
      ['py', 'def greet(): pass'],
      ['bash', 'npm run x'],
    ];
    for (const [label, code] of cases) {
      const element = codeNode();

      highlightInto(element as never, code, label);
      await settled();

      expect(element.innerHTML, `язык ${label}`).toContain('<span');
    }
  });

  it('язык без грамматики остаётся простым текстом, а не пустотой', async () => {
    const element = codeNode();

    highlightInto(element as never, 'какой-то текст', 'заумный-язык');
    await settled();

    expect(element.innerHTML).not.toContain('<span');
    expect(element.textContent).toBe('какой-то текст');
  });

  it('повторный блок берётся из кеша и не пересчитывается', async () => {
    // Лента пересобирает блоки на каждом кадре стрима: без кеша разбор шёл бы заново.
    const first = codeNode();
    highlightInto(first as never, 'const a = 1;', 'js');
    await settled();
    const markup = first.innerHTML;

    const second = codeNode();
    highlightInto(second as never, 'const a = 1;', 'js');

    // Из кеша разметка ставится сразу, в том же вызове — без ожидания.
    expect(second.innerHTML).toBe(markup);
  });

  it('язык входит в ключ кеша', async () => {
    // Одинаковый текст в двух языках: если бы ключ был только по коду, второй блок
    // получил бы разметку первого — с чужими ключевыми словами.
    const asJs = codeNode();
    const asPy = codeNode();

    highlightInto(asJs as never, 'def f(): pass', 'js');
    highlightInto(asPy as never, 'def f(): pass', 'python');
    await settled();

    expect(asJs.innerHTML).not.toBe(asPy.innerHTML);
    expect(asPy.innerHTML).toContain('def');
  });

  it('смена темы перекрашивает уже подсвеченное', async () => {
    const element = codeNode();
    highlightInto(element as never, 'const a = 1;', 'js');
    await settled();

    refreshHighlight();
    await settled();

    expect(element.innerHTML).toContain('<span');
  });

  it('самопроверка рассказывает про каждый язык-образец', async () => {
    const element = codeNode();
    highlightInto(element as never, 'const a = 1;', 'js');
    await settled();

    const report = diagnoseHighlighting();

    expect(report).toContain('js → javascript');
    expect(report).toContain('python → python');
    expect(report).toMatch(/токенов \d+, с цветом \d+/);
  });
});
