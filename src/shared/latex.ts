/**
 * ЛаTeX для предпросмотра: разбор ПОДМНОЖЕСТВА математики в дерево узлов.
 *
 * Формулу в заметках пишут между `$…$` (в строке) и `$$…$$` (отдельным блоком), а в
 * блоках кода — языком `latex`. Рисовать её внешней библиотекой (KaTeX, MathJax) — это
 * сотни килобайт и своя сборка; здесь разбирается ровно тот набор, что встречается в
 * записях и документации: дроби, корни, степени и индексы, большие операторы с
 * пределами, матрицы, начертания, греческие буквы и обычные знаки.
 *
 * Чего нет — то НЕ выбрасывается: неизвестная команда остаётся в формуле видимым
 * текстом (`\foo`), а незакрытые скобки ловятся разбором с ошибкой — вызывающий тогда
 * показывает исходник как код. Скрытая потеря текста формулы хуже, чем её отсутствие:
 * по недорисованной формуле невозможно понять, что было написано.
 *
 * Модуль чистый: ни DOM, ни диска. Дерево проверяется юнит-тестами, а рисование —
 * отдельный тонкий слой (`ui/math-view.ts`).
 */

/** Начертание: соответствуют командам `\mathbb{…}`, `\mathcal{…}` и подобным. */
export type MathStyle = 'bb' | 'cal' | 'bold' | 'roman' | 'italic' | 'text';

/** Узел формулы. `text` — обычный текст, остальное — строение. */
export type MathNode =
  | { type: 'text'; text: string }
  | { type: 'symbol'; symbol: string; kind: 'greek' | 'rel' | 'op' | 'delim' }
  | { type: 'group'; children: MathNode[] }
  | { type: 'frac'; numerator: MathNode[]; denominator: MathNode[] }
  | { type: 'sqrt'; body: MathNode[]; index: MathNode[] | null }
  | { type: 'script'; base: MathNode[]; sub: MathNode[] | null; sup: MathNode[] | null }
  | { type: 'bigop'; symbol: string; sub: MathNode[] | null; sup: MathNode[] | null }
  | { type: 'styled'; style: MathStyle; children: MathNode[] }
  | { type: 'space'; width: 'thin' | 'thick' | 'quad' }
  | { type: 'matrix'; kind: 'matrix' | 'pmatrix' | 'bmatrix' | 'cases'; rows: MathNode[][][] }
  | { type: 'unknown'; command: string };

export interface LatexResult {
  nodes: MathNode[];
  /** Что не так с формулой; `null` — разобралась. */
  error: string | null;
}

/** Греческие буквы: строчные и заглавные, где форма отличается от латинской. */
const GREEK: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ϵ',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'ϑ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  varpi: 'ϖ',
  rho: 'ρ',
  sigma: 'σ',
  varsigma: 'ς',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  varphi: 'ϕ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
};

/** Отношения: знаки сравнения и принадлежности. */
const RELATIONS: Record<string, string> = {
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  approx: '≈',
  equiv: '≡',
  sim: '∼',
  simeq: '≃',
  propto: '∝',
  in: '∈',
  notin: '∉',
  ni: '∋',
  subset: '⊂',
  subseteq: '⊆',
  supset: '⊃',
  supseteq: '⊇',
  cup: '∪',
  cap: '∩',
  mid: '∣',
  perp: '⊥',
  parallel: '∥',
};

/** Операции и прочие знаки. */
const OPERATORS: Record<string, string> = {
  pm: '±',
  mp: '∓',
  times: '×',
  div: '÷',
  cdot: '⋅',
  ast: '∗',
  star: '⋆',
  circ: '∘',
  bullet: '∙',
  oplus: '⊕',
  otimes: '⊗',
  wedge: '∧',
  land: '∧',
  vee: '∨',
  lor: '∨',
  neg: '¬',
  lnot: '¬',
  forall: '∀',
  exists: '∃',
  infty: '∞',
  partial: '∂',
  nabla: '∇',
  ell: 'ℓ',
  hbar: 'ℏ',
  Re: 'ℜ',
  Im: 'ℑ',
  aleph: 'ℵ',
  angle: '∠',
  triangle: '△',
  square: '□',
  prime: '′',
  cdots: '⋯',
  ldots: '…',
  dots: '…',
  vdots: '⋮',
  ddots: '⋱',
  degree: '°',
  checkmark: '✓',
};

/** Стрелки. */
const ARROWS: Record<string, string> = {
  to: '→',
  rightarrow: '→',
  gets: '←',
  leftarrow: '←',
  leftrightarrow: '↔',
  Rightarrow: '⇒',
  Leftarrow: '⇐',
  Leftrightarrow: '⇔',
  mapsto: '↦',
  longrightarrow: '⟶',
  longleftarrow: '⟵',
  hookrightarrow: '↪',
  uparrow: '↑',
  downarrow: '↓',
};

/** Большие операторы: у них пределы стоят сверху и снизу, а не сбоку. */
const BIG_OPS: Record<string, string> = {
  sum: '∑',
  prod: '∏',
  coprod: '∐',
  bigcup: '⋃',
  bigcap: '⋂',
  bigoplus: '⨁',
  bigotimes: '⨂',
  bigvee: '⋁',
  bigwedge: '⋀',
  int: '∫',
  iint: '∬',
  iiint: '∭',
  oint: '∮',
};

/** Начертания: команда → её стиль. */
const STYLES: Record<string, MathStyle> = {
  mathbb: 'bb',
  mathcal: 'cal',
  mathbf: 'bold',
  bf: 'bold',
  mathrm: 'roman',
  textrm: 'roman',
  mathit: 'italic',
  textit: 'italic',
  operatorname: 'roman',
  text: 'text',
  mathrmtext: 'text',
};

/** Пробелы: у LaTeX нет значащих пробелов, поэтому их задают командами. */
const SPACES: Record<string, 'thin' | 'thick' | 'quad'> = {
  ',': 'thin',
  ':': 'thin',
  ';': 'thick',
  '!': 'thin',
  quad: 'quad',
  qquad: 'quad',
};

/** Скобки, которые можно ставить после `\left`/`\right`. */
const DELIMITERS: Record<string, string> = {
  '(': '(',
  ')': ')',
  '[': '[',
  ']': ']',
  '|': '|',
  '.': '',
  '{': '{',
  '}': '}',
  langle: '⟨',
  rangle: '⟩',
  lfloor: '⌊',
  rfloor: '⌋',
  lceil: '⌈',
  rceil: '⌉',
  lvert: '|',
  rvert: '|',
  vert: '|',
  Vert: '‖',
};

/** Имена окружений, которые рисуем таблицей: они различаются только скобками. */
const MATRIX_KINDS: Record<string, 'matrix' | 'pmatrix' | 'bmatrix' | 'cases'> = {
  matrix: 'matrix',
  pmatrix: 'pmatrix',
  bmatrix: 'bmatrix',
  cases: 'cases',
};

type Token =
  | { kind: 'cmd'; value: string }
  | { kind: 'char'; value: string }
  | { kind: 'lbrace' }
  | { kind: 'rbrace' }
  | { kind: 'sup' }
  | { kind: 'sub' }
  | { kind: 'amp' };

/** Разложить источник на команды и знаки. Пробелы в математике не значат ничего. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '\\') {
      const next = source[i + 1];
      if (next === undefined) {
        tokens.push({ kind: 'cmd', value: '' });
        i += 1;
        continue;
      }
      if (/[a-zA-Z]/.test(next)) {
        let j = i + 1;
        while (j < source.length && /[a-zA-Z]/.test(source[j]!)) j += 1;
        tokens.push({ kind: 'cmd', value: source.slice(i + 1, j) });
        i = j;
        continue;
      }
      // `\\` — перевод строки в таблице, `\{` — скобка, `\,` — пробел.
      tokens.push({ kind: 'cmd', value: next });
      i += 2;
      continue;
    }
    if (ch === '{') tokens.push({ kind: 'lbrace' });
    else if (ch === '}') tokens.push({ kind: 'rbrace' });
    else if (ch === '^') tokens.push({ kind: 'sup' });
    else if (ch === '_') tokens.push({ kind: 'sub' });
    else if (ch === '&') tokens.push({ kind: 'amp' });
    else tokens.push({ kind: 'char', value: ch });
    i += 1;
  }
  return tokens;
}

class Parser {
  private tokens: Token[];
  private position = 0;
  private error: string | null = null;
  /** Знаки, на которых останавливается чтение: `]` внутри необязательного аргумента. */
  private stops: ReadonlySet<string> = new Set();

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  /** Разобрать всю формулу. Незакрытая скобка — ошибка: формулу не рисуем. */
  parse(): LatexResult {
    const nodes = this.sequence(false);
    if (this.position < this.tokens.length) {
      const token = this.tokens[this.position]!;
      if (token.kind === 'rbrace') this.error = 'Лишняя закрывающая скобка.';
      else if (token.kind === 'sup' || token.kind === 'sub') this.error = 'Степень или индекс без основания.';
      else if (token.kind === 'amp') this.error = 'Знак выравнивания вне таблицы.';
    }
    return { nodes, error: this.error };
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private next(): Token | undefined {
    const token = this.tokens[this.position];
    this.position += 1;
    return token;
  }

  /** Последовательность узлов до конца формулы или до закрывающей скобки. */
  private sequence(stopAtBrace: boolean): MathNode[] {
    const nodes: MathNode[] = [];
    while (this.position < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'rbrace') {
        if (stopAtBrace) break;
        this.error = 'Лишняя закрывающая скобка.';
        this.position += 1;
        continue;
      }
      if (token.kind === 'amp') break;
      // Знак-ограничитель (например `]`) принадлежит вызывающему, а не формуле.
      if (token.kind === 'char' && this.stops.has(token.value)) break;
      const node = this.atomWithScripts();
      if (node) nodes.push(node);
      else break;
    }
    return nodes;
  }

  /** Атом вместе со степенью и индексом: они пишутся сразу за ним. */
  private atomWithScripts(): MathNode | null {
    const atom = this.atom();
    if (atom === null) return null;

    let sup: MathNode[] | null = null;
    let sub: MathNode[] | null = null;
    for (;;) {
      const token = this.peek();
      if (token?.kind === 'sup' && sup === null) {
        this.position += 1;
        sup = this.requiredGroup('степень');
      } else if (token?.kind === 'sub' && sub === null) {
        this.position += 1;
        sub = this.requiredGroup('индекс');
      } else {
        break;
      }
    }

    if (sup === null && sub === null) return atom;
    // Пределы больших операторов пишутся под знаком, а не сбоку.
    if (atom.type === 'bigop') return { ...atom, sub, sup };
    return { type: 'script', base: [atom], sub, sup };
  }

  /** Один атом: знак, группа, команда. */
  private atom(): MathNode | null {
    const token = this.next();
    if (token === undefined) return null;

    if (token.kind === 'lbrace') {
      const children = this.sequence(true);
      if (this.peek()?.kind === 'rbrace') this.position += 1;
      else this.error ??= 'Не закрыта фигурная скобка.';
      return { type: 'group', children };
    }
    if (token.kind === 'cmd') return this.command(token.value);
    if (token.kind === 'char') {
      // Соседние знаки склеиваем в один текстовый узел: «abc», а не три.
      // Останавливаемся на ограничителе: иначе `]` попал бы в текст.
      let text = token.value;
      while (this.peek()?.kind === 'char') {
        const next = this.peek() as { value: string };
        if (this.stops.has(next.value)) break;
        text += next.value;
        this.position += 1;
      }
      return { type: 'text', text };
    }
    // `^`, `_`, `}` или `&` там, где ожидался атом: сообщаем и пропускаем.
    if (token.kind === 'sup' || token.kind === 'sub') this.error ??= 'Степень или индекс без основания.';
    else if (token.kind === 'rbrace') this.error ??= 'Лишняя закрывающая скобка.';
    else this.error ??= 'Знак выравнивания вне таблицы.';
    return null;
  }

  /** Обязательный аргумент в скобках (у степени, индекса, дроби). */
  private requiredGroup(what: string): MathNode[] {
    const token = this.peek();
    if (token?.kind === 'lbrace') {
      this.position += 1;
      const children = this.sequence(true);
      if (this.peek()?.kind === 'rbrace') this.position += 1;
      else this.error ??= 'Не закрыта фигурная скобка.';
      return children;
    }
    // Без скобок аргументом считается один атом: `x^2` значит то же, что `x^{2}`.
    const single = this.singleNode();
    if (single === null) {
      this.error ??= `Не хватает аргумента: ${what}.`;
      return [];
    }
    return [single];
  }

  /** Один узел без степени и индекса — аргумент без скобок. */
  private singleNode(): MathNode | null {
    const saved = this.position;
    const node = this.atomOne();
    if (node === null) this.position = saved;
    return node;
  }

  /**
   * Один ЗНАК без скобок. В TeX `x^ab` значит `x^a b`: аргумент без скобок — ровно
   * один знак, а не строка до конца, поэтому склеивать соседние знаки тут нельзя.
   */
  private atomOne(): MathNode | null {
    const token = this.peek();
    if (token?.kind === 'char') {
      this.position += 1;
      return { type: 'text', text: token.value };
    }
    return this.atom();
  }

  /** Команда: символ, дробь, корень, начертание, окружение или неизвестное. */
  private command(name: string): MathNode | null {
    if (name === '') return null;
    if (name === '\\') return null; // перевод строки: значим только внутри таблицы

    const space = SPACES[name];
    if (space) return { type: 'space', width: space };

    if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
      const numerator = this.takeBrace('числитель');
      const denominator = this.takeBrace('знаменатель');
      return { type: 'frac', numerator, denominator };
    }
    if (name === 'sqrt') {
      const index = this.takeOptionalBracket();
      const body = this.takeBrace('подкоренное выражение');
      return { type: 'sqrt', body, index };
    }
    const style = STYLES[name];
    if (style) return { type: 'styled', style, children: this.takeBrace(`${name}`) };

    if (name === 'begin') return this.environment();
    if (name === 'end') {
      this.error ??= 'Закрытие окружения без открытия.';
      this.takeBrace('имя окружения');
      return null;
    }
    if (name === 'left' || name === 'right') {
      const delimiter = this.readDelimiter();
      if (delimiter === '') return null; // `\left.` — «пустая» скобка
      return { type: 'symbol', symbol: delimiter, kind: 'delim' };
    }

    const bigop = BIG_OPS[name];
    if (bigop) return { type: 'bigop', symbol: bigop, sub: null, sup: null };
    // Пределы словами (`\lim`, `\max`) — тоже с подписью снизу.
    if (['lim', 'limsup', 'liminf', 'max', 'min', 'sup', 'inf', 'det', 'gcd'].includes(name)) {
      return { type: 'bigop', symbol: name, sub: null, sup: null };
    }

    const greek = GREEK[name];
    if (greek) return { type: 'symbol', symbol: greek, kind: 'greek' };
    const relation = RELATIONS[name];
    if (relation) return { type: 'symbol', symbol: relation, kind: 'rel' };
    const operator = OPERATORS[name];
    if (operator) return { type: 'symbol', symbol: operator, kind: 'op' };
    const arrow = ARROWS[name];
    if (arrow) return { type: 'symbol', symbol: arrow, kind: 'rel' };

    const delimiter = DELIMITERS[name];
    if (delimiter !== undefined) return { type: 'symbol', symbol: delimiter, kind: 'delim' };

    // Экранированные знаки: `\{`, `\}`, `\%`, `\&`.
    if (name.length === 1 && !/[a-zA-Z]/.test(name)) return { type: 'text', text: name };

    return { type: 'unknown', command: name };
  }

  /** Аргумент в фигурных скобках; без них — пусто с отметкой об ошибке. */
  private takeBrace(what: string): MathNode[] {
    if (this.peek()?.kind !== 'lbrace') {
      const single = this.singleNode();
      if (single !== null) return [single];
      this.error ??= `Не хватает аргумента: ${what}.`;
      return [];
    }
    this.position += 1;
    const children = this.sequence(true);
    if (this.peek()?.kind === 'rbrace') this.position += 1;
    else this.error ??= 'Не закрыта фигурная скобка.';
    return children;
  }

  /** Необязательный аргумент в квадратных скобках: `\sqrt[3]{x}`. */
  private takeOptionalBracket(): MathNode[] | null {
    const open = this.peek();
    if (open?.kind !== 'char' || open.value !== '[') return null;
    this.position += 1;
    const previous = this.stops;
    this.stops = new Set([']']);
    const children = this.sequence(false);
    this.stops = previous;
    if (this.peek()?.kind === 'char') this.position += 1; // закрывающая `]`
    return children;
  }

  /** Знак после `\left` или `\right`. */
  private readDelimiter(): string {
    const token = this.next();
    if (token === undefined) {
      this.error ??= 'После \\left или \\right нет скобки.';
      return '';
    }
    if (token.kind === 'char') return DELIMITERS[token.value] ?? token.value;
    if (token.kind === 'cmd') return DELIMITERS[token.value] ?? '';
    if (token.kind === 'lbrace') return '{';
    if (token.kind === 'rbrace') return '}';
    return '';
  }

  /** Окружение-таблица: `\begin{pmatrix} a & b \\ c & d \end{pmatrix}`. */
  private environment(): MathNode | null {
    const nameNodes = this.takeBrace('имя окружения');
    const name = rawText(nameNodes);
    const kind = MATRIX_KINDS[name];
    if (!kind) {
      this.error ??= `Окружение «${name}» не поддерживается.`;
      return null;
    }
    // Ячейки разделяем `&`, строки — `\\`; закрывает `\end{…}`.
    const rows: MathNode[][][] = [];
    let row: MathNode[][] = [];
    let cell: MathNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) {
        this.error ??= 'Не закрыто окружение таблицы.';
        break;
      }
      if (token.kind === 'rbrace') {
        // Встретили `}` вместо ячейки: это уже вне таблицы — выходим.
        this.error ??= 'Не закрыто окружение таблицы.';
        break;
      }
      if (token.kind === 'amp') {
        this.position += 1;
        row.push(cell);
        cell = [];
        continue;
      }
      if (token.kind === 'cmd' && token.value === '\\') {
        this.position += 1;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = [];
        continue;
      }
      if (token.kind === 'cmd' && token.value === 'end') {
        this.position += 1;
        this.takeBrace('имя окружения');
        row.push(cell);
        rows.push(row);
        break;
      }
      const node = this.atomWithScripts();
      if (node === null) break;
      cell.push(node);
    }
    return { type: 'matrix', kind, rows };
  }
}

/** Текст узлов как он записан — для имени окружения и `\text{…}`. */
function rawText(nodes: readonly MathNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') out += node.text;
    else if (node.type === 'unknown') out += `\\${node.command}`;
    else if (node.type === 'group') out += rawText(node.children);
    else if (node.type === 'styled') out += rawText(node.children);
  }
  return out;
}

/** Разобрать формулу. Ошибка разбора — формулу не рисуем, показываем исходник. */
export function parseLatex(source: string): LatexResult {
  return new Parser(source.trim()).parse();
}

/**
 * Найти формулы в тексте markdown: `$$…$$` — отдельным блоком, `$…$` — в строке.
 *
 * Доллар в цене (`$5`) формулой не считается: у него нет закрывающего доллара, а
 * пробел перед ним или после него выдаёт обычный текст. Возвращаем куски по порядку —
 * вызывающий рисует их тем же разборщиком.
 */
export interface MathSpan {
  start: number;
  end: number;
  display: boolean;
  source: string;
}

export function findMathSpans(text: string): MathSpan[] {
  const spans: MathSpan[] = [];
  const pattern = /\$\$([\s\S]+?)\$\$|(?<![\w$])\$(?!\s)([^$\n]+?)(?<!\s)\$/g;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const display = match[1] !== undefined;
    const source = display ? (match[1] ?? '') : (match[2] ?? '');
    spans.push({ start, end: start + match[0].length, display, source });
  }
  return spans;
}
