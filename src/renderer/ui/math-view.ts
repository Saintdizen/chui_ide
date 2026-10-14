import type { MathNode } from '../../shared/latex';
import { parseLatex } from '../../shared/latex';
import { h } from './dom';

/**
 * Рисование формулы узлами DOM.
 *
 * Тонкий слой: строение берётся у `shared/latex.ts`, а здесь каждый узел превращается
 * в элементы с классами (`math-frac`, `math-sqrt`, `math-script`, …). Раскладку несёт
 * CSS: дробь — столбик с чертой, корень — знак с полоской сверху, степень с индексом —
 * сдвинутая вбок колонка. Так формула остаётся ТЕКСТОМ страницы: её видно, можно
 * выделить и скопировать, и она не мешает ни теме, ни масштабу.
 */

/** Двойные буквы (числовые множества) — юникод-формой, где она есть. */
const BLACKBOARD: Record<string, string> = {
  C: 'ℂ',
  H: 'ℍ',
  N: 'ℕ',
  P: 'ℙ',
  Q: 'ℚ',
  R: 'ℝ',
  Z: 'ℤ',
};

/** Формула в строке: `\frac{a}{b}` читается как дробь. `null` — разобрать не удалось. */
export function renderInlineMath(source: string): HTMLElement | null {
  const result = parseLatex(source);
  if (result.error || result.nodes.length === 0) return null;
  const element = h('span', { class: 'md-math' });
  appendNodes(element, result.nodes);
  return element;
}

/** Формула отдельным блоком — по центру, как её печатают в записях. */
export function renderDisplayMath(source: string): HTMLElement | null {
  const result = parseLatex(source);
  if (result.error || result.nodes.length === 0) return null;
  const element = h('div', { class: 'md-math-block', title: `$$${source.trim()}$$` });
  appendNodes(element, result.nodes);
  return element;
}

/** Нарисовать узлы в контейнер. */
export function appendNodes(container: HTMLElement, nodes: readonly MathNode[]): void {
  for (const node of nodes) container.appendChild(nodeElement(node));
}

function nodeElement(node: MathNode): HTMLElement {
  switch (node.type) {
    case 'text':
      return h('span', { class: 'math-text' }, node.text);
    case 'symbol':
      return h('span', { class: `math-sym is-${node.kind}` }, node.symbol);
    case 'group': {
      const span = h('span', { class: 'math-group' });
      appendNodes(span, node.children);
      return span;
    }
    case 'frac': {
      const numerator = h('span', { class: 'math-frac-num' });
      appendNodes(numerator, node.numerator);
      const denominator = h('span', { class: 'math-frac-den' });
      appendNodes(denominator, node.denominator);
      return h('span', { class: 'math-frac' }, numerator, denominator);
    }
    case 'sqrt': {
      const body = h('span', { class: 'math-sqrt-body' });
      appendNodes(body, node.body);
      const sign = h('span', { class: 'math-sqrt-sign' }, '√');
      const index = node.index ? h('span', { class: 'math-sqrt-index' }) : null;
      if (index && node.index) appendNodes(index, node.index);
      return index
        ? h('span', { class: 'math-sqrt has-index' }, index, sign, body)
        : h('span', { class: 'math-sqrt' }, sign, body);
    }
    case 'script': {
      const base = h('span', { class: 'math-base' });
      appendNodes(base, node.base);
      const scripts = h('span', { class: 'math-scripts' });
      // Верхняя часть колонки — степень; при её отсутствии первым идёт индекс.
      scripts.appendChild(node.sup ? supElement(node.sup) : h('span', { class: 'math-scripts-gap' }));
      scripts.appendChild(node.sub ? subElement(node.sub) : h('span', { class: 'math-scripts-gap' }));
      return h('span', { class: 'math-script' }, base, scripts);
    }
    case 'bigop': {
      const sup = node.sup ? h('span', { class: 'math-bigop-lim' }) : null;
      if (sup) appendNodes(sup, node.sup ?? []);
      const sub = node.sub ? h('span', { class: 'math-bigop-lim' }) : null;
      if (sub) appendNodes(sub, node.sub ?? []);
      // Пределы у интегралов стоят сбоку, у сумм — сверху и снизу: это и решает CSS.
      return h(
        'span',
        { class: `math-bigop${node.symbol.length === 1 && /[∑∏∐⋃⋂⨁⨂⋁⋀]/.test(node.symbol) ? ' is-stacked' : ''}` },
        sup ?? h('span', { class: 'math-bigop-gap' }),
        h('span', { class: 'math-bigop-sym' }, node.symbol),
        sub ?? h('span', { class: 'math-bigop-gap' }),
      );
    }
    case 'styled': {
      const span = h('span', { class: `math-styled is-${node.style}` });
      if (node.style === 'bb') {
        // Числовые множества: у известных букв есть юникод-форма, остальные — как есть.
        const text = plainText(node.children).replace(/[CHNPQRZ]/g, (letter) => BLACKBOARD[letter] ?? letter);
        span.textContent = text;
        return span;
      }
      appendNodes(span, node.children);
      return span;
    }
    case 'space':
      return h('span', { class: `math-space is-${node.width}` });
    case 'matrix':
      return matrixElement(node);
    case 'unknown':
      // Неизвестную команду показываем как есть: лучше видимый `\foo`, чем пропажа.
      return h('span', { class: 'math-unknown' }, `\\${node.command}`);
  }
}

function supElement(nodes: readonly MathNode[]): HTMLElement {
  const span = h('span', { class: 'math-sup' });
  appendNodes(span, nodes);
  return span;
}

function subElement(nodes: readonly MathNode[]): HTMLElement {
  const span = h('span', { class: 'math-sub' });
  appendNodes(span, nodes);
  return span;
}

/** Текст узлов без разметки — для начертаний, которые меняют сами знаки. */
function plainText(nodes: readonly MathNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') out += node.text;
    else if (node.type === 'symbol') out += node.symbol;
    else if (node.type === 'group' || node.type === 'styled') out += plainText(node.children);
    else if (node.type === 'unknown') out += `\\${node.command}`;
  }
  return out;
}

/** Таблица: строки и ячейки, у pmatrix и bmatrix — ещё и скобки по краям. */
function matrixElement(node: Extract<MathNode, { type: 'matrix' }>): HTMLElement {
  const table = h('span', { class: 'math-matrix-table' });
  for (const row of node.rows) {
    const rowElement = h('span', { class: 'math-matrix-row' });
    for (const cell of row) {
      const cellElement = h('span', { class: 'math-matrix-cell' });
      appendNodes(cellElement, cell);
      rowElement.appendChild(cellElement);
    }
    table.appendChild(rowElement);
  }
  const kind = node.kind;
  if (kind === 'matrix') return h('span', { class: 'math-matrix' }, table);
  const open = kind === 'pmatrix' ? '(' : kind === 'bmatrix' ? '[' : '{';
  const close = kind === 'pmatrix' ? ')' : kind === 'bmatrix' ? ']' : '';
  return h(
    'span',
    { class: `math-matrix is-${kind}` },
    h('span', { class: 'math-matrix-delim' }, open),
    table,
    close ? h('span', { class: 'math-matrix-delim' }, close) : null,
  );
}
