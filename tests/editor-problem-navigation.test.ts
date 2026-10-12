import { describe, expect, it, vi } from 'vitest';
import {
  nextProblem,
  orderProblems,
  ProblemNavigation,
  type ProblemSpot,
} from '../src/renderer/editor/host/problem-navigation';
import type { DiagnosticItem } from '../src/shared/api';

/** Пометка с заполненными полями: в тестах важны только путь и место. */
function problem(
  path: string,
  line: number,
  column = 1,
  severity: DiagnosticItem['severity'] = 'error',
): DiagnosticItem {
  return { path, line, column, severity, message: 'сообщение', source: 'lsp' };
}

describe('порядок пометок', () => {
  it('сортирует по файлу, затем по строке и столбцу', () => {
    const ordered = orderProblems([
      problem('/b.ts', 1),
      problem('/a.ts', 9),
      problem('/a.ts', 2, 5),
      problem('/a.ts', 2, 1),
    ]);
    expect(ordered.map((item) => `${item.path}:${item.line}:${item.column}`)).toEqual([
      '/a.ts:2:1',
      '/a.ts:2:5',
      '/a.ts:9:1',
      '/b.ts:1:1',
    ]);
  });

  it('пустой список — пустой результат', () => {
    expect(orderProblems([])).toEqual([]);
  });
});

describe('поиск следующей и предыдущей пометки', () => {
  const items = [problem('/a.ts', 2), problem('/a.ts', 7), problem('/b.ts', 3)];

  it('следующая — первая после текущего места', () => {
    const target = nextProblem(items, { path: '/a.ts', line: 2, column: 1 }, 'next');
    expect(target).toMatchObject({ path: '/a.ts', line: 7 });
  });

  it('текущее место — пометка: next уходит вперёд, previous — назад', () => {
    expect(nextProblem(items, { path: '/a.ts', line: 7, column: 1 }, 'next')).toMatchObject({ path: '/b.ts', line: 3 });
    expect(nextProblem(items, { path: '/a.ts', line: 7, column: 1 }, 'previous')).toMatchObject({
      path: '/a.ts',
      line: 2,
    });
  });

  it('с последней пометки next сворачивается на первую', () => {
    expect(nextProblem(items, { path: '/b.ts', line: 3, column: 1 }, 'next')).toMatchObject({ path: '/a.ts', line: 2 });
  });

  it('с первой пометки previous сворачивается на последнюю', () => {
    expect(nextProblem(items, { path: '/a.ts', line: 2, column: 1 }, 'previous')).toMatchObject({
      path: '/b.ts',
      line: 3,
    });
  });

  it('нет текущего места — идём к первой (next) или последней (previous)', () => {
    expect(nextProblem(items, null, 'next')).toMatchObject({ path: '/a.ts', line: 2 });
    expect(nextProblem(items, null, 'previous')).toMatchObject({ path: '/b.ts', line: 3 });
  });

  it('пометок нет — идти некуда', () => {
    expect(nextProblem([], { path: '/a.ts', line: 1, column: 1 }, 'next')).toBeNull();
  });

  it('одна пометка: next и previous возвращают её же', () => {
    const one = [problem('/a.ts', 4)];
    expect(nextProblem(one, { path: '/a.ts', line: 4, column: 1 }, 'next')).toMatchObject({ line: 4 });
    expect(nextProblem(one, { path: '/a.ts', line: 4, column: 1 }, 'previous')).toMatchObject({ line: 4 });
  });
});

describe('связка перехода по пометкам', () => {
  function setup(problems: DiagnosticItem[], position: ProblemSpot | null) {
    const revealed: ProblemSpot[] = [];
    const notices: string[] = [];
    const navigation = new ProblemNavigation({
      problems: () => problems,
      position: () => position,
      reveal: (spot) => revealed.push(spot),
      notice: (text) => notices.push(text),
    });
    return { navigation, revealed, notices };
  }

  it('переход вперёд открывает ближайшее место', () => {
    const { navigation, revealed } = setup([problem('/a.ts', 2), problem('/a.ts', 7)], {
      path: '/a.ts',
      line: 2,
      column: 1,
    });
    navigation.next();
    expect(revealed).toEqual([{ path: '/a.ts', line: 7, column: 1 }]);
  });

  it('переход назад идёт по кругу', () => {
    const { navigation, revealed } = setup([problem('/a.ts', 2), problem('/a.ts', 7)], {
      path: '/a.ts',
      line: 2,
      column: 1,
    });
    navigation.previous();
    expect(revealed).toEqual([{ path: '/a.ts', line: 7, column: 1 }]);
  });

  it('пометок нет — перехода нет, но есть сообщение', () => {
    const { navigation, revealed, notices } = setup([], { path: '/a.ts', line: 1, column: 1 });
    navigation.next();
    expect(revealed).toEqual([]);
    expect(notices).toEqual(['Пометок нет']);
  });

  it('без сообщения (оно необязательно) отсутствие пометок не роняет', () => {
    const navigation = new ProblemNavigation({
      problems: () => [],
      position: () => null,
      reveal: vi.fn(),
    });
    expect(() => navigation.next()).not.toThrow();
  });
});
