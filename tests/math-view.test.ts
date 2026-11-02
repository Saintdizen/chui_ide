import { beforeEach, describe, expect, it } from 'vitest';
import { renderDisplayMath, renderInlineMath } from '../src/renderer/ui/math-view';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Рисование формул узлами DOM (`renderer/ui/math-view.ts`).
 *
 * Разбор LaTeX проверен отдельно (`shared/latex`). Здесь то, что делает этот слой:
 * каждый узел превращается в элементы с классами, а раскладку несёт CSS. Поэтому
 * проверяются классы и порядок узлов — по ним и держится вид формулы.
 */

/** Все классы внутри узла — по ним и проверяем вид. */
function classes(element: HTMLElement | null): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    const item = node as { className?: string; children?: unknown[] };
    if (item.className) out.push(...item.className.split(/\s+/).filter(Boolean));
    for (const child of item.children ?? []) walk(child);
  };
  walk(element);
  return out;
}

const text = (element: HTMLElement | null): string => element?.textContent ?? '';

describe('формулы в строке', () => {
  beforeEach(() => {
    installMiniDom();
  });

  it('дробь — числитель, знаменатель и черта отдельными узлами', () => {
    const formula = renderInlineMath('\\frac{a}{b}');

    expect(formula?.className).toBe('md-math');
    expect(classes(formula)).toEqual(expect.arrayContaining(['math-frac', 'math-frac-num', 'math-frac-den']));
    expect(text(formula)).toBe('ab');
  });

  it('корень без показателя и с показателем', () => {
    const plain = renderInlineMath('\\sqrt{x}');
    expect(classes(plain)).toContain('math-sqrt');
    expect(classes(plain)).not.toContain('has-index');
    expect(classes(plain)).toContain('math-sqrt-sign');

    const indexed = renderInlineMath('\\sqrt[3]{x}');
    expect(classes(indexed)).toContain('has-index');
    expect(classes(indexed)).toContain('math-sqrt-index');
  });

  it('степень и индекс встают в одну колонку', () => {
    const formula = renderInlineMath('x^{2}_{i}');

    expect(classes(formula)).toEqual(
      expect.arrayContaining(['math-script', 'math-base', 'math-scripts', 'math-sup', 'math-sub']),
    );
    expect(text(formula)).toBe('x2i');
  });

  it('только степень: на месте индекса остаётся распорка', () => {
    // Без распорки колонка сместилась бы вверх, и формула «поехала» бы.
    const formula = renderInlineMath('x^{2}');

    expect(classes(formula)).toContain('math-sup');
    expect(classes(formula)).toContain('math-scripts-gap');
  });

  it('сумма с пределами помечена как столбик, интеграл — нет', () => {
    // У сумм пределы сверху и снизу, у интегралов — сбоку; это решает CSS по классу.
    expect(classes(renderInlineMath('\\sum_{i}^{n} x'))).toContain('is-stacked');
    expect(classes(renderInlineMath('\\int_{0}^{1} x'))).not.toContain('is-stacked');
  });

  it('числовые множества превращаются в юникод-знаки', () => {
    const formula = renderInlineMath('\\mathbb{R}');

    expect(text(formula)).toBe('ℝ');
    expect(classes(formula)).toContain('is-bb');
  });

  it('неизвестная команда остаётся видимой, а не пропадает', () => {
    // Молча стирать `\foo` — значит отдавать человеку формулу, которая врёт.
    const formula = renderInlineMath('\\foobar');

    expect(text(formula)).toContain('\\foobar');
    expect(classes(formula)).toContain('math-unknown');
  });

  it('пробелы рисуются распорками своего размера', () => {
    expect(classes(renderInlineMath('a\\quad b'))).toContain('math-space');
  });

  it('битая формула не рисуется вовсе', () => {
    // Лучше показать исходный текст, чем половину формулы.
    expect(renderInlineMath('\\frac{a')).toBeNull();
    expect(renderInlineMath('')).toBeNull();
  });
});

describe('формулы блоком и таблицы', () => {
  beforeEach(() => {
    installMiniDom();
  });

  it('блок — отдельный элемент с исходником в подсказке', () => {
    // Исходник в `title` даёт возможность свериться с формулой при наведении.
    const formula = renderDisplayMath('x^2');

    expect(formula?.className).toBe('md-math-block');
    // Мини-DOM не отражает `title` в свойстве — читаем атрибут, как и браузер.
    expect((formula as unknown as { getAttribute(n: string): string }).getAttribute('title')).toBe('$$x^2$$');
  });

  it('матрица без скобок, в круглых и в квадратных', () => {
    const plain = renderDisplayMath('\\begin{matrix} 1 & 2 \\\\ 3 & 4 \\end{matrix}');
    expect(classes(plain)).toContain('math-matrix');
    expect(classes(plain)).not.toContain('is-pmatrix');
    // Две строки по две ячейки.
    const cells = classes(plain).filter((name) => name === 'math-matrix-cell');
    expect(cells).toHaveLength(4);

    const pmatrix = renderDisplayMath('\\begin{pmatrix} 1 \\\\ 2 \\end{pmatrix}');
    expect(classes(pmatrix)).toContain('is-pmatrix');
    expect(text(pmatrix)).toContain('(');
    expect(text(pmatrix)).toContain(')');

    const bmatrix = renderDisplayMath('\\begin{bmatrix} 1 \\\\ 2 \\end{bmatrix}');
    expect(text(bmatrix)).toContain('[');
  });

  it('фигурные скобки: открывающая есть, закрывающей нет', () => {
    // Так устроена запись систем: слева `{`, справа ничего.
    const formula = renderDisplayMath('\\begin{cases} a \\\\ b \\end{cases}');

    expect(text(formula)).toContain('{');
    expect(classes(formula)).toContain('is-cases');
  });

  it('блок из пустой строки не рисуется', () => {
    expect(renderDisplayMath('   ')).toBeNull();
  });
});
