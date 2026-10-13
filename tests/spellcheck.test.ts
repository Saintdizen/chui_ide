import { describe, expect, it } from 'vitest';
import {
  baseForms,
  isCheckableWord,
  normalizeDictionaryWord,
  normalizeSpellWords,
  SpellDictionary,
  spellProblemsInLine,
  wordSpans,
} from '../src/shared/spellcheck';

describe('wordSpans: нарезка на слова', () => {
  it('простые слова с их смещениями', () => {
    expect(wordSpans('привет мир')).toEqual([
      { word: 'привет', start: 0, end: 6 },
      { word: 'мир', start: 7, end: 10 },
    ]);
  });

  it('апостроф внутри — одно слово', () => {
    expect(wordSpans("don't stop").map((span) => span.word)).toEqual(["don't", 'stop']);
  });

  it('дефис слова не склеивает: две части проверяются отдельно', () => {
    expect(wordSpans('well-known').map((span) => span.word)).toEqual(['well', 'known']);
  });

  it('цифры и знаки словом не считаются', () => {
    expect(wordSpans('x1 = 42;').map((span) => span.word)).toEqual(['x']);
  });
});

describe('isCheckableWord: что стоит проверять', () => {
  it('однобуквенные не проверяем', () => {
    expect(isCheckableWord('a')).toBe(false);
    expect(isCheckableWord('я')).toBe(false);
  });

  it('верблюжий регистр и аббревиатуры — код, не проза', () => {
    expect(isCheckableWord('parseUrl')).toBe(false);
    expect(isCheckableWord('HTML')).toBe(false);
  });

  it('слово без гласных — сокращение', () => {
    expect(isCheckableWord('rgb')).toBe(false);
    expect(isCheckableWord('src')).toBe(false);
  });

  it('обычные слова проверяем', () => {
    expect(isCheckableWord('hello')).toBe(true);
    expect(isCheckableWord('Python')).toBe(true);
    expect(isCheckableWord('слово')).toBe(true);
  });
});

describe('normalizeDictionaryWord', () => {
  it('нижний регистр и обрезка пробелов', () => {
    expect(normalizeDictionaryWord('  Hello ')).toBe('hello');
  });

  it('апостроф-ёлочка приводится к прямому', () => {
    expect(normalizeDictionaryWord('don’t')).toBe("don't");
  });

  it('не слово — null', () => {
    expect(normalizeDictionaryWord('123')).toBeNull();
    expect(normalizeDictionaryWord('a b')).toBeNull();
    expect(normalizeDictionaryWord('   ')).toBeNull();
  });
});

describe('baseForms: простые основы слова', () => {
  it('множественное число', () => {
    expect(baseForms('dogs')).toContain('dog');
    expect(baseForms('flies')).toContain('fly');
    expect(baseForms('cities')).toContain('city');
  });

  it('прошедшее время с удвоением и без', () => {
    expect(baseForms('loved')).toContain('love');
    expect(baseForms('stopped')).toContain('stop');
    expect(baseForms('tried')).toContain('try');
  });

  it('деепричастие', () => {
    expect(baseForms('running')).toContain('run');
    expect(baseForms('making')).toContain('make');
  });

  it('само слово в основы не попадает', () => {
    expect(baseForms('word')).not.toContain('word');
  });
});

describe('SpellDictionary', () => {
  it('находит слово и его формы', () => {
    const dictionary = new SpellDictionary(['dog', 'run']);
    expect(dictionary.has('dog')).toBe(true);
    expect(dictionary.has('Dogs')).toBe(true);
    expect(dictionary.has('running')).toBe(true);
  });

  it('незнакомое слово не находит, а «не слово» ошибкой не считается', () => {
    const dictionary = new SpellDictionary(['dog']);
    expect(dictionary.has('xyzzy')).toBe(false);
    expect(dictionary.has('123')).toBe(true);
  });

  it('пополняется словом человека', () => {
    const dictionary = new SpellDictionary();
    expect(dictionary.has('фубара')).toBe(false);
    dictionary.add('Фубара');
    expect(dictionary.has('фубара')).toBe(true);
  });
});

describe('spellProblemsInLine', () => {
  it('отмечает слова, которых словарь не знает', () => {
    const problems = spellProblemsInLine(2, 'helo world', (word) => word === 'world');
    expect(problems).toEqual([{ line: 2, startColumn: 1, endColumn: 5, word: 'helo' }]);
  });

  it('участки сужают проверку: вне них слова не берём', () => {
    const line = 'const value = 1; // helo';
    const commentStart = line.indexOf('//');
    const problems = spellProblemsInLine(1, line, (word) => word === 'value', [
      { start: commentStart, end: line.length },
    ]);
    expect(problems.map((problem) => problem.word)).toEqual(['helo']);
  });

  it('слова вне участков не проверяются вовсе', () => {
    const problems = spellProblemsInLine(1, 'const value = 1;', () => false, [{ start: 1, end: 5 }]);
    expect(problems).toEqual([]);
  });
});

describe('normalizeSpellWords: слова человека из настроек', () => {
  it('оставляет только непустые строки без дублей', () => {
    expect(normalizeSpellWords(['словарь', ' Word ', 'word', '', 42, null])).toEqual(['словарь', 'Word']);
  });

  it('не массив — пусто', () => {
    expect(normalizeSpellWords('нет')).toEqual([]);
    expect(normalizeSpellWords(undefined)).toEqual([]);
  });
});
