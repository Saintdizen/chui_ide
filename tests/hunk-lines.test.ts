import { describe, expect, it } from 'vitest';
import { hunkAtLine, hunkLineRange } from '../src/shared/hunk-lines';
import { lineChanges } from '../src/shared/git-line-changes';

/**
 * Блок изменений по строке редактора — то, чем пользуются действия из жёлоба:
 * щёлкнули по полоске, надо понять, какой это блок diff.
 *
 * Главное здесь одно: границы блока и полоски в жёлобе обязаны сходиться. Строку
 * для блока берём из diff (`@@ -a,b +c,d @@`, то есть `newStart`/`newCount`), а
 * полоски считает другой модуль (`git-line-changes`). Если они разойдутся, щелчок
 * по полоске не найдёт блок — и действие просто не сработает.
 */

/** Блок diff, как его записал бы git: строки `@@ -oldStart,oldCount +newStart,newCount @@`. */
const hunk = (newStart: number, newCount: number, oldStart = 1, oldCount = 1) => ({
  oldStart,
  oldCount,
  newStart,
  newCount,
});

describe('hunkLineRange', () => {
  it('блок из нескольких строк занимает строки newStart…newStart+newCount-1', () => {
    expect(hunkLineRange(hunk(10, 3))).toEqual({ from: 10, to: 12 });
  });

  it('блок в одну строку — она же', () => {
    expect(hunkLineRange(hunk(7, 1))).toEqual({ from: 7, to: 7 });
  });

  it('чистое добавление тоже покрывает свои строки', () => {
    expect(hunkLineRange(hunk(5, 4, 4, 0))).toEqual({ from: 5, to: 8 });
  });

  it('чистое удаление: строк в новой версии нет — привязано к строке перед ним', () => {
    // `@@ -10,3 +9,0 @@` — удалили три строки, в новой версии их не стало.
    // Полоска удаления стоит на строке 9 (перед пропуском), туда же идёт блок.
    expect(hunkLineRange(hunk(9, 0, 10, 3))).toEqual({ from: 9, to: 9 });
  });

  it('вырожденный newStart = 0 у начала файла не уводит в строку ноль', () => {
    expect(hunkLineRange(hunk(0, 0, 1, 1))).toEqual({ from: 1, to: 1 });
  });
});

describe('hunkAtLine', () => {
  const hunks = [hunk(3, 2), hunk(20, 1), hunk(40, 3)];

  it('строка внутри блока находит его номер', () => {
    expect(hunkAtLine(hunks, 3)).toBe(0);
    expect(hunkAtLine(hunks, 4)).toBe(0);
    expect(hunkAtLine(hunks, 20)).toBe(1);
    expect(hunkAtLine(hunks, 42)).toBe(2);
  });

  it('строка между блоками — ничего', () => {
    expect(hunkAtLine(hunks, 5)).toBeNull();
    expect(hunkAtLine(hunks, 19)).toBeNull();
    expect(hunkAtLine(hunks, 50)).toBeNull();
  });

  it('границы включительны с обеих сторон', () => {
    expect(hunkAtLine([hunk(3, 2)], 2)).toBeNull();
    expect(hunkAtLine([hunk(3, 2)], 3)).toBe(0);
    expect(hunkAtLine([hunk(3, 2)], 4)).toBe(0);
    expect(hunkAtLine([hunk(3, 2)], 5)).toBeNull();
  });

  it('пустой список — null', () => {
    expect(hunkAtLine([], 1)).toBeNull();
  });
});

/**
 * Согласование двух модулей — то, ради чего этот файл и написан. Пары текстов
 * подобраны так, чтобы покрыть все три вида правок: добавление, изменение и
 * чистое удаление (у последнего полоска стоит на строке ПЕРЕД пропуском).
 */
describe('полоски в жёлобе и блоки сходятся по строкам', () => {
  /** Разбор diff-текста: блоки из шапок `@@`. Числа — как у git. */
  const rangesFromDiff = (diff: string): ReturnType<typeof hunk>[] =>
    diff
      .split('\n')
      .filter((line) => line.startsWith('@@ '))
      .map((line) => {
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)!;
        return {
          oldStart: Number(match[1]),
          oldCount: match[2] === undefined ? 1 : Number(match[2]),
          newStart: Number(match[3]),
          newCount: match[4] === undefined ? 1 : Number(match[4]),
        };
      });

  it('добавление строки: полоска и блок на одной строке', () => {
    const original = 'a\nb\nc\n';
    const modified = 'a\nnew\nb\nc\n';
    const diff = '@@ -1,3 +1,4 @@\n a\n+new\n b\n c\n';
    const stripes = lineChanges(original, modified);
    const blocks = rangesFromDiff(diff);

    expect(stripes).toEqual([{ line: 2, kind: 'added' }]);
    expect(hunkAtLine(blocks, 2)).toBe(0);
  });

  it('изменение строки: полоска ведёт в свой блок', () => {
    const original = 'a\nb\nc\n';
    const modified = 'a\nB\nc\n';
    const diff = '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n';
    const stripes = lineChanges(original, modified);
    const blocks = rangesFromDiff(diff);

    expect(stripes).toEqual([{ line: 2, kind: 'modified' }]);
    expect(hunkAtLine(blocks, stripes[0]!.line)).toBe(0);
  });

  it('удаление строки: полоска и блок привязаны к строке перед пропуском', () => {
    // Удалили строку 2; в новой версии после строки 1 идёт строка 2 («c»).
    const original = 'a\nb\nc\n';
    const modified = 'a\nc\n';
    const diff = '@@ -1,3 +1,2 @@\n a\n-b\n c\n';
    const stripes = lineChanges(original, modified);
    const blocks = rangesFromDiff(diff);

    // У полоски удаления одна строка — перед местом удаления.
    expect(stripes).toEqual([{ line: 1, kind: 'deleted' }]);
    expect(hunkAtLine(blocks, 1)).toBe(0);
  });

  it('две правки в разных местах: каждая полоска ведёт в свой блок', () => {
    const original = '1\n2\n3\n4\n5\n6\n7\n8\n';
    const modified = '1\n2\nвставили\n3\n4\n5\n6\n7\n8\nзаменили\n';
    const diff = '@@ -2,7 +2,9 @@\n 2\n+вставили\n 3\n 4\n 5\n 6\n 7\n 8\n+заменили\n';
    const stripes = lineChanges(original, modified);
    const blocks = rangesFromDiff(diff);
    expect(blocks).toHaveLength(1);

    // Обе полоски внутри одного блока (правки рядом, git слил их в один хунк).
    for (const stripe of stripes) {
      expect(hunkAtLine(blocks, stripe.line)).toBe(0);
    }
  });
});
