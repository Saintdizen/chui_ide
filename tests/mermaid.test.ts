import { describe, expect, it } from 'vitest';
import { parseMermaid, parseNodeRef } from '../src/shared/mermaid';
import { layoutMermaid } from '../src/shared/mermaid-layout';

function flow(source: string) {
  const result = parseMermaid(source);
  if (!result.ok || result.diagram.kind !== 'flow') throw new Error('ожидалась блок-схема');
  return result.diagram;
}

function sequence(source: string) {
  const result = parseMermaid(source);
  if (!result.ok || result.diagram.kind !== 'sequence') throw new Error('ожидалась диаграмма последовательностей');
  return result.diagram;
}

describe('разбор ссылки на узел', () => {
  it('читает голое имя без подписи', () => {
    expect(parseNodeRef('Start')).toEqual({ id: 'Start' });
  });

  it('различает формы', () => {
    expect(parseNodeRef('A[прямоугольник]')?.shape).toBe('rect');
    expect(parseNodeRef('B(скруглённый)')?.shape).toBe('round');
    expect(parseNodeRef('C([стадион])')?.shape).toBe('stadium');
    expect(parseNodeRef('D{ромб}')?.shape).toBe('diamond');
    expect(parseNodeRef('E((круг))')?.shape).toBe('circle');
    expect(parseNodeRef('F{{шестиугольник}}')?.shape).toBe('hexagon');
  });

  it('снимает кавычки и переводит <br/> в перевод строки', () => {
    expect(parseNodeRef('A["Много\nслов"]')?.label).toBe('Много\nслов');
    expect(parseNodeRef('A[Раз<br/>Два]')?.label).toBe('Раз\nДва');
  });

  it('отвергает мусор после имени', () => {
    expect(parseNodeRef('A -- текст')).toBeNull();
  });
});

describe('разбор блок-схемы', () => {
  it('берёт направление из заголовка', () => {
    expect(flow('graph LR\nA --> B').direction).toBe('LR');
    expect(flow('flowchart TD\nA --> B').direction).toBe('TD');
    expect(flow('graph TB\nA --> B').direction).toBe('TD');
    expect(flow('graph BT\nA --> B').direction).toBe('BT');
  });

  it('различает виды связей', () => {
    const diagram = flow('graph TD\nA --> B\nB --- C\nC -.-> D\nD ==> E\nE === F');
    const [ab, bc, cd, de, ef] = diagram.edges;
    expect(ab).toMatchObject({ from: 'A', to: 'B', dashed: false, thick: false, head: true });
    expect(bc).toMatchObject({ from: 'B', to: 'C', head: false });
    expect(cd).toMatchObject({ from: 'C', to: 'D', dashed: true, head: true });
    expect(de).toMatchObject({ from: 'D', to: 'E', thick: true, head: true });
    expect(ef).toMatchObject({ from: 'E', to: 'F', thick: true, head: false });
  });

  it('читает подпись связи в трубах и между знаками', () => {
    const withPipe = flow('graph TD\nA -->|да| B');
    expect(withPipe.edges[0]).toMatchObject({ from: 'A', to: 'B', label: 'да' });
    const inline = flow('graph TD\nA -- нет --> B');
    expect(inline.edges[0]).toMatchObject({ from: 'A', to: 'B', label: 'нет' });
  });

  it('разворачивает цепочку в отдельные связи', () => {
    const diagram = flow('graph LR\nA --> B --> C');
    expect(diagram.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(['A->B', 'B->C']);
    expect(diagram.nodes.map((node) => node.id)).toEqual(['A', 'B', 'C']);
  });

  it('собирает узлы подграфа по первому упоминанию', () => {
    const diagram = flow('graph TD\nsubgraph core["Ядро"]\nA[Один]\nB[Два]\nend\nA --> B');
    expect(diagram.subgraphs).toHaveLength(1);
    expect(diagram.subgraphs[0]).toMatchObject({ title: 'Ядро', nodes: ['A', 'B'] });
    expect(diagram.nodes.find((node) => node.id === 'A')?.label).toBe('Один');
  });

  it('игнорирует комментарии и служебные строки', () => {
    const diagram = flow('graph TD\n%% это комментарий\nclassDef red fill:#f00\nA --> B\nlinkStyle 0 stroke:#0f0');
    expect(diagram.nodes).toHaveLength(2);
    expect(diagram.edges).toHaveLength(1);
  });

  it('честно сообщает о неподдержанном виде', () => {
    const result = parseMermaid('classDiagram\nclass A');
    expect(result.ok).toBe(false);
  });
});

describe('разбор диаграммы последовательностей', () => {
  it('берёт участников в порядке появления и роль актёра', () => {
    const diagram = sequence('sequenceDiagram\nactor User\nparticipant Sys as Система\nUser->>Sys: вход');
    expect(diagram.participants.map((part) => part.id)).toEqual(['User', 'Sys']);
    expect(diagram.participants[0]?.actor).toBe(true);
    expect(diagram.participants[1]?.label).toBe('Система');
  });

  it('различает сплошные и пунктирные сообщения, ловит самосообщение', () => {
    const diagram = sequence('sequenceDiagram\nA->>B: вопрос\nB-->>A: ответ\nA->>A: размышление');
    const [ask, answer, self] = diagram.items;
    expect(ask).toMatchObject({ kind: 'message', from: 'A', to: 'B', dashed: false, self: false });
    expect(answer).toMatchObject({ kind: 'message', dashed: true });
    expect(self).toMatchObject({ kind: 'message', self: true });
  });

  it('вкладывает сообщения в блок loop', () => {
    const diagram = sequence('sequenceDiagram\nA->>B: раз\nloop пока\nB-->>A: два\nend');
    expect(diagram.items).toHaveLength(2);
    const fragment = diagram.items[1];
    expect(fragment?.kind).toBe('fragment');
    if (fragment?.kind === 'fragment') expect(fragment.items).toHaveLength(1);
  });

  it('читает заметку над участниками', () => {
    const diagram = sequence('sequenceDiagram\nA->>B: hi\nNote over A,B: помни');
    const note = diagram.items[1];
    expect(note?.kind).toBe('note');
    if (note?.kind === 'note') expect(note.over).toEqual(['A', 'B']);
  });
});

describe('разбор круговой диаграммы', () => {
  it('читает доли, заголовок и признак showData', () => {
    const result = parseMermaid('pie showData title Питомцы\n"Dogs" : 3\n"Cats" : 1');
    if (!result.ok || result.diagram.kind !== 'pie') throw new Error('ожидалась круговая диаграмма');
    expect(result.diagram.showData).toBe(true);
    expect(result.diagram.title).toBe('Питомцы');
    expect(result.diagram.slices).toEqual([
      { label: 'Dogs', value: 3 },
      { label: 'Cats', value: 1 },
    ]);
  });
});

describe('раскладка блок-схемы', () => {
  it('кладовка сверху вниз: исток выше цели', () => {
    const layout = layoutMermaid(flow('graph TD\nA --> B --> C'));
    const a = layout.nodes.find((node) => node.id === 'A');
    const b = layout.nodes.find((node) => node.id === 'B');
    const c = layout.nodes.find((node) => node.id === 'C');
    expect((a?.y ?? 0) < (b?.y ?? 0)).toBe(true);
    expect((b?.y ?? 0) < (c?.y ?? 0)).toBe(true);
  });

  it('кладовка слева направо: исток левее цели', () => {
    const layout = layoutMermaid(flow('graph LR\nA --> B'));
    const a = layout.nodes.find((node) => node.id === 'A');
    const b = layout.nodes.find((node) => node.id === 'B');
    expect((a?.x ?? 0) < (b?.x ?? 0)).toBe(true);
  });

  it('снизу вверх — зеркало сверху вниз', () => {
    const layout = layoutMermaid(flow('graph BT\nA --> B'));
    const a = layout.nodes.find((node) => node.id === 'A');
    const b = layout.nodes.find((node) => node.id === 'B');
    expect((a?.y ?? 0) > (b?.y ?? 0)).toBe(true);
  });

  it('все узлы и связи остаются внутри габаритов', () => {
    const layout = layoutMermaid(flow('graph TD\nA --> B\nB --> C\nA --> C\nA --> A'));
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width + 0.5);
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height + 0.5);
    }
    for (const edge of layout.edges) {
      for (const point of edge.points) {
        expect(point.x).toBeGreaterThanOrEqual(-0.5);
        expect(point.y).toBeGreaterThanOrEqual(-0.5);
      }
    }
  });

  it('подпись связи ложится на её середину', () => {
    const layout = layoutMermaid(flow('graph TD\nA -->|да| B'));
    const edge = layout.edges[0];
    expect(edge?.label).toBe('да');
    expect(edge?.labelX).toBeTypeOf('number');
    expect(edge?.labelWidth).toBeGreaterThan(0);
  });
});

describe('раскладка диаграммы последовательностей', () => {
  it('участники стоят столбцами, сообщения идут по строкам', () => {
    const layout = layoutMermaid(sequence('sequenceDiagram\nA->>B: раз\nB-->>A: два'));
    expect(layout.kind).toBe('sequence');
    expect(layout.participants).toHaveLength(2);
    expect(layout.messages).toHaveLength(2);
    expect(layout.messages[0]!.y).toBeLessThan(layout.messages[1]!.y);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('блок loop получает рамку', () => {
    const layout = layoutMermaid(sequence('sequenceDiagram\nA->>B: раз\nloop пока\nB-->>A: два\nend'));
    expect(layout.frames).toHaveLength(1);
    expect(layout.frames[0]!.height).toBeGreaterThan(0);
  });
});

describe('раскладка круговой диаграммы', () => {
  it('доли покрывают полный круг', () => {
    const result = parseMermaid('pie\n"A" : 1\n"B" : 1\n"C" : 2');
    if (!result.ok || result.diagram.kind !== 'pie') throw new Error('ожидалась круговая диаграмма');
    const layout = layoutMermaid(result.diagram);
    if (layout.kind !== 'pie') throw new Error('ожидалась круговая раскладка');
    const sweep = layout.slices.reduce((sum, slice) => sum + (slice.end - slice.start), 0);
    expect(sweep).toBeCloseTo(Math.PI * 2, 5);
    for (const slice of layout.slices) expect(slice.path.startsWith('M')).toBe(true);
  });
});
