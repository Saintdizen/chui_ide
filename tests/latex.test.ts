import { describe, expect, it } from 'vitest';
import { findMathSpans, parseLatex, type MathNode } from '../src/shared/latex';

/** Разобрать и упасть, если формула не разобралась: так тест читается короче. */
function parse(source: string): MathNode[] {
  const result = parseLatex(source);
  expect(result.error).toBeNull();
  return result.nodes;
}

/** Один узел из формулы. */
function one(source: string): MathNode {
  const nodes = parse(source);
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

describe('parseLatex: простой текст и символы', () => {
  it('соседние знаки склеиваются в один текстовый узел', () => {
    expect(one('abc')).toEqual({ type: 'text', text: 'abc' });
  });

  it('греческие буквы узнаются', () => {
    expect(one('\\alpha')).toEqual({ type: 'symbol', symbol: 'α', kind: 'greek' });
    expect(one('\\Omega')).toEqual({ type: 'symbol', symbol: 'Ω', kind: 'greek' });
  });

  it('отношения, операции и стрелки', () => {
    expect(one('\\leq')).toEqual({ type: 'symbol', symbol: '≤', kind: 'rel' });
    expect(one('\\cdot')).toEqual({ type: 'symbol', symbol: '⋅', kind: 'op' });
    expect(one('\\to')).toEqual({ type: 'symbol', symbol: '→', kind: 'rel' });
  });

  it('пробелы в математике не значат ничего', () => {
    expect(one('  a   b  ')).toEqual({ type: 'text', text: 'ab' });
  });

  it('команда пробела даёт узел пробела', () => {
    expect(one('\\,')).toEqual({ type: 'space', width: 'thin' });
    expect(one('\\quad')).toEqual({ type: 'space', width: 'quad' });
  });
});

describe('parseLatex: степень и индекс', () => {
  it('степень приклеивается к основанию', () => {
    expect(one('x^2')).toEqual({
      type: 'script',
      base: [{ type: 'text', text: 'x' }],
      sub: null,
      sup: [{ type: 'text', text: '2' }],
    });
  });

  it('индекс и степень вместе, в любом порядке записи', () => {
    const sub = [{ type: 'text', text: 'i' }];
    const sup = [{ type: 'text', text: '2' }];
    expect(one('x_i^2')).toEqual({ type: 'script', base: [{ type: 'text', text: 'x' }], sub, sup });
    expect(one('x^2_i')).toEqual({ type: 'script', base: [{ type: 'text', text: 'x' }], sub, sup });
  });

  it('аргумент без скобок — ровно один знак, со скобками — всё выражение', () => {
    // `x^ab` в TeX значит `x^a b`: степень берёт один знак, а `b` остаётся обычным текстом.
    const nodes = parse('x^ab');
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ type: 'script', sup: [{ type: 'text', text: 'a' }] });
    expect(nodes[1]).toEqual({ type: 'text', text: 'b' });
    expect(one('x^{ab}')).toMatchObject({ sup: [{ type: 'text', text: 'ab' }] });
  });
});

describe('parseLatex: дроби и корни', () => {
  it('дробь берёт числитель и знаменатель', () => {
    expect(one('\\frac{a}{b}')).toEqual({
      type: 'frac',
      numerator: [{ type: 'text', text: 'a' }],
      denominator: [{ type: 'text', text: 'b' }],
    });
  });

  it('корень без степени и со степенью', () => {
    expect(one('\\sqrt{x}')).toEqual({ type: 'sqrt', body: [{ type: 'text', text: 'x' }], index: null });
    expect(one('\\sqrt[3]{x}')).toEqual({
      type: 'sqrt',
      body: [{ type: 'text', text: 'x' }],
      index: [{ type: 'text', text: '3' }],
    });
  });

  it('дробь внутри степени не разваливает разбор', () => {
    const node = one('x^{\\frac{1}{2}}');
    expect(node.type).toBe('script');
    expect((node as Extract<MathNode, { type: 'script' }>).sup?.[0]?.type).toBe('frac');
  });
});

describe('parseLatex: начертания', () => {
  it('стиль запоминается, содержимое — снаружи', () => {
    expect(one('\\mathbb{R}')).toEqual({ type: 'styled', style: 'bb', children: [{ type: 'text', text: 'R' }] });
    expect(one('\\mathbf{v}')).toEqual({ type: 'styled', style: 'bold', children: [{ type: 'text', text: 'v' }] });
  });

  it('\\text сохраняет содержимое как есть', () => {
    expect(one('\\text{если x > 0}')).toEqual({
      type: 'styled',
      style: 'text',
      children: [{ type: 'text', text: 'еслиx>0' }],
    });
  });
});

describe('parseLatex: большие операторы', () => {
  it('пределы суммы уходят внутрь оператора', () => {
    const node = one('\\sum_{i=1}^{n}');
    expect(node).toMatchObject({ type: 'bigop', symbol: '∑' });
    expect((node as Extract<MathNode, { type: 'bigop' }>).sub?.[0]).toEqual({ type: 'text', text: 'i=1' });
    expect((node as Extract<MathNode, { type: 'bigop' }>).sup?.[0]).toEqual({ type: 'text', text: 'n' });
  });

  it('интеграл и пределы словами', () => {
    expect(one('\\int')).toMatchObject({ type: 'bigop', symbol: '∫' });
    expect(one('\\lim')).toMatchObject({ type: 'bigop', symbol: 'lim' });
  });
});

describe('parseLatex: таблицы', () => {
  it('матрица раскладывается по ячейкам', () => {
    const node = one('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}');
    expect(node.type).toBe('matrix');
    const matrix = node as Extract<MathNode, { type: 'matrix' }>;
    expect(matrix.kind).toBe('pmatrix');
    expect(matrix.rows).toHaveLength(2);
    expect(matrix.rows[0]!.map((cell) => cell[0])).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
  });
});

describe('parseLatex: скобки и ошибки', () => {
  it('\\left и \\right дают знаки скобок', () => {
    const nodes = parse('\\left(\\frac{a}{b}\\right)');
    expect(nodes[0]).toEqual({ type: 'symbol', symbol: '(', kind: 'delim' });
    expect(nodes.at(-1)).toEqual({ type: 'symbol', symbol: ')', kind: 'delim' });
  });

  it('\\left. — пустая скобка, знака нет', () => {
    expect(parse('\\left.')).toEqual([]);
  });

  it('незакрытая скобка — ошибка', () => {
    expect(parseLatex('\\frac{a}{b').error).toBeTruthy();
    expect(parseLatex('{a').error).toBeTruthy();
  });

  it('степень без основания — ошибка', () => {
    expect(parseLatex('^2').error).toBeTruthy();
  });

  it('неизвестная команда остаётся видимой, а не пропадает', () => {
    expect(one('\\foobar')).toEqual({ type: 'unknown', command: 'foobar' });
  });

  it('экранированные знаки читаются буквально', () => {
    expect(one('\\%')).toEqual({ type: 'text', text: '%' });
  });

  it('пустая формула — пустой результат без ошибки', () => {
    expect(parseLatex('')).toEqual({ nodes: [], error: null });
  });
});

describe('findMathSpans: где в тексте формулы', () => {
  it('находит формулу в строке', () => {
    const spans = findMathSpans('до $x^2$ после');
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ display: false, source: 'x^2' });
  });

  it('находит формулу блоком', () => {
    const spans = findMathSpans('текст\n$$\n\\frac{a}{b}\n$$\n');
    expect(spans[0]!.display).toBe(true);
    expect(spans[0]!.source).toContain('\\frac{a}{b}');
  });

  it('цена не считается формулой: у неё нет закрывающего доллара', () => {
    expect(findMathSpans('стоит $5 рублей')).toEqual([]);
  });

  it('пробел перед закрывающим долларом выдаёт обычный текст', () => {
    expect(findMathSpans('$5 и $10')).toEqual([]);
  });

  it('формула не начинается с пробела', () => {
    expect(findMathSpans('$ x$')).toEqual([]);
  });

  it('несколько формул в строке', () => {
    const spans = findMathSpans('$a$ и $b$');
    expect(spans.map((span) => span.source)).toEqual(['a', 'b']);
  });
});
