import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { describeWord, wordInfoAt } from '../src/renderer/editor/hover/word-info';

/** Смещение начала слова в тексте: для проверок удобнее, чем считать руками. */
function at(buffer: TextBuffer, line: number, column: number): number {
  return buffer.lineStart(line) + column - 1;
}

describe('слово под смещением', () => {
  it('находит слово и его границы', () => {
    const buffer = new TextBuffer('const value = 1;');
    const info = wordInfoAt(buffer, at(buffer, 1, 8));
    expect(info?.word).toBe('value');
    expect(info?.start).toBe(6);
    expect(info?.end).toBe(11);
    expect(info?.line).toBe(1);
  });

  it('на пробеле или знаке слова нет', () => {
    const buffer = new TextBuffer('a = b');
    // Смещение 1 — пробел.
    expect(wordInfoAt(buffer, 1)).toBeNull();
    // Смещение 2 — знак «=».
    expect(wordInfoAt(buffer, 2)).toBeNull();
  });

  it('считает вхождения по всему файлу, а не по строке', () => {
    const buffer = new TextBuffer('value = 1;\nvalue = value + 2;\nother = 3;');
    const info = wordInfoAt(buffer, 0);
    expect(info?.occurrences).toBe(3);
    expect(info?.firstLine).toBe(1);
  });

  it('вхождение внутри другого имени не считается', () => {
    const buffer = new TextBuffer('value valueInside\nvalue');
    const info = wordInfoAt(buffer, 0);
    // `value` внутри `valueInside` — не вхождение слова `value`.
    expect(info?.occurrences).toBe(2);
  });

  it('сообщает, где слово объявлено и как', () => {
    const buffer = new TextBuffer('function compute() {}\ncompute();');
    const info = wordInfoAt(buffer, 9);
    expect(info?.declaredAt).toBe(1);
    expect(info?.declarationKind).toBe('функция');
  });

  it('объявление переменной и класса узнаётся', () => {
    const buffer = new TextBuffer('const config = {};\nclass Row {}\nconfig; Row;');
    expect(wordInfoAt(buffer, 6)?.declarationKind).toBe('константа');
    // «Row» во второй строке — сразу после `class`.
    expect(wordInfoAt(buffer, buffer.lineStart(2) + 6)?.declarationKind).toBe('класс');
  });

  it('слово без объявления: объявление не выдумывается', () => {
    const buffer = new TextBuffer('justSomeName\njustSomeName');
    const info = wordInfoAt(buffer, 0);
    expect(info?.occurrences).toBe(2);
    expect(info?.declaredAt).toBeNull();
    expect(info?.declarationKind).toBeNull();
  });

  it('курсор в конце строки прижимается к последнему слову', () => {
    const buffer = new TextBuffer('word');
    // Смещение 4 — за концом слова (граница), но всё ещё в строке.
    expect(wordInfoAt(buffer, 3)?.word).toBe('word');
  });
});

describe('текст подсказки', () => {
  it('склоняет число и показывает объявление', () => {
    const buffer = new TextBuffer('function run() {}\nrun(); run();');
    const info = wordInfoAt(buffer, buffer.lineStart(2))!;
    const described = describeWord(info);
    expect(described.title).toBe('run');
    expect(described.lines[0]).toBe('Встречается в файле: 3 раза');
    expect(described.lines[1]).toBe('Объявление: функция, строка 1');
  });

  it('объявление на этой же строке помечается словами, а не номером', () => {
    const buffer = new TextBuffer('const value = 1;');
    const described = describeWord(wordInfoAt(buffer, 6)!);
    expect(described.lines[1]).toBe('Объявление: константа, эта строка');
  });

  it('единственное число и первое вхождение в другой строке', () => {
    const buffer = new TextBuffer('first here\nsecond first');
    const info = wordInfoAt(buffer, buffer.lineStart(2) + 7)!;
    const described = describeWord(info);
    expect(described.lines[0]).toBe('Встречается в файле: 2 раза');
    // Объявления нет — говорим, где слово встретилось впервые.
    expect(described.lines[1]).toBe('Впервые на строке 1');
  });

  it('слово в одном месте — про первое вхождение не говорим', () => {
    const buffer = new TextBuffer('единственное');
    const described = describeWord(wordInfoAt(buffer, 0)!);
    expect(described.lines).toEqual(['Встречается в файле: 1 раз']);
  });
});
