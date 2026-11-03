import { describe, expect, it } from 'vitest';
import { countMatches, findMatches, matchExcerpt, segmentsOf, stepIndex } from '../src/shared/chat-find';

/**
 * Поиск по ленте беседы.
 *
 * Главная опасность здесь — регистр: если искать по `toLowerCase()`, а резать
 * исходную строку, позиции разъедутся. Один из тестов меряет именно это, а не
 * просто «нашлось ли».
 */

describe('findMatches', () => {
  it('находит все вхождения без учёта регистра', () => {
    expect(findMatches('Foo foo FOO', 'foo')).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
  });

  it('позиции считаются по ИСХОДНОЙ строке, а не по приведённой', () => {
    const text = 'Ёлка и ёжик';
    const [match] = findMatches(text, 'ёжик');
    expect(match && text.slice(match.start, match.end)).toBe('ёжик');
  });

  it('перекрытий нет — шаг на длину совпадения', () => {
    expect(findMatches('ааа', 'аа')).toEqual([{ start: 0, end: 2 }]);
  });

  it('пустой запрос ничего не находит (иначе подсветился бы весь текст)', () => {
    expect(findMatches('текст', '')).toEqual([]);
  });

  it('запрос длиннее текста — пусто', () => {
    expect(findMatches('а', 'абв')).toEqual([]);
  });
});

describe('countMatches', () => {
  it('считает то же, что findMatches', () => {
    expect(countMatches('да, нет, да', 'да')).toBe(2);
  });
});

describe('segmentsOf', () => {
  it('режет строку на куски и ставит флаг на совпадениях', () => {
    expect(segmentsOf('ab Cd ab', 'ab')).toEqual([
      { text: 'ab', match: true },
      { text: ' Cd ', match: false },
      { text: 'ab', match: true },
    ]);
  });

  it('склейка кусков даёт исходную строку — без потерь и дублей', () => {
    const text = 'сборка через npm run build';
    expect(
      segmentsOf(text, 'build')
        .map((s) => s.text)
        .join(''),
    ).toBe(text);
  });

  it('совпадение целиком — один кусок, без пустых соседей', () => {
    expect(segmentsOf('ab', 'ab')).toEqual([{ text: 'ab', match: true }]);
  });

  it('пустая строка — пустой список, а не один пустой узел', () => {
    expect(segmentsOf('', 'a')).toEqual([]);
  });

  it('нет совпадений — один кусок', () => {
    expect(segmentsOf('текст', 'zzz')).toEqual([{ text: 'текст', match: false }]);
  });
});

describe('stepIndex', () => {
  it('идёт вперёд и назад', () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, -1)).toBe(1);
  });

  it('замыкается по кругу в обе стороны', () => {
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
  });

  it('ничего не выбрано: вперёд — первое, назад — последнее', () => {
    expect(stepIndex(-1, 3, 1)).toBe(0);
    expect(stepIndex(-1, 3, -1)).toBe(2);
  });

  it('нет совпадений — -1, а не деление на ноль', () => {
    expect(stepIndex(0, 0, 1)).toBe(-1);
  });
});

describe('matchExcerpt', () => {
  it('держит совпадение в середине и ставит многоточия по краям', () => {
    const text = `${'а'.repeat(100)}ИГОЛКА${'б'.repeat(100)}`;
    const excerpt = matchExcerpt(text, 'иголка', 10);
    expect(excerpt).toContain('ИГОЛКА');
    expect(excerpt.startsWith('\u2026')).toBe(true);
    expect(excerpt.endsWith('\u2026')).toBe(true);
    expect(excerpt.length).toBeLessThan(40);
  });

  it('короткий текст отдаётся целиком, без многоточий', () => {
    expect(matchExcerpt('найди', 'найди')).toBe('найди');
  });

  it('нет совпадения — начало текста, а не п��стая строка', () => {
    // Нет совпадения — отдаём начало: радиус 3 даёт 3*2 символов.
    expect(matchExcerpt('что-то', 'zzz', 3)).toBe('что-то');
  });
});
