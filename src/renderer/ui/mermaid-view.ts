/**
 * Рисование диаграмм Mermaid в SVG.
 *
 * Тонкий слой: строение — из `shared/mermaid.ts`, геометрия — из
 * `shared/mermaid-layout.ts`, а здесь только превращение чисел в элементы SVG.
 * Цвета берутся из темы через классы (правила — в `styles/main.css`), поэтому
 * диаграмма одинаково читается в светлой и тёмной схеме. Рисунок — это обычный
 * SVG, его видно, можно выделить и увеличить, и он не тянет сторонних библиотек.
 */

import { parseMermaid } from '../../shared/mermaid';
import {
  type FlowLayout,
  type LayoutEdge,
  type LayoutNode,
  type LayoutPoint,
  type MermaidLayout,
  type PieLayout,
  type SequenceLayout,
  layoutMermaid,
} from '../../shared/mermaid-layout';
import { type Child, h } from './dom';

const SVG_NS = 'http://www.w3.org/2000/svg';

type SvgTag = keyof SVGElementTagNameMap;

function svg<K extends SvgTag>(
  tag: K,
  attrs: Record<string, string | number> = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.appendChild(
      typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child,
    );
  }
  return element;
}

/** Нарисовать диаграмму. `null` — исходник не разобрался, вызывающий покажет его кодом. */
export function renderMermaid(source: string): HTMLElement | null {
  const parsed = parseMermaid(source);
  if (!parsed.ok) return null;
  const layout = layoutMermaid(parsed.diagram);
  const drawing = buildSvg(layout);
  return h('div', { class: 'md-mermaid', title: 'Диаграмма Mermaid' }, drawing);
}

function buildSvg(layout: MermaidLayout): SVGSVGElement {
  const root = svg('svg', {
    class: 'mm-svg',
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    width: layout.width,
    height: layout.height,
    xmlns: SVG_NS,
  });
  if (layout.kind === 'flow') drawFlow(root, layout);
  else if (layout.kind === 'sequence') drawSequence(root, layout);
  else drawPie(root, layout);
  return root;
}

// ── узлы и связи блок-схемы ──────────────────────────────────────────────────

function drawFlow(root: SVGSVGElement, layout: FlowLayout): void {
  const subgraphs = svg('g', { class: 'mm-subgraphs' });
  for (const subgraph of layout.subgraphs) {
    if (subgraph.width === 0) continue;
    subgraphs.appendChild(
      svg('rect', {
        class: 'mm-subgraph',
        x: subgraph.x,
        y: subgraph.y,
        width: subgraph.width,
        height: subgraph.height,
        rx: 8,
      }),
    );
    subgraphs.appendChild(
      svg('text', { class: 'mm-subgraph-title', x: subgraph.x + 10, y: subgraph.y + 16 }, subgraph.title),
    );
  }
  root.appendChild(subgraphs);

  const edgeLayer = svg('g', { class: 'mm-edges' });
  for (const edge of layout.edges) edgeLayer.appendChild(edgeElement(edge));
  root.appendChild(edgeLayer);

  const nodeLayer = svg('g', { class: 'mm-nodes' });
  for (const node of layout.nodes) nodeLayer.appendChild(nodeElement(node));
  root.appendChild(nodeLayer);
}

function nodeElement(node: LayoutNode): SVGElement {
  const group = svg('g', { class: `mm-node is-${node.shape}` });
  if (node.shape === 'diamond') {
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    group.appendChild(
      svg('polygon', {
        class: 'mm-node-shape',
        points: `${cx},${node.y} ${node.x + node.width},${cy} ${cx},${node.y + node.height} ${node.x},${cy}`,
      }),
    );
  } else if (node.shape === 'hexagon') {
    const inset = node.height / 2;
    group.appendChild(
      svg('polygon', {
        class: 'mm-node-shape',
        points: [
          `${node.x + inset},${node.y}`,
          `${node.x + node.width - inset},${node.y}`,
          `${node.x + node.width},${node.y + node.height / 2}`,
          `${node.x + node.width - inset},${node.y + node.height}`,
          `${node.x + inset},${node.y + node.height}`,
          `${node.x},${node.y + node.height / 2}`,
        ].join(' '),
      }),
    );
  } else {
    const rx =
      node.shape === 'circle'
        ? node.width / 2
        : node.shape === 'stadium'
          ? node.height / 2
          : node.shape === 'round'
            ? 7
            : 2;
    group.appendChild(
      svg('rect', { class: 'mm-node-shape', x: node.x, y: node.y, width: node.width, height: node.height, rx }),
    );
  }
  textLines(group, node.x + node.width / 2, node.y + node.height / 2, node.lines, 'mm-node-text');
  return group;
}

function edgeElement(edge: LayoutEdge): SVGElement {
  const group = svg('g', { class: `mm-edge${edge.dashed ? ' is-dashed' : ''}${edge.thick ? ' is-thick' : ''}` });
  group.appendChild(svg('path', { class: 'mm-edge-line', d: pathData(edge.points) }));
  if (edge.head) group.appendChild(arrowHead(edge.points));
  if (edge.label && edge.labelWidth !== undefined && edge.labelHeight !== undefined) {
    const x = edge.labelX ?? 0;
    const y = edge.labelY ?? 0;
    group.appendChild(
      svg('rect', {
        class: 'mm-edge-label-bg',
        x: x - edge.labelWidth / 2,
        y: y - edge.labelHeight / 2,
        width: edge.labelWidth,
        height: edge.labelHeight,
        rx: 4,
      }),
    );
    group.appendChild(svg('text', { class: 'mm-edge-label', x, y: y + 4 }, edge.label));
  }
  return group;
}

function pathData(points: LayoutPoint[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${round(point.x)} ${round(point.y)}`).join(' ');
}

/** Наконечник связи — треугольник по направлению последнего отрезка. */
function arrowHead(points: LayoutPoint[]): SVGElement {
  const tip = points[points.length - 1] ?? { x: 0, y: 0 };
  const prev = points[points.length - 2] ?? tip;
  const dx = tip.x - prev.x;
  const dy = tip.y - prev.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const size = 9;
  const baseX = tip.x - ux * size;
  const baseY = tip.y - uy * size;
  const half = size * 0.42;
  const nx = -uy;
  const ny = ux;
  return svg('polygon', {
    class: 'mm-arrow',
    points: `${round(tip.x)},${round(tip.y)} ${round(baseX + nx * half)},${round(baseY + ny * half)} ${round(baseX - nx * half)},${round(baseY - ny * half)}`,
  });
}

// ── диаграмма последовательностей ────────────────────────────────────────────

function drawSequence(root: SVGSVGElement, layout: SequenceLayout): void {
  const frames = svg('g', { class: 'mm-frames' });
  for (const frame of layout.frames) {
    frames.appendChild(
      svg('rect', { class: 'mm-frame', x: frame.x, y: frame.y, width: frame.width, height: frame.height, rx: 6 }),
    );
    frames.appendChild(svg('rect', { class: 'mm-frame-tab', x: frame.x, y: frame.y, width: 54, height: 18, rx: 6 }));
    frames.appendChild(
      svg('text', { class: 'mm-frame-label', x: frame.x + 10, y: frame.y + 13 }, frame.label || 'alt'),
    );
  }
  root.appendChild(frames);

  const lifelines = svg('g', { class: 'mm-lifelines' });
  for (const lifeline of layout.lifelines) {
    lifelines.appendChild(
      svg('line', { class: 'mm-lifeline', x1: lifeline.x, y1: lifeline.y1, x2: lifeline.x, y2: lifeline.y2 }),
    );
  }
  root.appendChild(lifelines);

  const parts = svg('g', { class: 'mm-participants' });
  for (const participant of layout.participants) {
    parts.appendChild(
      svg('rect', {
        class: `mm-participant${participant.actor ? ' is-actor' : ''}`,
        x: participant.x,
        y: participant.y,
        width: participant.width,
        height: participant.height,
        rx: 6,
      }),
    );
    parts.appendChild(
      svg(
        'text',
        {
          class: 'mm-participant-text',
          x: participant.x + participant.width / 2,
          y: participant.y + participant.height / 2 + 4,
        },
        participant.label,
      ),
    );
  }
  root.appendChild(parts);

  const messages = svg('g', { class: 'mm-messages' });
  for (const message of layout.messages) {
    const group = svg('g', { class: `mm-message${message.dashed ? ' is-dashed' : ''}` });
    if (message.self) {
      const x = message.x1;
      const y = message.y;
      const loop = 34;
      group.appendChild(
        svg('path', {
          class: 'mm-message-line',
          d: `M ${round(x)} ${round(y)} L ${round(x + loop)} ${round(y)} L ${round(x + loop)} ${round(y + 22)} L ${round(x + 6)} ${round(y + 22)}`,
        }),
      );
      group.appendChild(
        arrowHead([
          { x: x + loop, y: y + 11 },
          { x: x + 6, y: y + 22 },
        ]),
      );
      group.appendChild(svg('text', { class: 'mm-message-label', x: message.labelX, y: y - 6 }, message.label));
    } else {
      group.appendChild(
        svg('line', { class: 'mm-message-line', x1: message.x1, y1: message.y, x2: message.x2, y2: message.y }),
      );
      group.appendChild(
        arrowHead([
          { x: message.x1, y: message.y },
          { x: message.x2, y: message.y },
        ]),
      );
      group.appendChild(svg('text', { class: 'mm-message-label', x: message.labelX, y: message.y - 6 }, message.label));
    }
    messages.appendChild(group);
  }
  root.appendChild(messages);

  const notes = svg('g', { class: 'mm-notes' });
  for (const note of layout.notes) {
    notes.appendChild(
      svg('rect', { class: 'mm-note', x: note.x, y: note.y, width: note.width, height: note.height, rx: 4 }),
    );
    textLines(notes, note.x + note.width / 2, note.y + note.height / 2, note.lines, 'mm-note-text');
  }
  root.appendChild(notes);
}

// ── круговая диаграмма ───────────────────────────────────────────────────────

function drawPie(root: SVGSVGElement, layout: PieLayout): void {
  const slices = svg('g', { class: 'mm-pie' });
  layout.slices.forEach((slice, index) => {
    slices.appendChild(svg('path', { class: `mm-slice is-${index % 6}`, d: slice.path }));
    const label =
      layout.showData && layout.total > 0
        ? `${slice.label} ${Math.round((slice.value / layout.total) * 100)}%`
        : slice.label;
    slices.appendChild(svg('text', { class: 'mm-slice-label', x: round(slice.labelX), y: round(slice.labelY) }, label));
  });
  root.appendChild(slices);
  if (layout.title) {
    root.appendChild(svg('text', { class: 'mm-pie-title', x: layout.centerX, y: 20 }, layout.title));
  }
}

// ── общее ────────────────────────────────────────────────────────────────────

function textLines(parent: SVGElement, cx: number, cy: number, lines: string[], className: string): void {
  const lineHeight = 17;
  const start = cy - ((lines.length - 1) * lineHeight) / 2 + 4;
  lines.forEach((line, index) => {
    parent.appendChild(svg('text', { class: className, x: round(cx), y: round(start + index * lineHeight) }, line));
  });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
