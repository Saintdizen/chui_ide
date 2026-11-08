import { describe, expect, it } from 'vitest';
import { whitespaceMarks } from '../src/renderer/editor/view/whitespace';
import { nextWhitespaceMode, normalizeWhitespaceMode } from '../src/shared/whitespace';

/**
 * Разбор невидимых знаков строки: где поставить точку (пробел) и где стрелку
 * (табуляция). Смещения — UTF-16, как везде в редакторе. Подряд идущие знаки одного
 * вида собираются в отрезок: длинный отступ — один узел, а не десяток.
 */
describe('whitespaceMarks', () => {
  it('режим none — пусто', () => {
    expect(whitespaceMarks('  a  b  ', 'none')).toEqual([]);
  });

  it('all — каждый отрезок невидимых знаков', () => {
    expect(whitespaceMarks('  a  b', 'all')).toEqual([
      { start: 0, end: 2, kind: 'space' },
      { start: 3, end: 5, kind: 'space' },
    ]);
  });

  it('табуляция — свой вид и свой отрезок', () => {
    expect(whitespaceMarks('a\t\tb', 'all')).toEqual([{ start: 1, end: 3, kind: 'tab' }]);
  });

  it('пробелы и табуляция рядом не сливаются', () => {
    expect(whitespaceMarks(' \t x', 'all')).toEqual([
      { start: 0, end: 1, kind: 'space' },
      { start: 1, end: 2, kind: 'tab' },
      { start: 2, end: 3, kind: 'space' },
    ]);
  });

  it('trailing — только хвост строки', () => {
    expect(whitespaceMarks('a  b  ', 'trailing')).toEqual([{ start: 4, end: 6, kind: 'space' }]);
  });

  it('trailing на строке из одних знаков — вся строка', () => {
    expect(whitespaceMarks('   ', 'trailing')).toEqual([{ start: 0, end: 3, kind: 'space' }]);
  });

  it('trailing без хвоста — пусто', () => {
    expect(whitespaceMarks('  a', 'trailing')).toEqual([]);
  });

  it('пустая строка — пусто в любом режиме', () => {
    expect(whitespaceMarks('', 'all')).toEqual([]);
    expect(whitespaceMarks('', 'trailing')).toEqual([]);
  });
});

describe('normalizeWhitespaceMode', () => {
  it('известные значения проходят', () => {
    expect(normalizeWhitespaceMode('all')).toBe('all');
    expect(normalizeWhitespaceMode('trailing')).toBe('trailing');
    expect(normalizeWhitespaceMode('none')).toBe('none');
  });

  it('мусор и чужие типы — none', () => {
    expect(normalizeWhitespaceMode('yes')).toBe('none');
    expect(normalizeWhitespaceMode(undefined)).toBe('none');
    expect(normalizeWhitespaceMode(3)).toBe('none');
  });
});

/**
 * Листание режима: чип в строке состояния и команда palетры листают по одному
 * кругу. Три положения — полный цикл возвращает исходное за три нажатия.
 */
describe('nextWhitespaceMode: листание по кругу', () => {
  it('нет → хвостовые → все → нет', () => {
    expect(nextWhitespaceMode('none')).toBe('trailing');
    expect(nextWhitespaceMode('trailing')).toBe('all');
    expect(nextWhitespaceMode('all')).toBe('none');
  });

  it('полный круг возвращает исходное', () => {
    let mode = nextWhitespaceMode('none');
    mode = nextWhitespaceMode(mode);
    mode = nextWhitespaceMode(mode);
    expect(mode).toBe('none');
  });
});
