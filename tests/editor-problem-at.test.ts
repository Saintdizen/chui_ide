import { describe, expect, it } from 'vitest';
import { problemsAt } from '../src/renderer/editor/hover/problem-at';

/** Пометка в том виде, в каком её ищет карточка наведения. */
const marker = (over: Partial<Parameters<typeof problemsAt>[0][number]> & { line: number; column: number }) => ({
  endLine: over.line,
  endColumn: over.column + 1,
  severity: 'error' as const,
  message: 'сообщение',
  ...over,
});

describe('problemsAt', () => {
  it('находит пометку, накрывающую позицию', () => {
    const markers = [marker({ line: 3, column: 5, endColumn: 9, message: 'тут беда' })];
    expect(problemsAt(markers, { line: 3, column: 5 }).map((m) => m.message)).toEqual(['тут беда']);
    expect(problemsAt(markers, { line: 3, column: 8 })).toHaveLength(1);
    // Конец участка исключающий: за ним пометки уже нет.
    expect(problemsAt(markers, { line: 3, column: 9 })).toHaveLength(0);
  });

  it('чужая строка не подходит', () => {
    const markers = [marker({ line: 3, column: 5, endColumn: 9 })];
    expect(problemsAt(markers, { line: 4, column: 5 })).toHaveLength(0);
  });

  it('несколько пометок в одной точке отдаются все', () => {
    const markers = [
      marker({ line: 1, column: 1, endColumn: 5, message: 'первая' }),
      marker({ line: 1, column: 3, endColumn: 7, message: 'вторая' }),
    ];
    expect(problemsAt(markers, { line: 1, column: 3 }).map((m) => m.message)).toEqual(['первая', 'вторая']);
  });

  it('вырожденная пометка (конец равен началу) накрывает хотя бы свой знак', () => {
    const markers = [marker({ line: 2, column: 4, endColumn: 4 })];
    expect(problemsAt(markers, { line: 2, column: 4 })).toHaveLength(1);
  });
});
