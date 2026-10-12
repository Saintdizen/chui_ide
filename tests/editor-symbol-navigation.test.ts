import { describe, expect, it } from 'vitest';
import { locationRows, planNavigation } from '../src/renderer/editor/host/symbol-navigation';

describe('решение по местам символа', () => {
  it('ни одного места — идти некуда', () => {
    expect(planNavigation([])).toEqual({ kind: 'none' });
  });

  it('одно место — прыжок без списка', () => {
    const target = { path: '/src/one.ts', line: 3, column: 5 };
    expect(planNavigation([target])).toEqual({ kind: 'jump', target });
  });

  it('повторы одного места считаются одним — тоже прыжок', () => {
    const target = { path: '/src/one.ts', line: 3, column: 5 };
    expect(planNavigation([target, { ...target }])).toEqual({ kind: 'jump', target });
  });

  it('несколько мест — список, упорядоченный по файлу и позиции', () => {
    const plan = planNavigation([
      { path: '/src/b.ts', line: 9, column: 1 },
      { path: '/src/a.ts', line: 5, column: 2 },
      { path: '/src/a.ts', line: 2, column: 7 },
    ]);
    expect(plan.kind).toBe('list');
    if (plan.kind !== 'list') return;
    expect(plan.targets.map((target) => `${target.path}:${target.line}`)).toEqual([
      '/src/a.ts:2',
      '/src/a.ts:5',
      '/src/b.ts:9',
    ]);
  });
});

describe('строки списка мест', () => {
  it('подпись даёт вызывающий, место — само число строки и столбца', () => {
    const rows = locationRows(
      [
        { path: '/src/a.ts', line: 4, column: 9 },
        { path: '/src/b.ts', line: 1, column: 1 },
      ],
      (target) => target.path.replace('/src/', ''),
    );
    expect(rows).toEqual([
      { label: 'a.ts', detail: '4:9', target: { path: '/src/a.ts', line: 4, column: 9 } },
      { label: 'b.ts', detail: '1:1', target: { path: '/src/b.ts', line: 1, column: 1 } },
    ]);
  });
});
