/**
 * Разбор подмножества Mermaid своими средствами.
 *
 * Mermaid — это не язык в обычном смысле, а набор строчных описаний, у каждого вида
 * диаграммы свой. Здесь разбираются три самых ходовых вида: блок-схема (`graph`/`flowchart`),
 * диаграмма последовательностей (`sequenceDiagram`) и круговая (`pie`). Разбор чистый:
 * на выходе — строение (узлы, связи, дорожки), без всякой геометрии и без DOM.
 *
 * Принцип тот же, что у формул LaTeX: непонятный знак не выбрасывается молча.
 * Если строка не разобралась, она либо становится отдельным узлом с видимым текстом,
 * либо (если не разобралось само объявление вида) весь разбор честно сообщает об ошибке —
 * и вызывающий показывает исходник кодом, чтобы текст не потерялся.
 *
 * Раскладка — в `mermaid-layout.ts`, рисование — в `ui/mermaid-view.ts`.
 */

/** Направление блок-схемы. `TB` — синоним `TD` (сверху вниз). */
export type FlowDirection = 'TD' | 'BT' | 'LR' | 'RL';

/** Форма узла. Незнакомые скобки из Mermaid сводятся к ближайшей известной. */
export type NodeShape = 'rect' | 'round' | 'stadium' | 'diamond' | 'circle' | 'hexagon';

export interface MermaidNode {
  id: string;
  /** Подпись; переводы строк — это `\n` (в Mermaid пишут `<br/>`). */
  label: string;
  shape: NodeShape;
}

export interface MermaidEdge {
  from: string;
  to: string;
  label?: string;
  /** Пунктирная связь (`-.->`, `-.-`). */
  dashed: boolean;
  /** Жирная связь (`==>`, `===`). */
  thick: boolean;
  /** Есть ли наконечник (`-->`, `-.->`) или связь без него (`---`, `-.-`). */
  head: boolean;
}

export interface MermaidSubgraph {
  id: string;
  title: string;
  /** Узлы, объявленные внутри (по первому упоминанию). */
  nodes: string[];
}

export interface MermaidFlow {
  kind: 'flow';
  direction: FlowDirection;
  nodes: MermaidNode[];
  edges: MermaidEdge[];
  subgraphs: MermaidSubgraph[];
}

export interface SeqParticipant {
  id: string;
  label: string;
  actor: boolean;
}

export type SeqItem =
  | { kind: 'message'; from: string; to: string; label: string; dashed: boolean; self: boolean }
  | { kind: 'note'; over: string[]; placement: 'over' | 'left' | 'right'; label: string }
  | { kind: 'fragment'; label: string; items: SeqItem[] };

export interface MermaidSequence {
  kind: 'sequence';
  participants: SeqParticipant[];
  items: SeqItem[];
}

export interface PieSlice {
  label: string;
  value: number;
}

export interface MermaidPie {
  kind: 'pie';
  title: string;
  showData: boolean;
  slices: PieSlice[];
}

export type MermaidDiagram = MermaidFlow | MermaidSequence | MermaidPie;

export type MermaidParseResult = { ok: true; diagram: MermaidDiagram } | { ok: false; error: string };

/** Разобрать исходник забора ```mermaid. */
export function parseMermaid(source: string): MermaidParseResult {
  const lines = source.split('\n');
  const header = lines.find((line) => {
    const text = stripComment(line).trim();
    return text.length > 0;
  });
  if (header === undefined) return { ok: false, error: 'Пустая диаграмма' };

  if (/^(graph|flowchart)\b/i.test(header.trim())) return parseFlow(lines, header);
  if (/^sequenceDiagram\b/i.test(header)) return parseSequence(lines);
  if (/^pie\b/i.test(header)) return parsePie(lines);
  return { ok: false, error: 'Вид диаграммы не поддерживается' };
}

/** Первая содержательная строка — объявление вида диаграммы. */
export function diagramKind(source: string): 'flow' | 'sequence' | 'pie' | 'other' {
  const result = parseMermaid(source);
  return result.ok ? result.diagram.kind : 'other';
}

/** Убрать `%%`-комментарий (и служебную директиву `%%{...}%%` целиком). */
function stripComment(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('%%{')) return '';
  const index = line.indexOf('%%');
  return index < 0 ? line : line.slice(0, index);
}

/** Разбить строку на операторы по `;` (вне кавычек). */
function splitStatements(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote = false;
  for (const char of line) {
    if (char === '"') quote = !quote;
    if (char === ';' && !quote) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

// ── блок-схема ───────────────────────────────────────────────────────────────

interface NodeRef {
  id: string;
  label?: string;
  shape?: NodeShape;
}

function parseFlow(lines: string[], header: string): MermaidParseResult {
  const direction = normalizeDirection(/\b(TD|TB|BT|LR|RL)\b/i.exec(header)?.[1]);
  const nodes = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];
  const subgraphs: MermaidSubgraph[] = [];
  const stack: MermaidSubgraph[] = [];

  const ensureNode = (ref: NodeRef): MermaidNode => {
    let node = nodes.get(ref.id);
    if (!node) {
      node = { id: ref.id, label: ref.label ?? ref.id, shape: ref.shape ?? 'rect' };
      nodes.set(ref.id, node);
      const parent = stack[stack.length - 1];
      if (parent && !parent.nodes.includes(ref.id)) parent.nodes.push(ref.id);
    } else {
      // Объявление вида `A["подпись"]` после ссылки `A` дописывает подпись и форму.
      if (ref.label !== undefined && node.label === node.id) node.label = ref.label;
      if (ref.shape) node.shape = ref.shape;
    }
    return node;
  };

  for (const rawLine of lines) {
    const line = stripComment(rawLine);
    for (const statement of splitStatements(line)) {
      if (parseFlowStatement(statement, { nodes, edges, subgraphs, stack, ensureNode })) continue;
      // Строка не разобралась как связь — пробуем как объявление узла.
      const ref = parseNodeRef(statement);
      if (ref) ensureNode(ref);
    }
  }

  if (nodes.size === 0) return { ok: false, error: 'В диаграмме нет узлов' };
  return {
    ok: true,
    diagram: { kind: 'flow', direction, nodes: [...nodes.values()], edges, subgraphs },
  };
}

interface FlowContext {
  nodes: Map<string, MermaidNode>;
  edges: MermaidEdge[];
  subgraphs: MermaidSubgraph[];
  stack: MermaidSubgraph[];
  ensureNode: (ref: NodeRef) => MermaidNode;
}

/** Обработать один оператор блок-схемы: подграф, служебное слово или связь. */
function parseFlowStatement(statement: string, ctx: FlowContext): boolean {
  if (/^subgraph\b/i.test(statement)) {
    const rest = statement.replace(/^subgraph\s+/i, '').trim();
    const ref = parseNodeRef(rest);
    const subgraph: MermaidSubgraph = ref
      ? { id: ref.id, title: ref.label ?? ref.id, nodes: [] }
      : { id: `subgraph_${ctx.subgraphs.length}`, title: stripQuotes(rest), nodes: [] };
    ctx.subgraphs.push(subgraph);
    ctx.stack.push(subgraph);
    return true;
  }
  if (/^end\b/i.test(statement)) {
    ctx.stack.pop();
    return true;
  }
  if (/^direction\b/i.test(statement)) return true;
  if (/^(classDef|class|style|linkStyle|click|link)\b/i.test(statement)) return true;
  return parseEdgeStatement(statement, ctx);
}

const SIMPLE_OPS = /(-->|---|-.->|-.-|==>|===|<-->|--x|--o|--\))/;

const NAMED_OP = /^(.*?)\s*(-->|---|-\.->|-\.-|==>|===|<-->|--x|--o|--\))\s*\|([^|]*)\|\s*(.+)$/;
const INLINE_OP = /^(.*?)\s*(--|==|-\.)\s+(.+?)\s+(-->|--x|--o|->|==>)\s*(.+)$/;

function parseEdgeStatement(statement: string, ctx: FlowContext): boolean {
  // Связь с подписью в трубах: `A -->|текст| B`.
  const named = NAMED_OP.exec(statement);
  if (named) return addEdge(named[1] ?? '', named[4] ?? '', decodeOp(named[2] ?? ''), named[3] ?? '', ctx);

  // Связь с подписью между знаками: `A -- текст --> B`.
  const inline = INLINE_OP.exec(statement);
  if (inline) return addEdge(inline[1] ?? '', inline[5] ?? '', decodeOp(inline[4] ?? ''), inline[3] ?? '', ctx);

  // Цепочка `A --> B --> C` без подписей (одиночная связь — её частный случай).
  if (!SIMPLE_OPS.test(statement)) return false;
  const parts = statement.split(SIMPLE_OPS);
  const refs = parts.filter((_, index) => index % 2 === 0);
  const ops = parts.filter((_, index) => index % 2 === 1);
  if (ops.length === 0) return false;
  const parsed = refs.map(parseNodeRef);
  if (parsed.some((ref) => ref === null)) return false;
  for (let index = 0; index < ops.length; index += 1) {
    const from = parsed[index];
    const to = parsed[index + 1];
    if (!from || !to) return false;
    ctx.ensureNode(from);
    ctx.ensureNode(to);
    ctx.edges.push({ from: from.id, to: to.id, ...decodeOp(ops[index] ?? '') });
  }
  return true;
}

function addEdge(fromText: string, toText: string, op: EdgeStyle, label: string, ctx: FlowContext): boolean {
  const from = parseNodeRef(fromText);
  const to = parseNodeRef(toText);
  if (!from || !to) return false;
  ctx.ensureNode(from);
  ctx.ensureNode(to);
  const trimmed = stripQuotes(label).trim();
  ctx.edges.push({ from: from.id, to: to.id, ...op, ...(trimmed ? { label: trimmed } : {}) });
  return true;
}

interface EdgeStyle {
  dashed: boolean;
  thick: boolean;
  head: boolean;
}

/** Стиль связи по знаку: `-->`, `-.-`, `==>`, `---` … */
function decodeOp(op: string): EdgeStyle {
  return {
    dashed: op.includes('.'),
    thick: op.startsWith('='),
    head: op.endsWith('>') || op.endsWith('x') || op.endsWith('o'),
  };
}

function normalizeDirection(value: string | undefined): FlowDirection {
  const upper = (value ?? 'TD').toUpperCase();
  if (upper === 'TB') return 'TD';
  if (upper === 'BT' || upper === 'LR' || upper === 'RL') return upper;
  return 'TD';
}

/** Разобрать ссылку на узел: `id`, `id[подпись]`, `id{ромб}`, `id((круг))` … */
export function parseNodeRef(text: string): NodeRef | null {
  const trimmed = text.trim();
  const match = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)/.exec(trimmed);
  if (!match) return null;
  const id = match[1] ?? '';
  const rest = trimmed.slice(id.length).trim();
  if (!rest) return { id };
  const shape = classifyDelimiter(rest);
  if (!shape) return null;
  return { id, label: cleanLabel(shape.inner), shape: shape.kind };
}

const DELIMITERS: ReadonlyArray<readonly [string, string, NodeShape]> = [
  ['((', '))', 'circle'],
  ['([', '])', 'stadium'],
  ['[[', ']]', 'rect'],
  ['[/', '/]', 'rect'],
  ['[\\', '\\]', 'rect'],
  ['{{', '}}', 'hexagon'],
  ['[', ']', 'rect'],
  ['(', ')', 'round'],
  ['{', '}', 'diamond'],
  ['>', ']', 'rect'],
];

function classifyDelimiter(text: string): { kind: NodeShape; inner: string } | null {
  for (const [open, close, kind] of DELIMITERS) {
    if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
      return { kind, inner: text.slice(open.length, text.length - close.length) };
    }
  }
  return null;
}

/** Подпись узла: снять кавычки, `<br/>` заменить переводом строки. */
function cleanLabel(text: string): string {
  return stripQuotes(text)
    .replace(/<br\s*\/?>/gi, '\n')
    .trim();
}

function stripQuotes(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

// ── диаграмма последовательностей ────────────────────────────────────────────

function parseSequence(lines: string[]): MermaidParseResult {
  const participants = new Map<string, SeqParticipant>();
  const order: SeqParticipant[] = [];
  const root: SeqItem[] = [];
  const stack: SeqItem[][] = [root];

  const ensureParticipant = (id: string, label?: string, actor = false): void => {
    const trimmed = id.trim().replace(/^[+-]/, '');
    if (!trimmed) return;
    let participant = participants.get(trimmed);
    if (!participant) {
      participant = { id: trimmed, label: label ?? trimmed, actor };
      participants.set(trimmed, participant);
      order.push(participant);
    } else if (label !== undefined) {
      participant.label = label;
    }
  };

  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim();
    if (!line || /^sequenceDiagram\b/i.test(line)) continue;

    const declare = /^(participant|actor)\s+([^\s]+)(?:\s+as\s+(.+))?$/i.exec(line);
    if (declare) {
      const labelText = declare[3] ? cleanLabel(declare[3]) : undefined;
      const actor = (declare[1] ?? '').toLowerCase() === 'actor';
      ensureParticipant(stripQuotes(declare[2] ?? ''), labelText ?? stripQuotes(declare[2] ?? ''), actor);
      continue;
    }

    const note = /^note\s+(over|left of|right of)\s+([^:]+):\s*(.*)$/i.exec(line);
    if (note) {
      const placementWord = (note[1] ?? 'over').toLowerCase();
      const placement = placementWord === 'left of' ? 'left' : placementWord === 'right of' ? 'right' : 'over';
      const targets = (note[2] ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      for (const target of targets) ensureParticipant(target);
      stack[stack.length - 1]?.push({
        kind: 'note',
        over: targets.length > 0 ? targets : [''],
        placement,
        label: cleanLabel(note[3] ?? ''),
      });
      continue;
    }

    const fragment = /^(loop|alt|opt|par|critical|break|rect)\b\s*(.*)$/i.exec(line);
    if (fragment) {
      const items: SeqItem[] = [];
      stack[stack.length - 1]?.push({ kind: 'fragment', label: cleanLabel(fragment[2] ?? ''), items });
      stack.push(items);
      continue;
    }
    if (/^end\b/i.test(line)) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (/^(activate|deactivate|autonumber|title|box|participant)\b/i.test(line)) continue;

    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon).trim();
    const text = cleanLabel(line.slice(colon + 1));
    const arrow = /^(.*?)\s*(-->>|->>|-->|->|--x|-x|--\)|-\)|=>|<--|<->)\s*([+-]?[^\s]+)\s*$/.exec(head);
    if (!arrow) continue;
    const from = (arrow[1] ?? '').trim().replace(/^[+-]/, '');
    const to = (arrow[3] ?? '').trim().replace(/^[+-]/, '');
    if (!from || !to) continue;
    ensureParticipant(from);
    ensureParticipant(to);
    stack[stack.length - 1]?.push({
      kind: 'message',
      from,
      to,
      label: text,
      dashed: (arrow[2] ?? '').startsWith('--'),
      self: from === to,
    });
  }

  if (order.length === 0) return { ok: false, error: 'В диаграмме нет участников' };
  return { ok: true, diagram: { kind: 'sequence', participants: order, items: root } };
}

// ── круговая диаграмма ───────────────────────────────────────────────────────

function parsePie(lines: string[]): MermaidParseResult {
  let title = '';
  let showData = false;
  const slices: PieSlice[] = [];

  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim();
    if (!line || /^pie\b/i.test(line)) {
      if (/^pie\b/i.test(line)) {
        showData = /\bshowData\b/i.test(line);
        const inlineTitle = /title\s+(.+)$/i.exec(line);
        if (inlineTitle) title = cleanLabel(inlineTitle[1] ?? '');
      }
      continue;
    }
    const titleLine = /^title\s+(.+)$/i.exec(line);
    if (titleLine) {
      title = cleanLabel(titleLine[1] ?? '');
      continue;
    }
    const slice = /^("?[^":]+"?)\s*:\s*(-?[\d.]+)\s*$/.exec(line);
    if (!slice) continue;
    const value = Number(slice[2]);
    if (!Number.isFinite(value)) continue;
    slices.push({ label: stripQuotes(slice[1] ?? ''), value });
  }

  if (slices.length === 0) return { ok: false, error: 'В круговой диаграмме нет долей' };
  return { ok: true, diagram: { kind: 'pie', title, showData, slices } };
}
