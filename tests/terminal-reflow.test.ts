import { describe, expect, it } from 'vitest';
import { Terminal } from '../src/renderer/terminal/core/screen';

/**
 * Reflow: пере-перенос содержимого при смене ширины окна. Проверяется без DOM.
 * Главные случаи: сжатие ломает длинную строку на несколько, расширение собирает её
 * обратно, курсор остаётся на своём месте, широкий знак не разрывается, а что не
 * влезло на экран — уходит в историю, а не пропадает.
 */

/** Текст строки экрана без хвостовых пробелов. */
const row = (term: Terminal, index: number): string =>
  (term.line(index)?.cells ?? [])
    .map((cell) => cell.chars)
    .join('')
    .replace(/\s+$/, '');

/** Текст строки истории без хвостовых пробелов. */
const historyRow = (term: Terminal, index: number): string =>
  (term.history()[index]?.cells ?? [])
    .map((cell) => cell.chars)
    .join('')
    .replace(/\s+$/, '');

describe('Terminal: reflow при сжатии', () => {
  it('длинная строка ломается на несколько по новой ширине', () => {
    const term = new Terminal(20, 5);
    term.write('abcdefghij');
    term.resize(4, 5);
    expect(row(term, 0)).toBe('abcd');
    expect(row(term, 1)).toBe('efgh');
    expect(row(term, 2)).toBe('ij');
  });

  it('курсор остаётся сразу за последним знаком', () => {
    const term = new Terminal(20, 5);
    term.write('abcdefghij'); // 10 знаков, курсор за «j» (столбец 10)
    term.resize(4, 5);
    // 10 знаков по 4 в строке: 2 полные строки и ещё 2 знака в третьей.
    expect(term.cursor).toEqual({ x: 2, y: 2 });
  });

  it('содержимое второй строки переезжает, а не теряется', () => {
    const term = new Terminal(20, 5);
    term.write('abcdefghij\r\nXYZ');
    term.resize(4, 5);
    expect(row(term, 2)).toBe('ij');
    expect(row(term, 3)).toBe('XYZ');
  });

  it('широкий знак не разрывается на границе строки', () => {
    const term = new Terminal(20, 5);
    term.write('aあb'); // 1 + 2 + 1 = 4 клетки
    term.resize(2, 5);
    // В строку шириной 2 «a» и широкий знак не влезают вместе: знак уходит на строку 1.
    expect(row(term, 0)).toBe('a');
    expect(row(term, 1)).toBe('あ');
    expect(row(term, 2)).toBe('b');
  });
});

describe('Terminal: reflow при расширении', () => {
  it('перенесённая строка собирается обратно в одну', () => {
    const term = new Terminal(5, 5);
    term.write('abcdefghij'); // при ширине 5 ляжет в две строки
    expect(row(term, 0)).toBe('abcde');
    expect(row(term, 1)).toBe('fghij');
    term.resize(20, 5);
    expect(row(term, 0)).toBe('abcdefghij');
    expect(row(term, 1)).toBe('');
  });

  it('курсор возвращается к концу собранной строки', () => {
    const term = new Terminal(5, 5);
    term.write('abcdefghij');
    term.resize(20, 5);
    expect(term.cursor).toEqual({ x: 10, y: 0 });
  });
});

describe('Terminal: reflow и история', () => {
  it('при сжатии лишние строки уходят в историю, а не пропадают', () => {
    const term = new Terminal(20, 2);
    term.write('abcdefghij'); // одна строка из 10 знаков
    expect(term.history().length).toBe(0);
    term.resize(4, 2); // при ширине 4 — три строки; экран держит две
    expect(term.history().length).toBe(1);
    expect(historyRow(term, 0)).toBe('abcd');
    expect(row(term, 0)).toBe('efgh');
    expect(row(term, 1)).toBe('ij');
  });

  it('при расширении история возвращается на экран', () => {
    const term = new Terminal(20, 2);
    term.write('abcdefghij');
    term.resize(4, 2);
    term.resize(20, 2);
    expect(term.history().length).toBe(0);
    expect(row(term, 0)).toBe('abcdefghij');
  });

  it('история не теряется, когда её снова ужимают', () => {
    const term = new Terminal(20, 2);
    term.write('abcdefgh\r\nIJKL'); // две строки: 8 и 4 знака
    term.resize(4, 2);
    // 8 знаков стали двумя строками по 4, вторая строка добавила третью:
    // на экране только две последние, начало ушло в историю.
    expect(term.history().length).toBe(1);
    expect(historyRow(term, 0)).toBe('abcd');
    expect(row(term, 0)).toBe('efgh');
    expect(row(term, 1)).toBe('IJKL');
  });
});
