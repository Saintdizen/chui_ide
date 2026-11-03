import { describe, expect, it } from 'vitest';
import { ariaPositions, type AriaRow } from '../src/renderer/core/tree-aria';

/**
 * Место строки в дереве для читалки: уровень, номер среди соседей, сколько их.
 *
 * Без `aria-setsize`/`aria-posinset` читалка не говорит «3 из 12» — а человек
 * без этого не понимает, сколько ещё листать. Считать надо ПО РОДИТЕЛЮ: «3 из
 * 12» у ребёнка значит совсем не то, что у корня.
 */
const r = (path: string, depth: number): AriaRow => ({ path, depth });

const TREE: AriaRow[] = [r('src', 0), r('src/a.ts', 1), r('src/lib', 1), r('src/lib/x.ts', 2), r('b.ts', 0)];

describe('уровень', () => {
  it('корень — первый, глубина не уходит в ноль', () => {
    // `aria-level` 1-based: нулевого уровня в ARIA нет, читалка бы промолчала.
    expect(ariaPositions(TREE).get('src')?.level).toBe(1);
    expect(ariaPositions(TREE).get('src/lib/x.ts')?.level).toBe(3);
  });
});

describe('место среди соседей', () => {
  it('считается по родителю, а не по всему дереву', () => {
    const places = ariaPositions(TREE);
    // Дети `src`: a.ts — 1, lib — 2.
    expect(places.get('src/a.ts')).toMatchObject({ posInSet: 1, setSize: 2 });
    expect(places.get('src/lib')).toMatchObject({ posInSet: 2, setSize: 2 });
    // Единственный ребёнок `src/lib`.
    expect(places.get('src/lib/x.ts')).toMatchObject({ posInSet: 1, setSize: 1 });
  });

  it('корни — свой набор, отдельный от детей', () => {
    const places = ariaPositions(TREE);
    expect(places.get('src')).toMatchObject({ posInSet: 1, setSize: 2 });
    expect(places.get('b.ts')).toMatchObject({ posInSet: 2, setSize: 2 });
  });

  it('родство по глубине, а не по «соседству» строк', () => {
    // a.ts и b.ts идут далеко друг от друга и разной вложенности — разными
    // родителями их считать нельзя перепутать.
    const rows: AriaRow[] = [r('a', 0), r('a/1', 1), r('a/2', 1), r('b', 0), r('b/1', 1)];
    const places = ariaPositions(rows);
    expect(places.get('a/1')).toMatchObject({ posInSet: 1, setSize: 2 });
    expect(places.get('b/1')).toMatchObject({ posInSet: 1, setSize: 1 });
  });

  it('свёрнутая папка: невидимые дети в набор не попадают', () => {
    // Таблица строится по ВИДИМЫМ строкам, поэтому у свёрнутой папки
    // ребёнка в ней просто нет — и setSize родителя меньше.
    const collapsed: AriaRow[] = [r('src', 0), r('b.ts', 0)];
    expect(ariaPositions(collapsed).get('src')).toMatchObject({ posInSet: 1, setSize: 2 });
  });

  it('пустое дерево — пустая таблица', () => {
    expect(ariaPositions([]).size).toBe(0);
  });
});
