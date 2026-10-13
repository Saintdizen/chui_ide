import { describe, expect, it } from 'vitest';
import { cellRange, searchBuffer, stepMatch } from '../src/renderer/terminal/core/search';

/**
 * Поиск по ленте терминала: места совпадений, перевод знаков в клетки и переход по
 * кругу. Правило чистое, проверяется без окна. Главные случаи: регистр, регулярка,
 * слово целиком, широкая клетка в границах и ход «вперёд/назад по кругу».
 */

const lines = ['hello world', 'Hello THERE', 'foo bar baz'];
const getLine = (row: number) => lines[row] ?? '';

describe('searchBuffer', () => {
  it('находит все вхождения подстроки', () => {
    const { matches } = searchBuffer(getLine, lines.length, 'o');
    expect(matches.map((match) => [match.row, match.start])).toEqual([
      [0, 4],
      [0, 7],
      [1, 4],
      [2, 1],
      [2, 2],
    ]);
  });

  it('регистр по умолчанию не важен', () => {
    const { matches } = searchBuffer(getLine, lines.length, 'hello');
    expect(matches.map((match) => match.row)).toEqual([0, 1]);
  });

  it('регистр учитывается по настройке', () => {
    const { matches } = searchBuffer(getLine, lines.length, 'hello', { caseSensitive: true });
    expect(matches.map((match) => match.row)).toEqual([0]);
  });

  it('слово целиком не ловит часть', () => {
    const { matches } = searchBuffer(getLine, lines.length, 'oo', { wholeWord: true });
    expect(matches).toEqual([]);
  });

  it('регулярка работает, недописанная — сообщает об ошибке', () => {
    expect(searchBuffer(getLine, lines.length, 'l+o', { regex: true }).matches.length).toBeGreaterThan(0);
    expect(searchBuffer(getLine, lines.length, '(', { regex: true }).error).not.toBeNull();
  });

  it('пустой запрос ничего не ищет', () => {
    expect(searchBuffer(getLine, lines.length, '')).toEqual({ matches: [], error: null });
  });
});

describe('cellRange', () => {
  it('обычный знак занимает одну клетку', () => {
    // 'hello' по клетке на знак; совпадение 'll' (смещения 2..4).
    expect(cellRange(['h', 'e', 'l', 'l', 'o'], 2, 4)).toEqual({ from: 2, to: 3 });
  });

  it('широкий знак держит две клетки — вторая пустая', () => {
    // 'пр' — по две клетки на знак: ['п','','р',''].
    expect(cellRange(['п', '', 'р', ''], 0, 2)).toEqual({ from: 0, to: 3 });
  });

  it('совпадение внутри широкого знака не переползает на соседний', () => {
    expect(cellRange(['п', '', 'р', ''], 0, 1)).toEqual({ from: 0, to: 1 });
  });
});

describe('stepMatch', () => {
  it('идёт по кругу вперёд и назад', () => {
    expect(stepMatch(0, 3, 1)).toBe(1);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
  });

  it('без текущего начинает с края', () => {
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
  });

  it('при отсутствии совпадений — минус один', () => {
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });
});
