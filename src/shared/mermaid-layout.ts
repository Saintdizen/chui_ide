/**
 * Раскладка подмножества Mermaid: из строения — в геометрию.
 *
 * Здесь нет DOM и нет рисования, только числа: где стоит узел, куда идут связи,
 * где стоят дорожки и рамки. Так раскладку можно проверить тестом (что узел выше
 * по потоку оказывается выше на экране, что связи не проходят сквозь узлы),
 * а рисующий слой остаётся тонким.
 *
 * Раскладка блок-схемы — слоями: узел попадает в слой по самой длинной цепочке
 * от начала потока (циклы разрываются, обратные связи обходятся сбоку), внутри
 * слоя порядок уточняется несколько раз «центром тяжести» соседей — так связи
 * пересекаются реже. Всё считается как поток «сверху вниз» или «слева направо»,
 * а `BT`/`RL` получаются зеркалом готовой картинки.
 */

import type { MermaidDiagram, MermaidFlow, MermaidPie, MermaidSequence, NodeShape } from './mermaid';

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
  shape: NodeShape;
  label: string;
}

export interface LayoutEdge {
  points: LayoutPoint[];
  dashed: boolean;
  thick: boolean;
  head: boolean;
  label?: string;
  labelX?: number;
  labelY?: number;
  labelWidth?: number;
  labelHeight?: number;
}

export interface LayoutSubgraph {
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlowLayout {
  kind: 'flow';
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  subgraphs: LayoutSubgraph[];
}

export interface LayoutParticipant {
  id: string;
  label: string;
  x: number;
  width: number;
  y: number;
  height: number;
  actor: boolean;
}

export interface LayoutLifeline {
  x: number;
  y1: number;
  y2: number;
}

export interface LayoutMessage {
  x1: number;
  x2: number;
  y: number;
  label: string;
  dashed: boolean;
  self: boolean;
  labelX: number;
  labelWidth: number;
}

export interface LayoutNote {
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
}

export interface LayoutFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

export interface SequenceLayout {
  kind: 'sequence';
  width: number;
  height: number;
  participants: LayoutParticipant[];
  lifelines: LayoutLifeline[];
  messages: LayoutMessage[];
  notes: LayoutNote[];
  frames: LayoutFrame[];
}

export interface PieSliceLayout {
  label: string;
  value: number;
  start: number;
  end: number;
  path: string;
  labelX: number;
  labelY: number;
}

export interface PieLayout {
  kind: 'pie';
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  radius: number;
  title: string;
  showData: boolean;
  total: number;
  slices: PieSliceLayout[];
}

export type MermaidLayout = FlowLayout | SequenceLayout | PieLayout;

const CHAR_WIDTH = 7.2;
const LINE_HEIGHT = 17;
const PAD_X = 13;
const PAD_Y = 9;
const MIN_WIDTH = 54;
const MIN_HEIGHT = 34;

/** Разложить разобранную диаграмму. */
export function layoutMermaid(diagram: MermaidDiagram): MermaidLayout {
  if (diagram.kind === 'flow') return layoutFlow(diagram);
  if (diagram.kind === 'sequence') return layoutSequence(diagram);
  return layoutPie(diagram);
}

interface TextSize {
  width: number;
  height: number;
  lines: string[];
}

/** Прикидка размера подписи: ширина по самой длинной строке, высота по числу строк. */
function measure(label: string): TextSize {
  const lines = label.split('\n');
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  return {
    width: Math.max(MIN_WIDTH, longest * CHAR_WIDTH + PAD_X * 2),
    height: Math.max(MIN_HEIGHT, lines.length * LINE_HEIGHT + PAD_Y * 2),
    lines,
  };
}

function shapeSize(shape: NodeShape, size: TextSize): { width: number; height: number } {
  let width = size.width;
  let height = size.height;
  if (shape === 'diamond') {
    width *= 1.7;
    height *= 1.5;
  } else if (shape === 'circle') {
    const side = Math.max(width, height);
    width = side;
    height = side;
  }
  return { width, height };
}

// ── блок-схема ───────────────────────────────────────────────────────────────

const RANK_GAP = 48;
const NODE_GAP = 30;
const MARGIN = 16;
const SIDE_OFFSET = 24;

function layoutFlow(flow: MermaidFlow): FlowLayout {
  const vertical = flow.direction === 'TD' || flow.direction === 'BT';
  const rank = assignRanks(flow);
  const layers = groupByRank(flow, rank);
  orderLayers(layers, flow);

  const sizes = new Map<string, TextSize>();
  for (const node of flow.nodes) sizes.set(node.id, measure(node.label));

  const extent = layers.map((layer) =>
    Math.max(
      1,
      ...layer.map((id) =>
        vertical
          ? shapeSize(nodeShape(flow, id), sizes.get(id)!).height
          : shapeSize(nodeShape(flow, id), sizes.get(id)!).width,
      ),
    ),
  );
  const mainStart: number[] = [];
  let cursor = 0;
  layers.forEach((_, r) => {
    mainStart[r] = cursor;
    cursor += (extent[r] ?? 0) + RANK_GAP;
  });

  const nodes: LayoutNode[] = [];
  const boxes = new Map<string, LayoutNode>();
  layers.forEach((layer, r) => {
    const crossSizes = layer.map((id) =>
      vertical
        ? shapeSize(nodeShape(flow, id), sizes.get(id)!).width
        : shapeSize(nodeShape(flow, id), sizes.get(id)!).height,
    );
    const total = crossSizes.reduce((sum, value) => sum + value, 0) + NODE_GAP * Math.max(0, layer.length - 1);
    let cross = -total / 2;
    layer.forEach((id, i) => {
      const size = shapeSize(nodeShape(flow, id), sizes.get(id)!);
      const mainCenter = (mainStart[r] ?? 0) + (extent[r] ?? 0) / 2;
      const crossCenter = cross + (crossSizes[i] ?? 0) / 2;
      const x = vertical ? crossCenter : mainCenter;
      const y = vertical ? mainCenter : crossCenter;
      const node: LayoutNode = {
        id,
        x: x - size.width / 2,
        y: y - size.height / 2,
        width: size.width,
        height: size.height,
        lines: sizes.get(id)!.lines,
        shape: nodeShape(flow, id),
        label: flow.nodes.find((item) => item.id === id)?.label ?? id,
      };
      nodes.push(node);
      boxes.set(id, node);
      cross += (crossSizes[i] ?? 0) + NODE_GAP;
    });
  });

  const edges: LayoutEdge[] = [];
  for (const edge of flow.edges) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (!from || !to) continue;
    const forward = (rank.get(edge.to) ?? 0) > (rank.get(edge.from) ?? 0);
    const points = edge.from === edge.to ? selfRoute(from, vertical) : edgeRoute(from, to, forward, vertical);
    const label = edge.label ? measure(edge.label) : null;
    const middle = polylineMidpoint(points);
    edges.push({
      points,
      dashed: edge.dashed,
      thick: edge.thick,
      head: edge.head,
      ...(edge.label && label
        ? {
            label: edge.label,
            labelX: middle.x,
            labelY: middle.y - 6,
            labelWidth: label.width,
            labelHeight: label.height,
          }
        : {}),
    });
  }

  const subgraphs = layoutSubgraphs(flow, boxes);
  const geometry: Transformable = { nodes, edges, subgraphs };
  const { width, height } = normalize(geometry, MARGIN);
  if (flow.direction === 'BT') mirror(geometry, width, 'y');
  if (flow.direction === 'RL') mirror(geometry, width, 'x');
  return { kind: 'flow', width, height, nodes, edges, subgraphs };
}

function nodeShape(flow: MermaidFlow, id: string): NodeShape {
  return flow.nodes.find((node) => node.id === id)?.shape ?? 'rect';
}

/** Слой узла — длина самой длинной цепочки от начала потока (циклы разрываются). */
function assignRanks(flow: MermaidFlow): Map<string, number> {
  const pred = new Map<string, string[]>();
  for (const node of flow.nodes) pred.set(node.id, []);
  for (const edge of flow.edges) {
    if (pred.has(edge.to) && pred.has(edge.from)) pred.get(edge.to)!.push(edge.from);
  }
  const rank = new Map<string, number>();
  const compute = (id: string, stack: Set<string>): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (stack.has(id)) return 0;
    stack.add(id);
    let value = 0;
    for (const parent of pred.get(id) ?? []) value = Math.max(value, compute(parent, stack) + 1);
    stack.delete(id);
    rank.set(id, value);
    return value;
  };
  for (const node of flow.nodes) compute(node.id, new Set());
  return rank;
}

function groupByRank(flow: MermaidFlow, rank: Map<string, number>): string[][] {
  const maxRank = flow.nodes.reduce((max, node) => Math.max(max, rank.get(node.id) ?? 0), 0);
  const layers: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const node of flow.nodes) (layers[rank.get(node.id) ?? 0] ?? []).push(node.id);
  return layers;
}

/** Уточнить порядок узлов внутри слоёв, снижая число пересечений связей. */
function orderLayers(layers: string[][], flow: MermaidFlow): void {
  const pred = new Map<string, string[]>();
  const succ = new Map<string, string[]>();
  for (const node of flow.nodes) {
    pred.set(node.id, []);
    succ.set(node.id, []);
  }
  for (const edge of flow.edges) {
    if (succ.has(edge.from)) succ.get(edge.from)!.push(edge.to);
    if (pred.has(edge.to)) pred.get(edge.to)!.push(edge.from);
  }
  const pos = new Map<string, number>();
  const reindex = (): void => {
    for (const layer of layers) {
      layer.forEach((id, index) => {
        pos.set(id, index);
      });
    }
  };
  reindex();
  for (let sweep = 0; sweep < 4; sweep += 1) {
    if (sweep % 2 === 0) {
      for (let r = 1; r < layers.length; r += 1) sortByBarycenter(layers[r]!, pred, pos);
    } else {
      for (let r = layers.length - 2; r >= 0; r -= 1) sortByBarycenter(layers[r]!, succ, pos);
    }
    reindex();
  }
}

function sortByBarycenter(layer: string[], neighbors: Map<string, string[]>, pos: Map<string, number>): void {
  const keyed = layer.map((id, index) => {
    const known = (neighbors.get(id) ?? [])
      .map((other) => pos.get(other))
      .filter((value): value is number => value !== undefined);
    const score = known.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : index;
    return { id, score, index };
  });
  keyed.sort((a, b) => a.score - b.score || a.index - b.index);
  layer.splice(0, layer.length, ...keyed.map((item) => item.id));
}

function selfRoute(box: LayoutNode, vertical: boolean): LayoutPoint[] {
  const loop = 22;
  if (vertical) {
    const x = box.x + box.width;
    const y1 = box.y + box.height * 0.3;
    const y2 = box.y + box.height * 0.75;
    return [
      { x, y: y1 },
      { x: x + loop, y: y1 },
      { x: x + loop, y: y2 },
      { x, y: y2 },
    ];
  }
  const y = box.y + box.height;
  const x1 = box.x + box.width * 0.3;
  const x2 = box.x + box.width * 0.75;
  return [
    { x: x1, y },
    { x: x1, y: y + loop },
    { x: x2, y: y + loop },
    { x: x2, y },
  ];
}

function edgeRoute(from: LayoutNode, to: LayoutNode, forward: boolean, vertical: boolean): LayoutPoint[] {
  if (vertical) {
    if (forward) {
      const sx = from.x + from.width / 2;
      const sy = from.y + from.height;
      const tx = to.x + to.width / 2;
      const ty = to.y;
      const my = (sy + ty) / 2;
      return [
        { x: sx, y: sy },
        { x: sx, y: my },
        { x: tx, y: my },
        { x: tx, y: ty },
      ];
    }
    const x = Math.max(from.x + from.width, to.x + to.width) + SIDE_OFFSET;
    const sy = from.y + from.height / 2;
    const ty = to.y + to.height / 2;
    return [
      { x: from.x + from.width, y: sy },
      { x, y: sy },
      { x, y: ty },
      { x: to.x + to.width, y: ty },
    ];
  }
  if (forward) {
    const sx = from.x + from.width;
    const sy = from.y + from.height / 2;
    const tx = to.x;
    const ty = to.y + to.height / 2;
    const mx = (sx + tx) / 2;
    return [
      { x: sx, y: sy },
      { x: mx, y: sy },
      { x: mx, y: ty },
      { x: tx, y: ty },
    ];
  }
  const y = Math.max(from.y + from.height, to.y + to.height) + SIDE_OFFSET;
  const sx = from.x + from.width / 2;
  const tx = to.x + to.width / 2;
  return [
    { x: sx, y: from.y + from.height },
    { x: sx, y },
    { x: tx, y },
    { x: tx, y: to.y + to.height },
  ];
}

/** Точка на середине ломаной линии (по длине) — место для подписи связи. */
function polylineMidpoint(points: LayoutPoint[]): LayoutPoint {
  if (points.length === 0) return { x: 0, y: 0 };
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += distance(points[index - 1]!, points[index]!);
  let half = total / 2;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const segment = distance(a, b);
    if (half <= segment || index === points.length - 1) {
      const ratio = segment === 0 ? 0 : half / segment;
      return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
    }
    half -= segment;
  }
  return points[points.length - 1]!;
}

function distance(a: LayoutPoint, b: LayoutPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Рамки подграфов: охват своими узлами и вложенными подграфами. */
function layoutSubgraphs(flow: MermaidFlow, boxes: Map<string, LayoutNode>): LayoutSubgraph[] {
  const result: LayoutSubgraph[] = new Array(flow.subgraphs.length);
  const pad = 16;
  for (let index = flow.subgraphs.length - 1; index >= 0; index -= 1) {
    const subgraph = flow.subgraphs[index]!;
    const members = subgraph.nodes.map((id) => boxes.get(id)).filter((box): box is LayoutNode => box !== undefined);
    if (members.length === 0) {
      result[index] = { title: subgraph.title, x: 0, y: 0, width: 0, height: 0 };
      continue;
    }
    let minX = Math.min(...members.map((box) => box.x));
    let minY = Math.min(...members.map((box) => box.y));
    let maxX = Math.max(...members.map((box) => box.x + box.width));
    let maxY = Math.max(...members.map((box) => box.y + box.height));
    for (let inner = index + 1; inner < result.length; inner += 1) {
      const child = result[inner]!;
      if (child.width === 0) continue;
      minX = Math.min(minX, child.x);
      minY = Math.min(minY, child.y);
      maxX = Math.max(maxX, child.x + child.width);
      maxY = Math.max(maxY, child.y + child.height);
    }
    result[index] = {
      title: subgraph.title,
      x: minX - pad,
      y: minY - pad - 18,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2 + 18,
    };
  }
  return result;
}

// ── диаграмма последовательностей ────────────────────────────────────────────

const SEQ_STEP = 36;
const SEQ_SELF_STEP = 50;
const SEQ_GAP = 44;
const SEQ_PART_HEIGHT = 32;

function layoutSequence(sequence: MermaidSequence): SequenceLayout {
  const sizes = sequence.participants.map((participant) => Math.max(96, measure(participant.label).width));
  const centers = new Map<string, number>();
  let cursor = 0;
  const participants: LayoutParticipant[] = sequence.participants.map((participant, index) => {
    const width = sizes[index] ?? 96;
    const x = cursor;
    centers.set(participant.id, x + width / 2);
    cursor += width + SEQ_GAP;
    return {
      id: participant.id,
      label: participant.label,
      x,
      width,
      y: 0,
      height: SEQ_PART_HEIGHT,
      actor: participant.actor,
    };
  });

  const messages: LayoutMessage[] = [];
  const notes: LayoutNote[] = [];
  const frames: LayoutFrame[] = [];
  const headerBottom = SEQ_PART_HEIGHT;
  const minCenter = Math.min(...participants.map((part) => part.x + part.width / 2));
  const maxCenter = Math.max(...participants.map((part) => part.x + part.width / 2));

  let y = headerBottom + 26;
  const renderItems = (items: MermaidSequence['items']): void => {
    for (const item of items) {
      if (item.kind === 'fragment') {
        const top = y - 14;
        renderItems(item.items);
        frames.push({
          x: minCenter - 32,
          y: top,
          width: maxCenter - minCenter + 64,
          height: y - top,
          label: item.label,
        });
        y += 10;
        continue;
      }
      if (item.kind === 'note') {
        const size = measure(item.label);
        const anchor = centers.get(item.over[0] ?? '') ?? minCenter;
        const last = centers.get(item.over[item.over.length - 1] ?? '') ?? anchor;
        let x = (anchor + last) / 2 - size.width / 2;
        if (item.placement === 'left') x = anchor - size.width - 12;
        if (item.placement === 'right') x = last + 12;
        notes.push({ x, y, width: size.width, height: size.height, lines: size.lines });
        y += size.height + 12;
        continue;
      }
      const from = centers.get(item.from) ?? minCenter;
      const to = centers.get(item.to) ?? minCenter;
      const label = measure(item.label);
      if (item.self) {
        messages.push({
          x1: from,
          x2: from,
          y,
          label: item.label,
          dashed: item.dashed,
          self: true,
          labelX: from + 44,
          labelWidth: label.width,
        });
        y += SEQ_SELF_STEP;
        continue;
      }
      messages.push({
        x1: from,
        x2: to,
        y,
        label: item.label,
        dashed: item.dashed,
        self: false,
        labelX: (from + to) / 2,
        labelWidth: label.width,
      });
      y += SEQ_STEP;
    }
  };
  renderItems(sequence.items);

  const lifelineTop = headerBottom;
  const lifelineBottom = y - 12;
  const lifelines: LayoutLifeline[] = participants.map((participant) => ({
    x: participant.x + participant.width / 2,
    y1: lifelineTop,
    y2: lifelineBottom,
  }));

  const rawWidth = cursor - SEQ_GAP;
  const width = rawWidth + MARGIN * 2;
  const height = lifelineBottom + MARGIN * 2;
  for (const participant of participants) participant.x += MARGIN;
  for (const lifeline of lifelines) lifeline.x += MARGIN;
  for (const message of messages) {
    message.x1 += MARGIN;
    message.x2 += MARGIN;
    message.labelX += MARGIN;
  }
  for (const note of notes) note.x += MARGIN;
  for (const frame of frames) frame.x += MARGIN;
  offsetY(messages, notes, frames, lifelines, participants, MARGIN);
  return { kind: 'sequence', width, height, participants, lifelines, messages, notes, frames };
}

function offsetY(
  messages: LayoutMessage[],
  notes: LayoutNote[],
  frames: LayoutFrame[],
  lifelines: LayoutLifeline[],
  participants: LayoutParticipant[],
  dy: number,
): void {
  for (const message of messages) message.y += dy;
  for (const note of notes) note.y += dy;
  for (const frame of frames) frame.y += dy;
  for (const lifeline of lifelines) {
    lifeline.y1 += dy;
    lifeline.y2 += dy;
  }
  for (const participant of participants) participant.y += dy;
}

// ── круговая диаграмма ───────────────────────────────────────────────────────

function layoutPie(pie: MermaidPie): PieLayout {
  const radius = 96;
  const titleHeight = pie.title ? 24 : 0;
  const centerX = radius + MARGIN;
  const centerY = radius + MARGIN + titleHeight;
  const width = radius * 2 + MARGIN * 2;
  const height = radius * 2 + MARGIN * 2 + titleHeight;
  const total = pie.slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
  const slices: PieSliceLayout[] = [];
  let angle = -Math.PI / 2;
  for (const slice of pie.slices) {
    const value = Math.max(0, slice.value);
    const sweep = total > 0 ? (value / total) * Math.PI * 2 : 0;
    const start = angle;
    const end = angle + sweep;
    const mid = (start + end) / 2;
    slices.push({
      label: slice.label,
      value,
      start,
      end,
      path: arcPath(centerX, centerY, radius, start, end, total, value),
      labelX: centerX + Math.cos(mid) * radius * 0.62,
      labelY: centerY + Math.sin(mid) * radius * 0.62,
    });
    angle = end;
  }
  return {
    kind: 'pie',
    width,
    height,
    centerX,
    centerY,
    radius,
    title: pie.title,
    showData: pie.showData,
    total,
    slices,
  };
}

function arcPath(cx: number, cy: number, r: number, start: number, end: number, total: number, value: number): string {
  // Доля, равная целому кругу, дугой не рисуется — нужен обычный круг.
  if (total > 0 && value >= total) {
    return `M ${round(cx)} ${round(cy - r)} A ${r} ${r} 0 1 1 ${round(cx - 0.01)} ${round(cy - r)} Z`;
  }
  const x1 = cx + Math.cos(start) * r;
  const y1 = cy + Math.sin(start) * r;
  const x2 = cx + Math.cos(end) * r;
  const y2 = cy + Math.sin(end) * r;
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${round(cx)} ${round(cy)} L ${round(x1)} ${round(y1)} A ${r} ${r} 0 ${large} 1 ${round(x2)} ${round(y2)} Z`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ── общий сдвиг и зеркало ────────────────────────────────────────────────────

interface Transformable {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  subgraphs: LayoutSubgraph[];
}

/** Сдвинуть всё в положительные координаты и вернуть габариты. */
function normalize(geometry: Transformable, margin: number): { width: number; height: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const node of geometry.nodes) {
    xs.push(node.x, node.x + node.width);
    ys.push(node.y, node.y + node.height);
  }
  for (const edge of geometry.edges) {
    for (const point of edge.points) {
      xs.push(point.x);
      ys.push(point.y);
    }
  }
  for (const subgraph of geometry.subgraphs) {
    if (subgraph.width === 0) continue;
    xs.push(subgraph.x, subgraph.x + subgraph.width);
    ys.push(subgraph.y, subgraph.y + subgraph.height);
  }
  const minX = Math.min(...xs, 0);
  const minY = Math.min(...ys, 0);
  const dx = margin - minX;
  const dy = margin - minY;
  for (const node of geometry.nodes) {
    node.x += dx;
    node.y += dy;
  }
  for (const edge of geometry.edges) {
    for (const point of edge.points) {
      point.x += dx;
      point.y += dy;
    }
    if (edge.labelX !== undefined) edge.labelX += dx;
    if (edge.labelY !== undefined) edge.labelY += dy;
  }
  for (const subgraph of geometry.subgraphs) {
    subgraph.x += dx;
    subgraph.y += dy;
  }
  const maxX = Math.max(...xs) + dx;
  const maxY = Math.max(...ys) + dy;
  return { width: maxX + margin, height: maxY + margin };
}

function mirror(geometry: Transformable, size: number, axis: 'x' | 'y'): void {
  const flip = (point: LayoutPoint): void => {
    if (axis === 'x') point.x = size - point.x;
    else point.y = size - point.y;
  };
  for (const node of geometry.nodes) {
    if (axis === 'x') node.x = size - node.x - node.width;
    else node.y = size - node.y - node.height;
  }
  for (const edge of geometry.edges) {
    for (const point of edge.points) flip(point);
    if (axis === 'x' && edge.labelX !== undefined) edge.labelX = size - edge.labelX;
    if (axis === 'y' && edge.labelY !== undefined) edge.labelY = size - edge.labelY;
  }
  for (const subgraph of geometry.subgraphs) {
    if (axis === 'x') subgraph.x = size - subgraph.x - subgraph.width;
    else subgraph.y = size - subgraph.y - subgraph.height;
  }
}
