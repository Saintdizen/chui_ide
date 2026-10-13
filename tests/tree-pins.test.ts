import { describe, expect, it } from 'vitest';
import { isPinned, MAX_PINNED, normalizePins, togglePin } from '../src/renderer/core/tree-pins';

/**
 * Закреплённые пути дерева: список живёт в сессии проекта. Порядок закрепления
 * сохраняется — человек сам решает, что выше.
 */
describe('togglePin', () => {
  it('закрепляет новый путь в конец', () => {
    expect(togglePin(['/p/a.ts'], '/p/b.ts')).toEqual(['/p/a.ts', '/p/b.ts']);
  });

  it('повторное закрепление снимает и не двигает остальные', () => {
    expect(togglePin(['/p/a.ts', '/p/b.ts'], '/p/a.ts')).toEqual(['/p/b.ts']);
  });

  it('перезакрепление не поднимает путь вверх', () => {
    const list = ['/p/a.ts', '/p/b.ts'];
    expect(togglePin(togglePin(list, '/p/a.ts'), '/p/a.ts')).toEqual(['/p/b.ts', '/p/a.ts']);
  });

  it('больше предела не набирается', () => {
    const many = Array.from({ length: MAX_PINNED }, (_, index) => `/p/${index}.ts`);
    const next = togglePin(many, '/p/лишний.ts');
    expect(next).toHaveLength(MAX_PINNED);
    expect(next).not.toContain('/p/лишний.ts');
  });
});

describe('isPinned', () => {
  it('знает про путь в списке', () => {
    expect(isPinned(['/p/a.ts'], '/p/a.ts')).toBe(true);
    expect(isPinned(['/p/a.ts'], '/p/b.ts')).toBe(false);
  });
});

describe('normalizePins', () => {
  it('выбрасывает пути вне проекта', () => {
    expect(normalizePins(['/p/a.ts', '/другой/b.ts'], '/p')).toEqual(['/p/a.ts']);
  });

  it('сосед по префиксу не считается своим', () => {
    // «/proj-2» не лежит внутри «/proj», хотя и начинается так же.
    expect(normalizePins(['/proj-2/b.ts'], '/proj')).toEqual([]);
  });

  it('без проекта список пуст', () => {
    expect(normalizePins(['/p/a.ts'], null)).toEqual([]);
  });
});
