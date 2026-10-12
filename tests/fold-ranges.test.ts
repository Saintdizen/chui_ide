import { describe, expect, it } from 'vitest';
import {
  enclosingFoldRanges,
  foldStartingAt,
  indentFoldRanges,
  isFoldStart,
  mergeFoldRanges,
  toFoldRanges,
} from '../src/shared/fold-ranges';
import { FoldModel } from '../src/renderer/editor/view/fold-model';

describe('разбор диапазонов свёртки от сервера', () => {
  it('переводит строки из 0-based в 1-based', () => {
    expect(
      toFoldRanges([
        { startLine: 0, endLine: 4 },
        { startLine: 6, endLine: 7 },
      ]),
    ).toEqual([
      { startLine: 1, endLine: 5 },
      { startLine: 7, endLine: 8 },
    ]);
  });

  it('диапазон без конца или на одну строку ничего не сворачивает', () => {
    expect(toFoldRanges([{ startLine: 1 }, { startLine: 2, endLine: 2 }, { endLine: 5 }])).toEqual([]);
  });

  it('мусор и не-список пропускаются', () => {
    expect(toFoldRanges(null)).toEqual([]);
    expect(toFoldRanges('нет')).toEqual([]);
    expect(toFoldRanges([null, 5, { startLine: 'a', endLine: 'b' }])).toEqual([]);
  });
});

describe('свёртка по отступам', () => {
  const text = ['def f():', '    a = 1', '    if a:', '        b = 2', '    return b', '', 'def g():', '    pass'].join(
    '\n',
  );

  it('блок — строка и всё, что ниже с большим отступом', () => {
    expect(indentFoldRanges(text)).toEqual([
      { startLine: 1, endLine: 5 },
      { startLine: 3, endLine: 4 },
      { startLine: 7, endLine: 8 },
    ]);
  });

  it('табуляция считается по размеру отступа', () => {
    expect(indentFoldRanges('if x:\n\ta\n\tb\nc', 4)).toEqual([{ startLine: 1, endLine: 3 }]);
  });

  it('пустые строки внутри блока не растягивают его в конец', () => {
    expect(indentFoldRanges('a\n    b\n\n\nc')).toEqual([{ startLine: 1, endLine: 2 }]);
  });

  it('файл без отступов и пустой файл сворачивать нечего', () => {
    expect(indentFoldRanges('a\nb\nc')).toEqual([]);
    expect(indentFoldRanges('')).toEqual([]);
  });
});

describe('порядок и поиск диапазона', () => {
  const ranges = mergeFoldRanges([
    { startLine: 3, endLine: 8 },
    { startLine: 1, endLine: 9 },
    { startLine: 3, endLine: 8 },
    { startLine: 5, endLine: 5 },
  ]);

  it('сортировка по началу, при равном начале — длинный вперёд', () => {
    expect(ranges).toEqual([
      { startLine: 1, endLine: 9 },
      { startLine: 3, endLine: 8 },
    ]);
  });

  it('у строки находится самый длинный из начинающихся на ней блоков', () => {
    expect(foldStartingAt(ranges, 1)).toEqual({ startLine: 1, endLine: 9 });
    expect(foldStartingAt(ranges, 2)).toBeNull();
    expect(isFoldStart(ranges, 3)).toBe(true);
  });
});

/**
 * Цепочка вмещающих блоков — по ней sticky scroll решает, какие заголовки приколоть.
 * Порядок важен: от внешнего к вложенному — так заголовки и идут сверху вниз.
 */
describe('вмещающие блоки (для закреплённых заголовков)', () => {
  const ranges = mergeFoldRanges([
    { startLine: 1, endLine: 20 },
    { startLine: 5, endLine: 15 },
    { startLine: 8, endLine: 12 },
  ]);

  it('от внешнего к вложенному', () => {
    expect(enclosingFoldRanges(ranges, 10)).toEqual([
      { startLine: 1, endLine: 20 },
      { startLine: 5, endLine: 15 },
      { startLine: 8, endLine: 12 },
    ]);
  });

  it('блок, начинающийся на этой строке, не прикалывается (его заголовок и так виден)', () => {
    expect(enclosingFoldRanges(ranges, 5)).toEqual([{ startLine: 1, endLine: 20 }]);
  });

  it('вне блоков — пусто; на последней строке блока — только он и внешние', () => {
    expect(enclosingFoldRanges(ranges, 25)).toEqual([]);
    expect(enclosingFoldRanges(ranges, 12)).toEqual([
      { startLine: 1, endLine: 20 },
      { startLine: 5, endLine: 15 },
      { startLine: 8, endLine: 12 },
    ]);
    // Строка после конца вложенного, но внутри внешнего.
    expect(enclosingFoldRanges(ranges, 16)).toEqual([{ startLine: 1, endLine: 20 }]);
  });
});

describe('ряды экрана со свёрнутыми строками', () => {
  /** Блок 2–5: строки 3, 4, 5 скрыты — три строки. */
  const model = new FoldModel();
  model.setRanges([
    { startLine: 2, endLine: 5 },
    { startLine: 8, endLine: 9 },
  ]);

  it('пока ничего не сложено, ряд совпадает со строкой', () => {
    expect(model.rowOf(1)).toBe(0);
    expect(model.rowOf(6)).toBe(5);
    expect(model.lineAtRow(5)).toBe(6);
    expect(model.rowCount(10)).toBe(10);
  });

  it('схлопнутый блок убирает ряды, а строка-заголовок остаётся', () => {
    expect(model.toggle(2)).toBe(true);
    expect(model.isHidden(2)).toBe(false);
    expect(model.isHidden(3)).toBe(true);
    expect(model.isHidden(5)).toBe(true);
    expect(model.isHidden(6)).toBe(false);
    expect(model.rowOf(6)).toBe(2);
    expect(model.lineAtRow(2)).toBe(6);
    expect(model.rowCount(10)).toBe(7);
  });

  it('два схлопнутых блока складываются', () => {
    model.toggle(8); // скрыта только строка 9 — блок из двух строк
    expect(model.rowOf(10)).toBe(5);
    expect(model.lineAtRow(5)).toBe(10);
    expect(model.rowCount(10)).toBe(6);
  });

  it('свёрнутое внутри свёрнутого не считается дважды', () => {
    model.toggle(2);
    model.toggle(8);
    const nested = new FoldModel();
    nested.setRanges([
      { startLine: 1, endLine: 10 },
      { startLine: 3, endLine: 4 },
    ]);
    nested.toggle(1);
    nested.toggle(3);
    expect(nested.rowCount(10)).toBe(1);
    expect(nested.lineAtRow(0)).toBe(1);
    expect(nested.lineAtRow(1)).toBe(11); // за концом документа — «после последней строки»
  });

  it('раскрытие возвращает прежние ряды', () => {
    model.expandAll();
    expect(model.rowCount(10)).toBe(10);
    expect(model.collapsedStarts()).toEqual([]);
  });

  it('смена диапазонов сохраняет схлопнутое, но забывает исчезнувшее', () => {
    model.toggle(2);
    model.setRanges([{ startLine: 2, endLine: 5 }]);
    expect(model.isCollapsed(2)).toBe(true);
    expect(model.rowCount(10)).toBe(7);
    model.setRanges([{ startLine: 4, endLine: 6 }]);
    expect(model.isCollapsed(2)).toBe(false);
    expect(model.rowCount(10)).toBe(10);
  });

  it('сложить всё — по одному разу на блок', () => {
    model.reset();
    model.setRanges([
      { startLine: 2, endLine: 5 },
      { startLine: 8, endLine: 9 },
    ]);
    model.collapseAll();
    expect(model.collapsedStarts()).toEqual([2, 8]);
    expect(model.rowCount(10)).toBe(10 - 3 - 1);
  });

  it('новый файл очищает и диапазоны, и схлопнутое', () => {
    model.reset();
    expect(model.all).toEqual([]);
    expect(model.rowCount(10)).toBe(10);
  });
});
