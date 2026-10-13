import { describe, expect, it } from 'vitest';
import { toTypeHierarchyItems, toTypeHierarchyNodes, typeHierarchyMethod } from '../src/shared/lsp-type-hierarchy';

/**
 * Разбор ответов LSP про иерархию типов. Узел — та же форма, что у иерархии вызовов,
 * поэтому проверяем и сам разбор, и то, что надтипы/подтипы читаются как список узлов
 * (а не как пары «узел + места вызова»).
 */

const node = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Base',
  kind: 5,
  uri: 'file:///proj/a.ts',
  range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
  selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
  ...over,
});

describe('разбор иерархии типов', () => {
  it('prepare отдаёт узел, как и у вызовов', () => {
    const result = toTypeHierarchyNodes([node({ data: { id: 1 } })]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'Base', kind: 5, uri: 'file:///proj/a.ts', data: { id: 1 } });
  });

  it('надтипы и подтипы — просто список узлов', () => {
    const result = toTypeHierarchyItems([node({ name: 'A' }), node({ name: 'B' })]);

    expect(result.map((item) => item.name)).toEqual(['A', 'B']);
  });

  it('одиночный узел вместо массива тоже принимается', () => {
    expect(toTypeHierarchyItems(node({ name: 'Solo' }))).toHaveLength(1);
  });

  it('битые записи пропускаются, а не ломают разбор', () => {
    expect(toTypeHierarchyItems([null, {}, { name: 'x' }, node()])).toHaveLength(1);
  });

  it('пустой ответ — пустой список', () => {
    expect(toTypeHierarchyItems(null)).toEqual([]);
    expect(toTypeHierarchyItems([])).toEqual([]);
    expect(toTypeHierarchyNodes(undefined)).toEqual([]);
  });

  it('имя метода LSP — по направлению', () => {
    expect(typeHierarchyMethod('supertypes')).toBe('typeHierarchy/supertypes');
    expect(typeHierarchyMethod('subtypes')).toBe('typeHierarchy/subtypes');
  });
});
