import { describe, expect, it } from 'vitest';
import {
  captureGroupNames,
  defaultFlags,
  flagsFromString,
  flagsToString,
  noFlags,
  replaceRegex,
  runRegex,
  toggleFlag,
} from '../src/shared/regex-tester';

describe('флаги', () => {
  it('строка собирается в порядке литерала, а не ввода', () => {
    expect(flagsToString(flagsFromString('iug'))).toBe('giu');
  });

  it('чужие знаки отбрасываются', () => {
    expect(flagsToString(flagsFromString('gzd1'))).toBe('g');
  });

  it('по умолчанию ищем все совпадения', () => {
    expect(flagsToString(defaultFlags())).toBe('g');
  });

  it('пустой набор — пустая строка', () => {
    expect(flagsToString(noFlags())).toBe('');
  });

  it('переключение меняет один флаг и не трогает исходный набор', () => {
    const base = noFlags();
    const next = toggleFlag(base, 'i');
    expect(flagsToString(next)).toBe('i');
    expect(flagsToString(base)).toBe('');
    expect(flagsToString(toggleFlag(next, 'i'))).toBe('');
  });
});

describe('captureGroupNames: имена групп по номерам', () => {
  it('обычные скобки — без имени', () => {
    expect(captureGroupNames('(a)(b)')).toEqual([null, null]);
  });

  it('именованные группы узнаются', () => {
    expect(captureGroupNames('(?<year>\\d{4})-(?<month>\\d{2})')).toEqual(['year', 'month']);
  });

  it('незахватывающие скобки и просмотры не считаются', () => {
    expect(captureGroupNames('(?:a)(?=b)(?!c)(?#x)(d)')).toEqual([null]);
  });

  it('просмотр назад — не группа', () => {
    expect(captureGroupNames('(?<=a)(?<!b)(c)')).toEqual([null]);
  });

  it('экранированные скобки и содержимое классов пропускаются', () => {
    expect(captureGroupNames('\\((a)[()]')).toEqual([null]);
  });

  it('незакрытая именованная группа не роняет разбор', () => {
    // `(?<name` без `>` — невалидный шаблон; разбор обязан вернуть имя как null, а не упасть.
    expect(captureGroupNames('(?<name')).toEqual([null]);
  });
});

describe('runRegex: поиск совпадений', () => {
  it('без флага g движок отдаёт только первое — отладчик показывает то же', () => {
    const result = runRegex('a', noFlags(), 'aaa');
    expect(result.ok).toBe(true);
    expect(result.matches).toHaveLength(1);
  });

  it('с флагом g возвращаются все совпадения с местами', () => {
    const result = runRegex('a', flagsFromString('g'), 'banana');
    expect(result.matches.map((match) => match.start)).toEqual([1, 3, 5]);
    expect(result.matches.map((match) => match.text)).toEqual(['a', 'a', 'a']);
  });

  it('группы идут по номерам, с подписью именованных', () => {
    const result = runRegex('(?<year>\\d{4})-(\\d{2})', flagsFromString('g'), '2026-10');
    const [match] = result.matches;
    expect(match?.groups[0]?.text).toBe('2026-10');
    expect(match?.groups[1]).toMatchObject({ name: 'year', text: '2026', start: 0, end: 4 });
    expect(match?.groups[2]).toMatchObject({ name: null, text: '10', start: 5, end: 7 });
  });

  it('неучаствовавшая группа остаётся с пустым текстом', () => {
    const result = runRegex('(a)|(b)', flagsFromString('g'), 'b');
    const [match] = result.matches;
    expect(match?.groups[1]?.text).toBeUndefined();
    expect(match?.groups[2]?.text).toBe('b');
  });

  it('флаг i не различает регистр', () => {
    const result = runRegex('a', flagsFromString('gi'), 'aA');
    expect(result.matches).toHaveLength(2);
  });

  it('пустые совпадения не зацикливают разбор', () => {
    expect(runRegex('\\b', flagsFromString('g'), 'ab cd').matches).toHaveLength(4);
    expect(runRegex('(?:)', flagsFromString('g'), 'abc').matches).toHaveLength(4);
  });

  it('неверный шаблон — ошибка, а не исключение', () => {
    const result = runRegex('(', defaultFlags(), 'x');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.matches).toEqual([]);
  });

  it('предел совпадений обрезает список и помечает это', () => {
    const result = runRegex('a', defaultFlags(), 'aaaa', 2);
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('пустой шаблон — пустой результат без ошибки', () => {
    expect(runRegex('', defaultFlags(), 'abc')).toMatchObject({ ok: true, matches: [] });
  });

  it('нумерует совпадения по порядку с единицы', () => {
    const result = runRegex('a', defaultFlags(), 'aa');
    expect(result.matches.map((match) => match.order)).toEqual([1, 2]);
  });
});

describe('replaceRegex: проверка замены', () => {
  it('подставляет группы по номерам', () => {
    const result = replaceRegex('(\\w+)@(\\w+)', defaultFlags(), 'me@mail', '$2:$1');
    expect(result.text).toBe('mail:me');
    expect(result.count).toBe(1);
  });

  it('подставляет именованные группы', () => {
    const result = replaceRegex('(?<year>\\d{4})-(?<month>\\d{2})', defaultFlags(), '2026-10', '$<month>/$<year>');
    expect(result.text).toBe('10/2026');
  });

  it('без флага g заменяется только первое вхождение', () => {
    const result = replaceRegex('a', noFlags(), 'aaa', 'b');
    expect(result.text).toBe('baa');
    expect(result.count).toBe(1);
  });

  it('с флагом g заменяются все и считается их число', () => {
    const result = replaceRegex('a', defaultFlags(), 'aaa', 'b');
    expect(result.text).toBe('bbb');
    expect(result.count).toBe(3);
  });

  it('неверный шаблон возвращает исходный текст и ошибку', () => {
    const result = replaceRegex('(', defaultFlags(), 'aaa', 'b');
    expect(result.ok).toBe(false);
    expect(result.text).toBe('aaa');
    expect(result.error).toBeTruthy();
  });
});
