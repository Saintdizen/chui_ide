import { describe, expect, it } from 'vitest';
import { columnHits, countHits, countInLine, groupHits, replaceInText } from '../src/renderer/core/multibuffer';

/**
 * П.27: мультибуфер — список совпадений как один список, а не «файл за файлом».
 *
 * Проверяем арифметику, на которой стоит панель поиска: порядок попаданий,
 * их адреса в строке и три исхода замены.
 */

describe('мультибуфер: группировка', () => {
  it('собирает попадания по файлам, а не по одному', () => {
    const groups = groupHits([
      { path: '/a.ts', line: 2, column: 1, text: 'const a = 1;' },
      { path: '/b.ts', line: 1, column: 1, text: 'const b = 2;' },
      { path: '/a.ts', line: 9, column: 3, text: 'let a = 3;' },
    ]);

    expect(groups.map((group) => group.path)).toEqual(['/a.ts', '/b.ts']);
    // Внутри файла — по порядку строк: замену идём сверху вниз, иначе позиции съезжают.
    expect(groups[0]?.hits.map((hit) => hit.line)).toEqual([2, 9]);
    expect(countHits(groups)).toBe(3);
  });

  it('без попаданий — пустой список, а не призрак группы', () => {
    expect(groupHits([])).toEqual([]);
    expect(countHits([])).toBe(0);
  });
});

describe('мультибуфер: места в строке', () => {
  it('считает все вхождения и их столбцы', () => {
    expect(countInLine('a.b.a', 'a')).toBe(2);
    expect(columnHits('a.b.a', 'a')).toEqual([0, 4]);
  });

  it('учитывает регистр только когда его попросили', () => {
    // Регистрозависимо — ни одного; без флага «A» — тоже совпадение «a».
    expect(countInLine('Aa', 'a', { caseSensitive: true })).toBe(1);
    expect(columnHits('Aa', 'a', { caseSensitive: true })).toEqual([1]);
    expect(countInLine('Aa', 'a')).toBe(2);
  });

  it('сломанная регулярка — это ноль, а не падение', () => {
    expect(columnHits('текст', '([', { isRegex: true })).toEqual([]);
    expect(countInLine('текст', '(', { isRegex: true })).toBe(0);
  });
});

describe('мультибуфер: замена в файле', () => {
  it('отличает пустой запрос от «уже так и есть»', () => {
    // «Заменено 0» без ответа на вопрос почему — худший исход.
    expect(replaceInText('текст', '', 'x')).toEqual({ kind: 'empty-query' });
    expect(replaceInText('текст', 'нет', 'x')).toEqual({ kind: 'empty-query' });
    expect(replaceInText('aaa', 'a', 'a')).toEqual({ kind: 'same-text' });
  });

  it('меняет все вхождения и рассказывает, сколько', () => {
    expect(replaceInText('a-b-a', 'a', 'x')).toEqual({ kind: 'ok', text: 'x-b-x', count: 2 });
  });

  it('поддерживает группы регулярки — по ним и живёт мультибуфер', () => {
    expect(replaceInText('a1 b2', '([a-z])(\\d)', '$2$1', { isRegex: true })).toEqual({
      kind: 'ok',
      text: '1a 2b',
      count: 2,
    });
  });
});
