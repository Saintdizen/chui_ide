import { describe, expect, it } from 'vitest';
import { countExcluded, excludedLabel } from '../src/renderer/core/excluded-notes';

const byName = (entry: { name: string }): string => entry.name;
const plural = (n: number, one: string, few: string, many: string): string => {
  const rest100 = n % 100;
  const rest10 = n % 10;
  if (rest100 >= 11 && rest100 <= 14) return many;
  if (rest10 === 1) return one;
  if (rest10 >= 2 && rest10 <= 4) return few;
  return many;
};

describe('countExcluded: кого съели маски', () => {
  it('пустые маски — ноль, и даже без разбора', () => {
    expect(countExcluded([{ name: 'a.js' }], [], byName)).toEqual({ count: 0, patterns: [] });
  });

  it('считает по имени и перечисляет сработавшие маски', () => {
    const entries = [{ name: 'a.min.js' }, { name: 'b.ts' }, { name: 'c.min.js' }];
    const result = countExcluded(entries, ['*.min.js'], byName);
    expect(result.count).toBe(2);
    expect(result.patterns).toEqual(['*.min.js']);
  });

  it('маски в настройках идут в том же порядке, а не в порядке срабатывания', () => {
    // Человек ищет свою строку сверху вниз — порядок списка его, а не наш.
    const entries = [{ name: 'dist' }, { name: 'x.min.js' }];
    const result = countExcluded(entries, ['*.min.js', 'dist'], byName);
    expect(result.patterns).toEqual(['*.min.js', 'dist']);
    expect(result.count).toBe(2);
  });

  it('скрытое точкой — НЕ исключённое', () => {
    // Главная грабля: иначе «ещё 40 исключено» показывалось бы там, где человек
    // просто не велел показывать скрытые файлы.
    const entries = [{ name: '.env' }, { name: '.secret' }, { name: 'main.ts' }];
    const result = countExcluded(entries, ['*'], byName, (entry) => entry.name.startsWith('.'));
    expect(result.count).toBe(1);
    expect(result.patterns).toEqual(['*']);
  });

  it('путь от корня участвует: маска dist/* находит вложенное', () => {
    const entries = [{ name: 'bundle.js' }];
    const result = countExcluded(entries, ['dist/*'], () => 'dist/bundle.js');
    expect(result.count).toBe(1);
  });
});

describe('excludedLabel: подпись с человеческим склонением', () => {
  it('1 / 2 / 5 — три формы, а не «файлов» на всё', () => {
    expect(excludedLabel(1, plural)).toBe('Ещё 1 файл исключено');
    expect(excludedLabel(2, plural)).toBe('Ещё 2 файла исключено');
    expect(excludedLabel(5, plural)).toBe('Ещё 5 файлов исключено');
    expect(excludedLabel(11, plural)).toBe('Ещё 11 файлов исключено');
    expect(excludedLabel(21, plural)).toBe('Ещё 21 файл исключено');
  });

  it('ноль — пустая строка, а не «Ещё 0 файлов»', () => {
    expect(excludedLabel(0, plural)).toBe('');
    expect(excludedLabel(-3, plural)).toBe('');
  });
});
