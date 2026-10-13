import { describe, expect, it } from 'vitest';
import { compareLabel, pairFromSelection } from '../src/renderer/core/file-compare';

/**
 * Пара для сравнения из выделения дерева и подпись этой пары. Отдельно от
 * интерфейса: у сравнения два входа («выделенные» и «с выбранным»), и оба должны
 * понимать, что пары нет, одинаково.
 */
describe('pairFromSelection', () => {
  it('два пути дают пару', () => {
    expect(pairFromSelection(['/p/a.ts', '/p/b.ts'])).toEqual({ left: '/p/a.ts', right: '/p/b.ts' });
  });

  it('из трёх путей берём первые два', () => {
    expect(pairFromSelection(['/p/a.ts', '/p/b.ts', '/p/c.ts'])).toEqual({ left: '/p/a.ts', right: '/p/b.ts' });
  });

  it('одного пути мало', () => {
    expect(pairFromSelection(['/p/a.ts'])).toBeNull();
  });

  it('пустое выделение — пары нет', () => {
    expect(pairFromSelection([])).toBeNull();
  });

  it('один и тот же путь дважды не сравниваем', () => {
    expect(pairFromSelection(['/p/a.ts', '/p/a.ts'])).toBeNull();
  });
});

describe('compareLabel', () => {
  it('разные имена — по именам', () => {
    expect(compareLabel({ left: '/p/src/a.ts', right: '/p/lib/b.ts' })).toBe('a.ts ↔ b.ts');
  });

  it('одинаковые имена — по хвосту пути', () => {
    expect(compareLabel({ left: '/p/src/index.ts', right: '/p/lib/index.ts' })).toBe('src/index.ts ↔ lib/index.ts');
  });

  it('путь из одного сегмента остаётся как есть', () => {
    expect(compareLabel({ left: 'index.ts', right: 'lib/index.ts' })).toBe('index.ts ↔ lib/index.ts');
  });
});
