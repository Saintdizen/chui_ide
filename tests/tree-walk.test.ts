import { describe, expect, it } from 'vitest';
import { walkTree, type WalkRow } from '../src/renderer/core/tree-walk';

/**
 * Ход по дереву стрелками.
 *
 * Стрелок в проводнике не было ВООБЩЕ: `onTreeKey` знал Enter/F2/Delete/пробел,
 * а обхода не было. Объявить `role="treeitem"` без этого договора значило бы
 * обмануть скринридер — поэтому правило сначала написано здесь, а роль в
 * разметке придёт после.
 */
const row = (path: string, depth: number, directory = false, expanded = false): WalkRow => ({
  path,
  depth,
  directory,
  expanded,
});

// src/ (раскрыта) → a.ts, lib/ (свёрнута), b.ts
const TREE: WalkRow[] = [row('src', 0, true, true), row('src/a.ts', 1), row('src/lib', 1, true, false), row('b.ts', 0)];

describe('соседние строки', () => {
  it('вниз и вверх идут по видимому порядку', () => {
    expect(walkTree(TREE, 'src', 'ArrowDown')).toEqual({ kind: 'move', path: 'src/a.ts' });
    expect(walkTree(TREE, 'src/a.ts', 'ArrowUp')).toEqual({ kind: 'move', path: 'src' });
  });

  it('на краях ничего не происходит — нажатие чужое', () => {
    // Возвращаем null, а не «остаться на месте»: иначе дерево съедало бы
    // стрелку, которая должна уйти дальше (например, в поле поиска).
    expect(walkTree(TREE, 'src', 'ArrowUp')).toBeNull();
    expect(walkTree(TREE, 'b.ts', 'ArrowDown')).toBeNull();
  });

  it('без выделения движение начинает с первой строки', () => {
    expect(walkTree(TREE, null, 'ArrowDown')).toEqual({ kind: 'move', path: 'src' });
  });

  it('Home и End — к краям', () => {
    expect(walkTree(TREE, 'src/lib', 'Home')).toEqual({ kind: 'move', path: 'src' });
    expect(walkTree(TREE, 'src', 'End')).toEqual({ kind: 'move', path: 'b.ts' });
  });
});

describe('вправо и влево', () => {
  it('вправо раскрывает свёрнутую папку', () => {
    expect(walkTree(TREE, 'src/lib', 'ArrowRight')).toEqual({ kind: 'expand', path: 'src/lib' });
  });

  it('вправо у раскрытой уходит к первому ребёнку', () => {
    expect(walkTree(TREE, 'src', 'ArrowRight')).toEqual({ kind: 'move', path: 'src/a.ts' });
  });

  it('вправо на файле ничего не делает', () => {
    expect(walkTree(TREE, 'src/a.ts', 'ArrowRight')).toBeNull();
  });

  it('влево сворачивает раскрытую папку, а не уходит к родителю', () => {
    // Тот же жест значит разное в зависимости от состояния — так в проводниках
    // и в VS Code; перепутать значит сбить человека с толку.
    expect(walkTree(TREE, 'src', 'ArrowLeft')).toEqual({ kind: 'collapse', path: 'src' });
  });

  it('влево на свёрнутой и на файле идёт к родителю', () => {
    expect(walkTree(TREE, 'src/lib', 'ArrowLeft')).toEqual({ kind: 'move', path: 'src' });
    expect(walkTree(TREE, 'src/a.ts', 'ArrowLeft')).toEqual({ kind: 'move', path: 'src' });
  });

  it('влево у свёрнутого корня не уводит в никуда', () => {
    // У корневой строки родителя нет: молча остаться лучше, чем уехать в конец.
    const collapsed = [row('src', 0, true, false)];
    expect(walkTree(collapsed, 'src', 'ArrowLeft')).toBeNull();
  });
});

describe('края', () => {
  it('пустое дерево — любое нажатие чужое', () => {
    expect(walkTree([], null, 'ArrowDown')).toBeNull();
    expect(walkTree([], 'x', 'Enter')).toBeNull();
  });

  it('Enter открывает выбранное', () => {
    expect(walkTree(TREE, 'src/a.ts', 'Enter')).toEqual({ kind: 'open', path: 'src/a.ts' });
  });
});
