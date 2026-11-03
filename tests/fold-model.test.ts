import { describe, expect, it } from 'vitest';
import { FoldModel } from '../src/renderer/editor/view/fold-model';
import type { FoldRange } from '../src/shared/fold-ranges';

/**
 * Свёртка: «свернуть всё», «свернуть до уровня N» и возврат из сессии.
 *
 * Найдено разбором: `collapseAll` работал, а `collapseToLevel` и
 * `restoreCollapsed` были написаны и НЕ ВЫЗЫВАЛИСЬ НИОТКУДА — мёртвый код.
 * Из-за этого «свернуть уровень» не существовало, а раскрытое состояние не
 * переживало возврат на вкладку.
 */

// Уровни: 1 — внешние функции, 2 — то, что внутри них.
// Блок 0 — внешний, блок 1 ЛЕЖИТ В НЁМ (1 внутри [0, 9]), блок 11 — второй
// внешний, отдельный. Вложенность и есть то, по чему считаются уровни.
const RANGES: FoldRange[] = [
  { startLine: 0, endLine: 9 },
  { startLine: 1, endLine: 4 },
  { startLine: 11, endLine: 15 },
];

const model = () => {
  const m = new FoldModel();
  m.setRanges(RANGES);
  return m;
};

describe('свернуть до уровня', () => {
  it('уровень 1 — только верхние блоки, вложенный остаётся открытым', () => {
    // Свернуть блок — значит спрятать его СОДЕРЖИМОЕ. Свернув внешний, мы уже
    // спрятали и вложенный: складывать его отдельно незачем.
    const m = model();
    m.collapseToLevel(1);
    expect(m.collapsedStarts()).toEqual([0, 11]);
  });

  it('уровень 2 — и вложенные тоже', () => {
    const m = model();
    m.collapseToLevel(2);
    expect(m.collapsedStarts()).toEqual([0, 1, 11]);
  });

  it('уровень выше самого глубокого — складывает всё', () => {
    const m = model();
    m.collapseToLevel(99);
    expect(m.collapsedStarts()).toEqual([0, 1, 11]);
  });

  it('уровень 0 — ничего не сложено', () => {
    // Это не ошибка вызова: ноль — законное «раскрыть всё».
    const m = model();
    m.collapseToLevel(0);
    expect(m.collapsedStarts()).toEqual([]);
  });
});

describe('возврат свёрнутого из сессии', () => {
  it('сложенное вспоминается', () => {
    const m = model();
    m.restoreCollapsed([1, 11]);
    expect(m.collapsedStarts()).toEqual([1, 11]);
  });

  it('несуществующий блок не воскрешает фантома', () => {
    // Номера строк — из старой версии файла: файл мог сжаться.
    const m = model();
    m.restoreCollapsed([1, 999]);
    expect(m.collapsedStarts()).toEqual([1]);
  });

  it('без блоков (`setRanges` ещё не было) восстановление не падает', () => {
    const m = new FoldModel();
    expect(() => m.restoreCollapsed([1, 2])).not.toThrow();
    expect(m.collapsedStarts()).toEqual([]);
  });

  it('восстановление заменяет, а не дополняет', () => {
    // Иначе развёрнутый в прошлый раз файл оставался бы частично сложенным.
    const m = model();
    m.collapseAll();
    m.restoreCollapsed([]);
    expect(m.collapsedStarts()).toEqual([]);
  });
});

describe('свернуть всё по-прежнему работает', () => {
  it('складывает все блоки', () => {
    const m = model();
    m.collapseAll();
    expect(m.collapsedStarts()).toEqual([0, 1, 11]);
  });

  it('развернуть всё — пусто', () => {
    const m = model();
    m.collapseAll();
    m.expandAll();
    expect(m.collapsedStarts()).toEqual([]);
  });
});
