import { describe, expect, it } from 'vitest';
import { WordIndex } from '../src/renderer/editor/complete/word-index';

/** Наполнить словарь набором строк. */
function indexOf(lines: readonly string[]): WordIndex {
  const index = new WordIndex();
  index.addLines(0, lines);
  return index;
}

describe('наполнение словаря', () => {
  it('собирает слова и считает частоту', () => {
    const index = indexOf(['const value = 1;', 'value = value + 2;']);
    expect(index.count('value')).toBe(3);
    expect(index.count('const')).toBe(1);
    expect(index.count('нетакого')).toBe(0);
  });

  it('однобуквенные слова не попадают: это шум', () => {
    const index = indexOf(['a = b + c']);
    expect(index.size).toBe(0);
  });

  it('имя целиком, а не по частям: подчёркивание и цифры — часть слова', () => {
    const index = indexOf(['const active_row2 = 1;']);
    expect(index.count('active_row2')).toBe(1);
    expect(index.count('active')).toBe(0);
  });

  it('кириллица — тоже слово, а не разделитель', () => {
    const index = indexOf(['переменная значение']);
    expect(index.count('переменная')).toBe(1);
    expect(index.count('значение')).toBe(1);
  });

  it('та же строка второй раз не пересчитывается', () => {
    const index = new WordIndex();
    index.addLine(0, 'word word');
    index.addLine(0, 'word word');
    expect(index.count('word')).toBe(2);
  });

  it('изменённая строка пересчитывается после сброса', () => {
    const index = new WordIndex();
    index.addLine(0, 'старое слово');
    index.invalidate(0);
    index.addLine(0, 'новое слово');
    expect(index.count('новое')).toBe(1);
    // Частота старого слова осталась: словарь общий, а строка одна и та же.
    expect(index.count('старое')).toBe(1);
  });

  it('сброс очищает словарь', () => {
    const index = indexOf(['слово']);
    index.reset();
    expect(index.size).toBe(0);
  });
});

describe('подбор по префиксу', () => {
  it('находит слова по началу, без учёта регистра', () => {
    const index = indexOf(['value Value VALUE other']);
    const found = index.candidates('val', 10);
    expect(found.sort()).toEqual(['VALUE', 'Value', 'value']);
  });

  it('набранное слово само в подсказки не идёт', () => {
    const index = indexOf(['value']);
    // `value` не предлагается как дополнение к `value`: оно уже набрано.
    expect(index.candidates('value', 10)).toEqual([]);
  });

  it('частые слова идут первыми', () => {
    const index = indexOf(['common rare common count common']);
    // И «common», и «count» начинаются на «co», но «common» встречается чаще.
    expect(index.candidates('co', 10)[0]).toBe('common');
  });

  it('при равной частоте короткое слово выше длинного', () => {
    const index = indexOf(['core coreLong']);
    expect(index.candidates('co', 10)).toEqual(['core', 'coreLong']);
  });

  it('исключённые слова не попадают в подбор', () => {
    const index = indexOf(['value vane']);
    expect(index.candidates('va', 10, new Set(['value']))).toEqual(['vane']);
  });

  it('предел списка соблюдается', () => {
    const index = indexOf(Array.from({ length: 20 }, (_, i) => `word${i}`));
    expect(index.candidates('word', 5)).toHaveLength(5);
  });

  it('пустой префикс — пустой список', () => {
    const index = indexOf(['value']);
    expect(index.candidates('', 10)).toEqual([]);
  });
});

describe('свои объявления', () => {
  it('имя из `const`/`function` считается объявленным, а слово из чужой строки — нет', () => {
    const index = indexOf(['const activeRow = 1;', 'return activeRow;', 'otherRow()']);
    expect(index.isDeclared('activeRow')).toBe(true);
    // `otherRow()` в начале строки — тоже объявление: имя идёт сразу после ключевого
    // слова, без `=` и `:`. Это широкий, но осознанный захват — см. `declaredIn`.
    // А вот `return` и произвольное слово — нет.
    expect(index.isDeclared('otherRow')).toBe(true);
    expect(index.isDeclared('return')).toBe(false);
    expect(index.isDeclared('нетакого')).toBe(false);
  });

  it('объявленное идёт вперёд даже при меньшей частоте', () => {
    // `otherRow` встречается трижды, `activeRow` — только в объявлении.
    const index = indexOf(['otherRow otherRow otherRow', 'const activeRow = 1;']);
    expect(index.candidates('Row', 10)).toEqual(['activeRow', 'otherRow']);
  });

  it('сброс словаря снимает и признак объявления', () => {
    const index = indexOf(['const activeRow = 1;']);
    index.reset();
    expect(index.isDeclared('activeRow')).toBe(false);
  });
});

describe('слова без префикса', () => {
  it('самые частые слова — по убыванию частоты', () => {
    const index = indexOf(['alpha alpha beta gamma']);
    expect(index.allWords(2)).toEqual(['alpha', 'beta']);
  });

  it('исключения учитываются', () => {
    const index = indexOf(['alpha beta']);
    expect(index.allWords(5, new Set(['alpha']))).toEqual(['beta']);
  });

  it('своё объявление идёт вперёд и без префикса', () => {
    const index = indexOf(['alpha alpha alpha beta', 'const zeta = 1;']);
    expect(index.allWords(2)).toEqual(['zeta', 'alpha']);
  });
});
