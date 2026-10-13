import { describe, expect, it } from 'vitest';
import {
  clickSelection,
  EMPTY_SELECTION,
  isSelected,
  normalizeSelection,
  type TreeSelection,
} from '../src/renderer/core/tree-selection';

const ORDER = ['/p/src', '/p/src/a.ts', '/p/src/b.ts', '/p/README.md', '/p/tests'];

const pick = (...paths: string[]): TreeSelection => ({ paths, anchor: paths.at(-1) ?? null });

/**
 * Выделение в дереве: обычный клик, точечное добавление и диапазон. Порядок
 * путей — порядок строк дерева, а не порядок кликов: операции над выделением
 * идут сверху вниз.
 */
describe('clickSelection: обычный клик', () => {
  it('оставляет одну строку и делает её якорем', () => {
    expect(clickSelection(pick('/p/src', '/p/tests'), ORDER, '/p/README.md', 'single')).toEqual(pick('/p/README.md'));
  });
});

describe('clickSelection: точечное добавление (Ctrl/Cmd)', () => {
  it('добавляет путь в порядке дерева, даже если кликнули выше', () => {
    const next = clickSelection(pick('/p/README.md'), ORDER, '/p/src', 'toggle');
    expect(next.paths).toEqual(['/p/src', '/p/README.md']);
    expect(next.anchor).toBe('/p/src');
  });

  it('повторный клик снимает выделение', () => {
    const next = clickSelection(pick('/p/src', '/p/README.md'), ORDER, '/p/src', 'toggle');
    expect(next.paths).toEqual(['/p/README.md']);
  });

  it('путь вне дерева сохраняется, а не теряется', () => {
    const next = clickSelection(pick('/p/src'), ORDER, '/p/чересчур', 'toggle');
    expect(next.paths).toEqual(['/p/src', '/p/чересчур']);
  });
});

describe('clickSelection: диапазон (Shift)', () => {
  it('берёт всё от якоря до кликнутой строки включительно', () => {
    const next = clickSelection(pick('/p/src/a.ts'), ORDER, '/p/README.md', 'range');
    expect(next.paths).toEqual(['/p/src/a.ts', '/p/src/b.ts', '/p/README.md']);
    expect(next.anchor).toBe('/p/src/a.ts');
  });

  it('диапазон назад — тот же набор, что вперёд', () => {
    const forward = clickSelection(pick('/p/src/a.ts'), ORDER, '/p/tests', 'range');
    const backward = clickSelection(pick('/p/tests'), ORDER, '/p/src/a.ts', 'range');
    expect(backward.paths).toEqual(forward.paths);
  });

  it('без якоря диапазон вырождается в одну строку', () => {
    expect(clickSelection(EMPTY_SELECTION, ORDER, '/p/src/b.ts', 'range')).toEqual(pick('/p/src/b.ts'));
  });

  it('якорь вне видимых строк — тоже одна строка', () => {
    const next = clickSelection(pick('/p/свернутый/файл'), ORDER, '/p/src', 'range');
    expect(next.paths).toEqual(['/p/src']);
    expect(next.anchor).toBe('/p/src');
  });
});

describe('normalizeSelection', () => {
  it('выбрасывает исчезнувшие пути и чинит якорь', () => {
    const next = normalizeSelection(pick('/p/src', '/p/пропал'), new Set(['/p/src']));
    expect(next.paths).toEqual(['/p/src']);
    expect(next.anchor).toBe('/p/src');
  });

  it('пустой набор остаётся пустым', () => {
    expect(normalizeSelection(EMPTY_SELECTION, new Set(['/p/src']))).toEqual(EMPTY_SELECTION);
  });
});

describe('isSelected', () => {
  it('знает про путь в наборе', () => {
    expect(isSelected(pick('/p/src'), '/p/src')).toBe(true);
    expect(isSelected(pick('/p/src'), '/p/tests')).toBe(false);
  });
});
