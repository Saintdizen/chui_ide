import { describe, expect, it } from 'vitest';
import { toCallHierarchyNodes, toIncomingCalls, toOutgoingCalls } from '../src/shared/lsp-call-hierarchy';

/**
 * Разбор ответов LSP про иерархию вызовов. Правило, а не запуск: у серверов форма
 * одна и та же, и проверяем именно разбор — что вытаскиваем узлы, места вызова и
 * сохраняем `data`, без которого часть серверов не поймёт запрос вызовов.
 */

const node = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'run',
  kind: 12,
  uri: 'file:///proj/a.ts',
  range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } },
  selectionRange: { start: { line: 4, character: 6 }, end: { line: 4, character: 9 } },
  ...over,
});

describe('toCallHierarchyNodes', () => {
  it('читает один узел и сохраняет диапазоны и data', () => {
    const result = toCallHierarchyNodes([node({ data: { id: 7 } })]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'run', kind: 12, uri: 'file:///proj/a.ts', data: { id: 7 } });
    expect(result[0]!.range.start).toEqual({ line: 4, character: 0 });
  });

  it('одиночный объект вместо массива тоже принимается', () => {
    expect(toCallHierarchyNodes(node())).toHaveLength(1);
  });

  it('без селект-диапазона берётся полный', () => {
    const raw = node();
    delete raw.selectionRange;

    const result = toCallHierarchyNodes([raw]);

    expect(result[0]!.selectionRange).toEqual(result[0]!.range);
  });

  it('битые записи пропускаются, а не ломают разбор', () => {
    const result = toCallHierarchyNodes([null, {}, { name: 'x' }, { name: 'x', uri: 'u', range: {} }, node()]);

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('run');
  });

  it('пустой ответ — пустой список', () => {
    expect(toCallHierarchyNodes(null)).toEqual([]);
    expect(toCallHierarchyNodes([])).toEqual([]);
  });
});

describe('toIncomingCalls / toOutgoingCalls', () => {
  const range = { start: { line: 9, character: 2 }, end: { line: 9, character: 5 } };

  it('входящие берут узел из from и места вызова', () => {
    const result = toIncomingCalls([{ from: node({ name: 'caller' }), fromRanges: [range] }]);

    expect(result).toHaveLength(1);
    expect(result[0]!.node.name).toBe('caller');
    expect(result[0]!.fromRanges).toEqual([range]);
  });

  it('исходящие берут узел из to', () => {
    const result = toOutgoingCalls([{ to: node({ name: 'callee' }), fromRanges: [range] }]);

    expect(result[0]!.node.name).toBe('callee');
  });

  it('записи без узла или с битым узлом пропускаются', () => {
    const result = toIncomingCalls([{ from: {}, fromRanges: [range] }, { fromRanges: [range] }, { from: node() }]);

    expect(result).toHaveLength(1);
  });

  it('битые диапазоны вызова отбрасываются, узел остаётся', () => {
    const result = toIncomingCalls([{ from: node(), fromRanges: [null, range, 42] }]);

    expect(result[0]!.fromRanges).toEqual([range]);
  });

  it('не-массив — пустой список', () => {
    expect(toIncomingCalls(null)).toEqual([]);
    expect(toOutgoingCalls({})).toEqual([]);
  });
});
