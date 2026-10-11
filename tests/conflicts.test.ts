import { describe, expect, it } from 'vitest';
import {
  conflictChoiceText,
  conflictEdit,
  hasConflicts,
  mergeConflicts,
  parseConflicts,
} from '../src/shared/conflicts';
import { applyTextEdits } from '../src/shared/edits';

/** Файл с одним конфликтом в обычном (2-way) стиле. */
const ONE = ['начало', '<<<<<<< HEAD', 'наша строка', '=======', 'их строка', '>>>>>>> feature', 'конец', ''].join(
  '\n',
);

/** Файл с двумя конфликтами: проверяем разбор нескольких блоков. */
const TWO = [
  'a',
  '<<<<<<< HEAD',
  'ours1',
  '=======',
  'theirs1',
  '>>>>>>> other',
  'b',
  '<<<<<<< HEAD',
  'ours2',
  '=======',
  'theirs2',
  '>>>>>>> other',
  'c',
  '',
].join('\n');

describe('parseConflicts', () => {
  it('находит блок и его стороны', () => {
    const blocks = parseConflicts(ONE);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      index: 0,
      startLine: 2,
      endLine: 6,
      ours: 'наша строка',
      theirs: 'их строка',
      oursLabel: 'HEAD',
      theirsLabel: 'feature',
      base: null,
    });
  });

  it('разбирает несколько блоков по порядку', () => {
    const blocks = parseConflicts(TWO);

    expect(blocks.map((block) => block.ours)).toEqual(['ours1', 'ours2']);
    expect(blocks.map((block) => block.index)).toEqual([0, 1]);
    expect(blocks[0]!.startLine).toBe(2);
    expect(blocks[1]!.startLine).toBe(8);
  });

  it('читает общий предок в стиле diff3', () => {
    const diff3 = ['<<<<<<< HEAD', 'наше', '||||||| base', 'общее', '=======', 'их', '>>>>>>> other', ''].join('\n');
    const blocks = parseConflicts(diff3);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.base).toBe('общее');
    expect(blocks[0]!.ours).toBe('наше');
    expect(blocks[0]!.theirs).toBe('их');
  });

  it('поддерживает многострочные стороны', () => {
    const text = ['<<<<<<< HEAD', 'a1', 'a2', '=======', 'b1', 'b2', '>>>>>>> x', ''].join('\n');
    const block = parseConflicts(text)[0]!;
    expect(block.ours).toBe('a1\na2');
    expect(block.theirs).toBe('b1\nb2');
  });

  it('текст без конфликтов даёт пустой список', () => {
    expect(parseConflicts('обычный\nтекст\n')).toEqual([]);
  });

  it('незакрытый блок не считается конфликтом (файл правят прямо сейчас)', () => {
    // Маркер начала есть, но конца нет — разбор не должен угадывать.
    expect(parseConflicts('<<<<<<< HEAD\nнаше\n=======\nих\n')).toEqual([]);
  });
});

describe('hasConflicts', () => {
  it('видит маркеры и в начале файла, и в середине', () => {
    expect(hasConflicts(ONE)).toBe(true);
    expect(hasConflicts(`<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> z`)).toBe(true);
  });

  it('чистый текст конфликтом не считает', () => {
    expect(hasConflicts('просто код\n')).toBe(false);
  });
});

describe('conflictChoiceText', () => {
  const block = parseConflicts(ONE)[0]!;

  it('наше и их отдают соответствующую сторону', () => {
    expect(conflictChoiceText(block, 'ours')).toBe('наша строка');
    expect(conflictChoiceText(block, 'theirs')).toBe('их строка');
  });

  it('«оба» склеивает наше и их, а пустую сторону не удваивает', () => {
    expect(conflictChoiceText(block, 'both')).toBe('наша строка\nих строка');
    const empty = parseConflicts('<<<<<<< HEAD\n=======\nтолько их\n>>>>>>> z\n')[0]!;
    expect(conflictChoiceText(empty, 'both')).toBe('только их');
  });
});

describe('mergeConflicts', () => {
  it('заменяет выбранные блоки и оставляет невыбранные как есть', () => {
    const merged = mergeConflicts(TWO, ['ours']);

    expect(merged).toContain('ours1');
    // Второй блок выбора не получил — маркеры на месте.
    expect(merged).toContain('<<<<<<< HEAD\nours2');
    expect(merged).not.toContain('theirs1');
  });

  it('выбор по всем блокам убирает все маркеры', () => {
    const merged = mergeConflicts(TWO, ['theirs', 'both']);

    expect(hasConflicts(merged)).toBe(false);
    expect(merged).toContain('theirs1');
    expect(merged).toContain('ours2\ntheirs2');
    expect(merged.startsWith('a\n')).toBe(true);
    expect(merged.endsWith('c\n')).toBe(true);
  });

  it('текст без конфликтов возвращается без изменений', () => {
    expect(mergeConflicts('обычный\n', ['ours'])).toBe('обычный\n');
  });

  it('разрешение с пустой стороной убирает блок, а не оставляет перевод строки', () => {
    const text = ['x', '<<<<<<< HEAD', '=======', 'их', '>>>>>>> z', 'y', ''].join('\n');
    expect(mergeConflicts(text, ['ours'])).toBe('x\ny\n');
  });
});

describe('conflictEdit', () => {
  it('правит диапазон блока и даёт тот же результат, что и полный разбор', () => {
    const blocks = parseConflicts(TWO);
    const edit = conflictEdit(TWO, blocks[0]!, 'theirs');

    const applied = applyTextEdits(TWO, [edit]);
    expect(applied).toBe(mergeConflicts(TWO, ['theirs']));
  });

  it('остальные строки файла не трогает', () => {
    const block = parseConflicts(ONE)[0]!;
    const applied = applyTextEdits(ONE, [conflictEdit(ONE, block, 'ours')]);

    expect(applied).toBe('начало\nнаша строка\nконец\n');
  });
});
