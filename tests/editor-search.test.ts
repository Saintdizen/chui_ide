import { describe, expect, it } from 'vitest';
import {
  compileQuery,
  expandReplacement,
  findMatches,
  lineMatches,
  matchIndexAt,
} from '../src/renderer/editor/find/search';
import { replaceAll, replaceOne, type ReplaceSource } from '../src/renderer/editor/find/replace';

/** Документ-стенд: строки и доступ к ним по номеру с нуля. */
function doc(text: string) {
  const lines = text.split('\n');
  return {
    getLine: (line0: number) => lines[line0] ?? '',
    lineCount: lines.length,
    lines,
  };
}

/** Стенд, пригодный для замены: к строкам добавлено смещение их начал. */
function replaceSource(text: string): ReplaceSource & { getLine: (line0: number) => string } {
  const lines = text.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return {
    getLine: (line0: number) => lines[line0] ?? '',
    lineStart: (line: number) => starts[line - 1] ?? 0,
  };
}

/** Применить правку участка к тексту документа. */
function applyEdit(text: string, edit: { start: number; removed: string; inserted: string }): string {
  return text.slice(0, edit.start) + edit.inserted + text.slice(edit.start + edit.removed.length);
}

describe('поиск подстроки', () => {
  it('находит все вхождения и считает номера строк', () => {
    const source = doc('cat dog\ncat\nDog cat');
    const result = findMatches(source.getLine, source.lineCount, 'cat');
    expect(result.matches.map((match) => match.line)).toEqual([1, 2, 3]);
    expect(result.error).toBeNull();
  });

  it('по умолчанию регистр не важен, с настройкой — важен', () => {
    const source = doc('Cat cat CAT');
    expect(findMatches(source.getLine, source.lineCount, 'cat').matches).toHaveLength(3);
    const strict = findMatches(source.getLine, source.lineCount, 'cat', { caseSensitive: true });
    expect(strict.matches).toHaveLength(1);
    // Смещение — в середине строки: «Cat cat CAT» — cat начинается с 4.
    expect(strict.matches[0]!.start).toBe(4);
  });

  it('слово целиком не находит подстроку внутри слова', () => {
    const source = doc('cat category cat');
    const whole = findMatches(source.getLine, source.lineCount, 'cat', { wholeWord: true });
    expect(whole.matches.map((match) => match.start)).toEqual([0, 13]);
  });

  it('пустой запрос — пустой результат без ошибки', () => {
    const source = doc('что-нибудь');
    const result = findMatches(source.getLine, source.lineCount, '');
    expect(result.matches).toHaveLength(0);
    expect(result.error).toBeNull();
  });

  it('смещения сквозные по документу, а не внутри строки', () => {
    const source = doc('ab\ncd');
    const result = findMatches(source.getLine, source.lineCount, 'cd');
    // Строка 0 «ab» (2 знака) плюс перевод строки — единица: «cd» начинается со 3.
    expect(result.matches[0]!.start).toBe(3);
  });
});

describe('поиск по регулярке', () => {
  it('находит по шаблону и отдаёт группы', () => {
    const source = doc('id=12 name=x');
    const compiled = compileQuery('(\\w+)=(\\d+)', { regex: true })!;
    const found = lineMatches(source.getLine(0), compiled, { regex: true });
    expect(found).toHaveLength(1);
    expect(found[0]!.groups).toEqual(['id', '12']);
  });

  it('недописанная регулярка не бросает, а возвращает ошибку', () => {
    const source = doc('текст');
    const result = findMatches(source.getLine, source.lineCount, '(незакрытая', { regex: true });
    expect(result.matches).toHaveLength(0);
    expect(result.error).not.toBeNull();
  });

  it('регистр в регулярке настраивается', () => {
    const source = doc('ABC abc');
    expect(findMatches(source.getLine, source.lineCount, 'abc', { regex: true }).matches).toHaveLength(2);
    expect(
      findMatches(source.getLine, source.lineCount, 'abc', { regex: true, caseSensitive: true }).matches,
    ).toHaveLength(1);
  });

  it('пустое совпадение не зацикливает поиск', () => {
    const source = doc('abc');
    const result = findMatches(source.getLine, source.lineCount, 'x*', { regex: true });
    // `x*` совпадает с пустотой в каждой позиции — такие совпадения пропускаем,
    // иначе нулевой длины выделение и бесконечный цикл.
    expect(result.matches).toHaveLength(0);
  });

  it('слово целиком работает и с регуляркой', () => {
    const source = doc('cat category');
    const result = findMatches(source.getLine, source.lineCount, 'cat', { regex: true, wholeWord: true });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.start).toBe(0);
  });
});

describe('развёртывание шаблона замены', () => {
  it('в обычном режиме доллар — просто текст', () => {
    const compiled = compileQuery('x', {})!;
    const match = lineMatches('x', compiled)[0]!;
    expect(expandReplacement(match, 'x', '$1 — это текст', false)).toBe('$1 — это текст');
  });

  it('в режиме регулярки работают группы, всё совпадение и знак доллара', () => {
    const compiled = compileQuery('(\\w+)=(\\d+)', { regex: true })!;
    const match = lineMatches('id=12', compiled, { regex: true })[0]!;
    expect(match.groups).toEqual(['id', '12']);
    expect(expandReplacement(match, 'id=12', '$2:$1', true)).toBe('12:id');
    expect(expandReplacement(match, 'id=12', '[$&]', true)).toBe('[id=12]');
    expect(expandReplacement(match, 'id=12', '$$1', true)).toBe('$1');
    // Ссылка на несуществующую группу исчезает, а не остаётся текстом.
    expect(expandReplacement(match, 'id=12', '$9', true)).toBe('');
  });
});

describe('замена всех', () => {
  it('одна правка на весь диапазон, а не список из нескольких', () => {
    const text = 'cat dog cat';
    const source = replaceSource(text);
    const compiled = compileQuery('cat', {})!;
    const matches = findMatches(source.getLine, 1, 'cat').matches;

    const edit = replaceAll(source, matches, compiled, 'кот')!;
    expect(edit.count).toBe(2);
    // Диапазон — вся строка целиком: одна правка, смещения никуда не съезжают.
    expect(edit.start).toBe(0);
    expect(edit.removed).toBe(text);
    expect(edit.inserted).toBe('кот dog кот');
    expect(applyEdit(text, edit)).toBe('кот dog кот');
  });

  it('диапазон охватывает строки с совпадениями целиком', () => {
    const text = 'aXb\ncXd\nno';
    const source = replaceSource(text);
    const compiled = compileQuery('X', {})!;
    const matches = findMatches(source.getLine, 3, 'X').matches;

    const edit = replaceAll(source, matches, compiled, '-')!;
    expect(edit.count).toBe(2);
    expect(edit.removed).toBe('aXb\ncXd');
    expect(edit.inserted).toBe('a-b\nc-d');
    expect(applyEdit(text, edit)).toBe('a-b\nc-d\nno');
  });

  it('заменяет только запрошенное: ни лишнего, ни пропущенного', () => {
    const text = 'один два один\nтри один';
    const source = replaceSource(text);
    const compiled = compileQuery('один', {})!;
    const matches = findMatches(source.getLine, 2, 'один').matches;
    const edit = replaceAll(source, matches, compiled, '1')!;
    expect(edit.count).toBe(3);
    expect(applyEdit(text, edit)).toBe('1 два 1\nтри 1');
  });

  it('учёт регистра и слово целиком уважаются', () => {
    const text = 'Cat Cat cat';
    const source = replaceSource(text);

    // Замена делается по тем же настройкам, что и поиск: их передаём рядом с matches.
    const strict = compileQuery('cat', { caseSensitive: true })!;
    const strictOptions = { caseSensitive: true };
    const strictMatches = findMatches(source.getLine, 1, 'cat', strictOptions).matches;
    const strictEdit = replaceAll(source, strictMatches, strict, 'x', strictOptions)!;
    expect(strictEdit.count).toBe(1);
    expect(applyEdit(text, strictEdit)).toBe('Cat Cat x');

    // Слово целиком не трогает `cat` внутри `category`.
    const wholeText = 'cat category cat';
    const wholeSource = replaceSource(wholeText);
    const whole = compileQuery('cat', {})!;
    const wholeOptions = { wholeWord: true };
    const wholeMatches = findMatches(wholeSource.getLine, 1, 'cat', wholeOptions).matches;
    const edit = replaceAll(wholeSource, wholeMatches, whole, 'x', wholeOptions)!;
    expect(edit.count).toBe(2);
    expect(applyEdit(wholeText, edit)).toBe('x category x');
  });

  it('замена по регулярке подставляет группы', () => {
    const text = 'id=12 name=x';
    const source = replaceSource(text);
    const compiled = compileQuery('(\\w+)=(\\w+)', { regex: true })!;
    const matches = findMatches(source.getLine, 1, '(\\w+)=(\\w+)', { regex: true }).matches;

    const edit = replaceAll(source, matches, compiled, '$1: $2', { regex: true })!;
    expect(edit.count).toBe(2);
    expect(applyEdit(text, edit)).toBe('id: 12 name: x');
  });

  it('нечего заменять — правки нет', () => {
    const source = replaceSource('пусто');
    const compiled = compileQuery('нет', {})!;
    expect(replaceAll(source, [], compiled, 'x')).toBeNull();
  });
});

describe('замена одного совпадения', () => {
  it('меняет ровно одно место', () => {
    const text = 'cat dog cat';
    const source = replaceSource(text);
    const compiled = compileQuery('cat', {})!;
    const matches = findMatches(source.getLine, 1, 'cat').matches;

    const edit = replaceOne(source, matches[1]!, compiled, 'кот')!;
    expect(edit.start).toBe(8);
    expect(edit.removed).toBe('cat');
    expect(applyEdit(text, edit)).toBe('cat dog кот');
  });

  it('по регулярке подставляет группы', () => {
    const text = 'id=12';
    const source = replaceSource(text);
    const compiled = compileQuery('(\\w+)=(\\d+)', { regex: true })!;
    const matches = findMatches(source.getLine, 1, '(\\w+)=(\\d+)', { regex: true }).matches;

    const edit = replaceOne(source, matches[0]!, compiled, '$2', { regex: true })!;
    expect(applyEdit(text, edit)).toBe('12');
  });
});

describe('выбор текущего совпадения', () => {
  const matches = [
    { start: 0, end: 3, line: 1 },
    { start: 10, end: 13, line: 2 },
    { start: 20, end: 23, line: 3 },
  ];

  it('совпадение под курсором', () => {
    expect(matchIndexAt(matches, 11)).toBe(1);
  });

  it('без совпадения под курсором берётся ближайшее справа', () => {
    expect(matchIndexAt(matches, 5)).toBe(1);
    expect(matchIndexAt(matches, 15)).toBe(2);
  });

  it('за последним совпадением берётся последнее', () => {
    expect(matchIndexAt(matches, 99)).toBe(2);
  });

  it('пустой список — ни одного', () => {
    expect(matchIndexAt([], 0)).toBe(-1);
  });
});
