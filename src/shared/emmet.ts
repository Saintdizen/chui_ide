/**
 * Emmet: сокращение в разметку (`ul>li*3` → список) и в свойства стиля (`m10` → `margin: 10px;`).
 *
 * Человек пишет короткое, жмёт Tab — и получает готовую разметку. Здесь живёт только
 * разбор сокращения: строка на входе, текст и место каретки на выходе. Ни буфера, ни DOM,
 * ни клавиш — это дело вызывающего (`input/emmet.ts`). Так разбор проверяется тестами без окна.
 *
 * Поддержано осознанно не всё, что умеет Emmet, а то, что встречается в работе:
 *   • вложенность `>` и соседство `+`, подъём `^`;
 *   • повтор `*N` и нумерация `$` (в том числе `$$`);
 *   • классы `.имя`, идентификаторы `#имя`, атрибуты `[имя=значение]`, текст `{…}`;
 *   • `!` — скелет HTML5;
 *   • свойства стиля: сокращённые имена, размеры с единицами, цвета и ключевые слова.
 * Групп `(…)` и обратной нумерации `@N` нет: сюда они не приходили, а поддерживать
 * непроверенное — держать код, которого никто не щупал.
 *
 * Модуль чистый: ни сети, ни DOM. Поэтому его видно в тестах без окна.
 */

/** Что получилось: текст для вставки и смещение каретки внутри него. */
export interface EmmetResult {
  readonly text: string;
  /** Куда встать кареткой: внутрь первого элемента без детей или в конец вставки. */
  readonly caret: number;
}

export interface EmmetOptions {
  /** Отступ одной ступени (обычно `tabSize` пробелов). По умолчанию два пробела. */
  readonly indent?: string;
}

/** Языки разметки, где работает HTML-разбор. */
const MARKUP_LANGUAGES = new Set(['html', 'htm', 'xml', 'svg', 'vue']);

/** Языки стилей, где работает CSS-разбор. */
const STYLE_LANGUAGES = new Set(['css', 'scss', 'less', 'sass', 'stylus']);

/** Какой разбор применять к языку. `null` — Emmet здесь не работает. */
export function emmetSyntaxFor(languageId: string | null): 'markup' | 'style' | null {
  if (!languageId) return null;
  const id = languageId.toLowerCase();
  if (MARKUP_LANGUAGES.has(id)) return 'markup';
  if (STYLE_LANGUAGES.has(id)) return 'style';
  return null;
}

/**
 * Слово перед кареткой — кандидат в сокращения. Собираем знаки, которые бывают в
 * сокращении; внутри `{}` и `[]` допускаем и пробелы (`[title=Hello World]`).
 * Пусто — раскрывать нечего.
 */
export function abbreviationBefore(text: string, caret: number): string | null {
  let start = caret;
  let depth = 0;
  while (start > 0) {
    const char = text[start - 1]!;
    if (char === '}' || char === ']') {
      depth += 1;
      start -= 1;
      continue;
    }
    if (char === '{' || char === '[') {
      if (depth === 0) break;
      depth -= 1;
      start -= 1;
      continue;
    }
    if (depth > 0) {
      start -= 1;
      continue;
    }
    if (/[A-Za-z0-9>+^*$()#.\-_:!@%]/.test(char)) {
      start -= 1;
      continue;
    }
    break;
  }
  const word = text.slice(start, caret);
  if (word.length === 0) return null;
  // Сразу после `<` мы внутри написанного тега (`<li` или `<li>`), а не перед сокращением:
  // раскрывать `li>` тут значило бы обрамлять уже готовую разметку. Так же и после `</`.
  if (start > 0 && (text[start - 1] === '<' || text[start - 1] === '/')) return null;
  return word;
}

/** Раскрыть сокращение. `null` — это не сокращение Emmet, раскрывать нечего. */
export function expandEmmet(
  abbreviation: string,
  syntax: 'markup' | 'style',
  options: EmmetOptions = {},
): EmmetResult | null {
  if (abbreviation.length === 0) return null;
  const indent = options.indent ?? '  ';
  if (syntax === 'style') return expandStyle(abbreviation, indent);
  return expandMarkup(abbreviation, indent);
}

/* ── HTML ───────────────────────────────────────────────────────────────── */

/** Узел разметки: тег, оформление и дети. Строки с `$` нумеруются при выводе. */
interface MarkupNode {
  tag: string;
  id: string | null;
  classes: string[];
  attrs: Array<{ name: string; value: string | null }>;
  text: string | null;
  multiplier: number;
  children: MarkupNode[];
}

/** Теги без содержимого: закрывающего тега им не пишут. */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** Сокращения имён тегов, привычные в Emmet: `bq` короче `blockquote`. */
const TAG_ALIASES: Record<string, string> = {
  bq: 'blockquote',
  fig: 'figure',
  figc: 'figcaption',
};

/** Атрибуты, которые Emmet ставит сам: без них имена-заготовки бесполезны. */
const DEFAULT_ATTRS: Record<string, Array<{ name: string; value: string }>> = {
  a: [{ name: 'href', value: '' }],
  img: [
    { name: 'src', value: '' },
    { name: 'alt', value: '' },
  ],
  input: [{ name: 'type', value: 'text' }],
  link: [
    { name: 'rel', value: 'stylesheet' },
    { name: 'href', value: '' },
  ],
};

const HTML5_SKELETON = [
  '<!DOCTYPE html>',
  '<html lang="en">',
  '<head>',
  '  <meta charset="UTF-8" />',
  '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
  '  <title>Document</title>',
  '</head>',
  '<body>',
  '',
  '</body>',
  '</html>',
].join('\n');

function expandMarkup(abbreviation: string, indent: string): EmmetResult | null {
  if (abbreviation === '!') {
    // Каретку ставим в пустое тело документа — чаще всего туда и пишут.
    return { text: HTML5_SKELETON, caret: HTML5_SKELETON.indexOf('\n\n') + 1 };
  }
  const roots = parseMarkup(abbreviation);
  if (!roots || roots.length === 0) return null;

  let text = '';
  let caret: number | null = null;

  const renderNodes = (nodes: readonly MarkupNode[], level: number): void => {
    for (const node of nodes) {
      for (let number = 1; number <= node.multiplier; number += 1) {
        if (text.length > 0) text += '\n';
        renderNode(node, level, number);
      }
    }
  };

  const renderNode = (node: MarkupNode, level: number, number: number): void => {
    const pad = indent.repeat(level);
    const tag = substitute(node.tag, number);
    text += `${pad}<${tag}${openAttributes(node, number)}>`;
    if (VOID_TAGS.has(tag.toLowerCase())) return;

    if (node.children.length > 0) {
      renderNodes(node.children, level + 1);
      text += `\n${pad}</${tag}>`;
      return;
    }
    if (caret === null) caret = text.length;
    const body = node.text === null ? '' : substitute(node.text, number);
    text += `${body}</${tag}>`;
  };

  renderNodes(roots, 0);
  return { text, caret: caret ?? text.length };
}

/** Собрать атрибуты тега: id, классы, свои атрибуты и умолчания для известных тегов. */
function openAttributes(node: MarkupNode, number: number): string {
  const parts: string[] = [];
  if (node.id !== null) parts.push(` id="${substitute(node.id, number)}"`);
  if (node.classes.length > 0) {
    const classes = node.classes.map((item) => substitute(item, number)).join(' ');
    parts.push(` class="${classes}"`);
  }
  for (const attr of node.attrs) {
    const name = substitute(attr.name, number);
    if (attr.value === null) parts.push(` ${name}`);
    else parts.push(` ${name}="${substitute(attr.value, number)}"`);
  }
  const tag = node.tag.toLowerCase();
  const known = new Set(node.attrs.map((attr) => attr.name.toLowerCase()));
  for (const attr of DEFAULT_ATTRS[tag] ?? []) {
    if (!known.has(attr.name)) parts.push(` ${attr.name}="${attr.value}"`);
  }
  return parts.join('');
}

/** Подставить номер шага вместо `$`: `item$` → `item1`, `item$$` → `item01`. */
function substitute(text: string, number: number): string {
  return text.replace(/\$+/g, (dollars) => String(number).padStart(dollars.length, '0'));
}

/** Разобрать сокращение разметки в дерево. `null` — синтаксис не наш. */
function parseMarkup(source: string): MarkupNode[] | null {
  const scanner = new MarkupScanner(source);
  const roots: MarkupNode[] = [];
  const stack: MarkupNode[] = [];
  let operator: '>' | '+' = '+';

  while (!scanner.done()) {
    const char = scanner.peek();
    if (char === '>') {
      scanner.next();
      operator = '>';
      continue;
    }
    if (char === '+') {
      scanner.next();
      operator = '+';
      continue;
    }
    if (char === '^') {
      scanner.next();
      if (stack.length > 0) stack.pop();
      operator = '+';
      continue;
    }
    if (char === '(' || char === ')') return null; // группы не поддержаны

    const node = scanner.readNode();
    if (!node) return null;

    // `>` — ребёнок последнего элемента; иначе (сосед) сперва поднимаемся на уровень выше.
    let parent: MarkupNode | null;
    if (operator === '>') {
      parent = stack.length > 0 ? stack[stack.length - 1]! : null;
    } else {
      if (stack.length > 0) stack.pop();
      parent = stack.length > 0 ? stack[stack.length - 1]! : null;
    }
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
    operator = '+';
  }

  return roots;
}

/** Пошаговый разбор одного узла сокращения: тег, оформление, повтор. */
class MarkupScanner {
  private index = 0;
  constructor(private readonly source: string) {}

  done(): boolean {
    return this.index >= this.source.length;
  }

  peek(): string {
    return this.source[this.index] ?? '';
  }

  next(): string {
    return this.source[this.index++] ?? '';
  }

  /** Прочитать элемент: `tag#id.class[attr]{text}*N`. `null` — не похоже на элемент. */
  readNode(): MarkupNode | null {
    const node: MarkupNode = {
      tag: '',
      id: null,
      classes: [],
      attrs: [],
      text: null,
      multiplier: 1,
      children: [],
    };

    // Тег: буквы, цифры, дефисы и `$` (для нумерации). Пусто — будет `div`.
    let tag = '';
    while (/[A-Za-z0-9$_-]/.test(this.peek())) tag += this.next();
    node.tag = tag.length > 0 ? (TAG_ALIASES[tag] ?? tag) : 'div';

    for (;;) {
      const char = this.peek();
      if (char === '#') {
        this.next();
        node.id = this.readName();
      } else if (char === '.') {
        this.next();
        const name = this.readName();
        if (name.length === 0) return null;
        node.classes.push(name);
      } else if (char === '[') {
        if (!this.readAttributes(node)) return null;
      } else if (char === '{') {
        node.text = this.readBraced('{', '}');
      } else if (char === '*') {
        this.next();
        if (!this.readMultiplier(node)) return null;
      } else {
        break;
      }
    }

    return node;
  }

  private readName(): string {
    let name = '';
    while (/[A-Za-z0-9$_-]/.test(this.peek())) name += this.next();
    return name;
  }

  private readMultiplier(node: MarkupNode): boolean {
    let digits = '';
    while (/[0-9]/.test(this.peek())) digits += this.next();
    if (digits.length === 0) return false;
    node.multiplier = Math.max(1, Number.parseInt(digits, 10));
    // `@-` — обратный порядок; знак съедаем, порядок оставляем прямым (обратной
    // нумерации в работе не встречалось, а поддержка её — отдельное правило).
    if (this.peek() === '@') {
      this.next();
      if (this.peek() === '-') this.next();
    }
    return true;
  }

  private readAttributes(node: MarkupNode): boolean {
    const inner = this.readBraced('[', ']');
    if (inner === null) return false;
    for (const raw of inner.split(/\s+/)) {
      if (raw.length === 0) continue;
      const eq = raw.indexOf('=');
      if (eq < 0) node.attrs.push({ name: raw, value: null });
      else node.attrs.push({ name: raw.slice(0, eq), value: stripQuotes(raw.slice(eq + 1)) });
    }
    return true;
  }

  /** Прочитать содержимое в `open`…`close` (с учётом вложенности таких же скобок внутри). */
  private readBraced(open: string, close: string): string | null {
    if (this.peek() !== open) return null;
    this.next();
    let depth = 1;
    let text = '';
    while (!this.done()) {
      const char = this.next();
      if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) return text;
      }
      text += char;
    }
    return null;
  }
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/* ── CSS ────────────────────────────────────────────────────────────────── */

/** Сокращения имён свойств. Значение — полное имя свойства. */
const PROPERTIES: Record<string, string> = {
  m: 'margin',
  mt: 'margin-top',
  mr: 'margin-right',
  mb: 'margin-bottom',
  ml: 'margin-left',
  p: 'padding',
  pt: 'padding-top',
  pr: 'padding-right',
  pb: 'padding-bottom',
  pl: 'padding-left',
  w: 'width',
  mw: 'max-width',
  miw: 'min-width',
  h: 'height',
  mh: 'max-height',
  mih: 'min-height',
  c: 'color',
  bg: 'background',
  bgc: 'background-color',
  bgi: 'background-image',
  fz: 'font-size',
  fw: 'font-weight',
  ff: 'font-family',
  fst: 'font-style',
  lh: 'line-height',
  ls: 'letter-spacing',
  ta: 'text-align',
  td: 'text-decoration',
  tt: 'text-transform',
  ws: 'white-space',
  va: 'vertical-align',
  d: 'display',
  pos: 'position',
  t: 'top',
  r: 'right',
  b: 'bottom',
  l: 'left',
  z: 'z-index',
  fl: 'float',
  cl: 'clear',
  ov: 'overflow',
  op: 'opacity',
  cur: 'cursor',
  vis: 'visibility',
  bd: 'border',
  bdw: 'border-width',
  bds: 'border-style',
  bdc: 'border-color',
  brs: 'border-radius',
  bxsh: 'box-shadow',
  trs: 'transition',
  trf: 'transform',
  jc: 'justify-content',
  ai: 'align-items',
  ac: 'align-content',
  as: 'align-self',
  fd: 'flex-direction',
  fww: 'flex-wrap',
  fg: 'flex-grow',
  fx: 'flex',
  g: 'gap',
  gt: 'grid-template',
  gtc: 'grid-template-columns',
  gtr: 'grid-template-rows',
};

/** Свойства без единиц измерения: числа у них — не размеры. */
const UNITLESS = new Set(['z-index', 'opacity', 'font-weight', 'line-height', 'flex-grow', 'flex', 'order']);

/** Ключевые слова-значения: сокращение → значение. */
const VALUES: Record<string, string> = {
  a: 'auto',
  n: 'none',
  b: 'bold',
  i: 'italic',
  u: 'underline',
  c: 'center',
  l: 'left',
  r: 'right',
  j: 'justify',
  ib: 'inline-block',
  db: 'block',
  df: 'flex',
  dg: 'grid',
  dn: 'none',
  dib: 'inline-block',
  dif: 'inline-flex',
  dig: 'inline-grid',
  pr: 'relative',
  pa: 'absolute',
  pf: 'fixed',
  ps: 'static',
  pc: 'pointer',
  tr: 'transparent',
  ttu: 'uppercase',
  ttl: 'lowercase',
  ttc: 'capitalize',
  nw: 'nowrap',
  sb: 'space-between',
  sa: 'space-around',
  se: 'space-evenly',
};

function expandStyle(abbreviation: string, indent: string): EmmetResult | null {
  // Несколько свойств разделяем `+`: `m10+p20`.
  const parts = abbreviation.split('+').filter((part) => part.length > 0);
  const declarations: string[] = [];
  for (const part of parts) {
    const declaration = expandDeclaration(part);
    if (!declaration) return null;
    declarations.push(declaration);
  }
  if (declarations.length === 0) return null;
  // Одно свойство — одной строкой; несколько — каждое своей, чтобы читалось блоком.
  // Точка с запятой уже стоит в конце каждого свойства.
  const text = declarations.length > 1 ? declarations.join(`\n${indent}`) : declarations[0]!;
  return { text, caret: text.length };
}

/** Одно свойство: `m10` → `margin: 10px;`. `null` — имя не распознано. */
function expandDeclaration(source: string): string | null {
  let text = source;
  let important = false;
  if (text.endsWith('!')) {
    important = true;
    text = text.slice(0, -1);
  }

  // Имя свойства — буквы в начале. Берём САМЫЙ ДЛИННЫЙ известный префикс: `dib` — это
  // `d` (display) и `ib` (inline-block), а `pospr` — `pos` (position) и `pr` (relative).
  const letters = /^[a-z]+/i.exec(text);
  if (!letters) return null;
  const run = letters[0].toLowerCase();
  let property: string | null = null;
  let cut = 0;
  for (let length = run.length; length > 0; length -= 1) {
    const candidate = PROPERTIES[run.slice(0, length)];
    if (candidate) {
      property = candidate;
      cut = length;
      break;
    }
  }
  if (!property) return null;

  const rawValue = text.slice(cut);
  if (rawValue.length === 0) return null;
  const value = normalizeValue(rawValue, property);
  if (value === null) return null;
  return `${property}: ${value}${important ? ' !important' : ''};`;
}

/** Значение свойства: цвета, ключевые слова, размеры с единицами и без. */
function normalizeValue(raw: string, property: string): string | null {
  // Цвет как есть: `#fff`, `#ff0000`.
  if (raw.startsWith('#')) return raw.length >= 2 ? raw : null;

  const pieces = raw.split('-').filter((piece) => piece.length > 0);
  const out: string[] = [];
  for (const piece of pieces) {
    const normalized = normalizePiece(piece, property);
    if (normalized === null) return null;
    out.push(normalized);
  }
  return out.length > 0 ? out.join(' ') : null;
}

function normalizePiece(piece: string, property: string): string | null {
  const number = /^-?\d*\.?\d+$/.exec(piece);
  if (number) {
    if (Number.parseFloat(piece) === 0) return '0';
    return UNITLESS.has(property) ? piece : `${piece}px`;
  }
  // Размер с единицей: `100%`, `16px`, `1.5rem`, `100vh`.
  if (/^-?\d*\.?\d+(px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr)$/.test(piece)) return piece;
  return VALUES[piece.toLowerCase()] ?? piece;
}
