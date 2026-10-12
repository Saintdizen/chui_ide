import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import {
  columnAt,
  moveDocEnd,
  moveDocStart,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveSmartLineStart,
  moveVertical,
  moveWordLeft,
  moveWordRight,
} from '../src/renderer/editor/input/motions';

/**
 * Документ:
 *   1: "one two three"   (0..12)
 *   2: "short"           (14..18)
 *   3: "a longer line"   (20..32)
 */
function doc(): TextBuffer {
  return new TextBuffer('one two three\nshort\na longer line');
}

describe('движение по символам', () => {
  it('вправо перешагивает один символ и переходит строку в конце', () => {
    const buffer = doc();
    expect(moveRight(buffer, 0)).toBe(1);
    // Конец первой строки (13 — символ перевода строки, за ним начало второй).
    expect(moveRight(buffer, 13)).toBe(14);
    // В самом конце документа дальше некуда.
    expect(moveRight(buffer, buffer.length)).toBe(buffer.length);
  });

  it('влево переходит в конец предыдущей строки из её начала', () => {
    const buffer = doc();
    expect(moveLeft(buffer, 14)).toBe(13);
    expect(moveLeft(buffer, 1)).toBe(0);
    expect(moveLeft(buffer, 0)).toBe(0);
  });

  it('эмодзи перешагивается целиком, а не половиной суррогатной пары', () => {
    const buffer = new TextBuffer('a😀b');
    // «😀» — две единицы UTF-16: с 1 вправо -> 3 (за эмодзи).
    expect(moveRight(buffer, 1)).toBe(3);
    expect(moveLeft(buffer, 3)).toBe(1);
  });
});

describe('движение по словам', () => {
  it('Ctrl+вправо идёт к концу текущего слова', () => {
    const buffer = doc();
    expect(moveWordRight(buffer, 0)).toBe(3); // конец «one»
    expect(moveWordRight(buffer, 3)).toBe(7); // через пробел — конец «two»
    expect(moveWordRight(buffer, 7)).toBe(13); // конец «three»
    expect(moveWordRight(buffer, 13)).toBe(14); // за конец строки — на следующую
  });

  it('Ctrl+влево идёт к началу текущего слова, от него — к предыдущему', () => {
    const buffer = doc();
    expect(moveWordLeft(buffer, 12)).toBe(8); // внутри «three» — к его началу
    expect(moveWordLeft(buffer, 8)).toBe(4); // от начала «three» — к «two»
    expect(moveWordLeft(buffer, 4)).toBe(0);
  });

  it('промежутки между словами перешагиваются целиком', () => {
    const buffer = new TextBuffer('aa    bb');
    // Из середины длинного пробела вправо — сразу к концу следующего слова.
    expect(moveWordRight(buffer, 2)).toBe(8);
    // И назад по границам слов: конец «bb» → его начало → начало «aa».
    expect(moveWordLeft(buffer, 8)).toBe(6);
    expect(moveWordLeft(buffer, 6)).toBe(0);
  });
});

describe('начало и конец строки', () => {
  it('Home ведёт к началу текста, а от него — к началу строки', () => {
    const buffer = new TextBuffer('    indented\nplain');
    // Стоя в конце текста строки, Home прыгает к первому непробельному знаку...
    expect(moveSmartLineStart(buffer, 11)).toBe(4);
    // ...а уже оттуда — к самому началу строки.
    expect(moveSmartLineStart(buffer, 4)).toBe(0);
  });

  it('End — конец строки без перевода строки', () => {
    const buffer = doc();
    expect(moveLineEnd(buffer, 0)).toBe(13);
    expect(moveLineEnd(buffer, 15)).toBe(19);
  });

  it('начало и конец документа', () => {
    const buffer = doc();
    expect(moveDocStart()).toBe(0);
    expect(moveDocEnd(buffer)).toBe(buffer.length);
  });

  it('начало строки по смещению в середине', () => {
    const buffer = doc();
    expect(moveLineStart(buffer, 25)).toBe(20);
  });
});

describe('вертикальное движение и желаемый столбец', () => {
  it('вниз с короткой строки и обратно вверх возвращает прежний столбец', () => {
    const buffer = doc();
    // Стоим на столбце 10 первой строки (смещение 10).
    const down = moveVertical(buffer, 10, 1, 10);
    // Вторая строка «short» короче — курсор встал на её конце.
    expect(down).toBe(19);
    // Обратно вверх — снова столбец 10.
    expect(moveVertical(buffer, down, -1, 10)).toBe(10);
  });

  it('за края документа не выходит', () => {
    const buffer = doc();
    expect(moveVertical(buffer, 0, -5, 0)).toBe(0);
    expect(moveVertical(buffer, 0, 99, 0)).toBe(buffer.lineStart(3));
  });

  it('столбец прижимается к границе кодовой точки', () => {
    const buffer = new TextBuffer('a😀bc');
    // Желаемый столбец 2 попадает в середину эмодзи — прижимаем влево, к 1.
    expect(moveVertical(buffer, 0, 0, 2)).toBe(1);
  });

  it('столбец по смещению', () => {
    const buffer = doc();
    expect(columnAt(buffer, 15)).toBe(1);
    expect(columnAt(buffer, 19)).toBe(5);
  });
});
