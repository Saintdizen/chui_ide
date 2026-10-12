import { describe, expect, it } from 'vitest';
import { buildDiff } from '../src/renderer/editor/host/diff-model';

/** Сводка ряда — компактно, чтобы ожидания читались. */
function summary(original: string, modified: string) {
  const { rows, hunks } = buildDiff(original, modified);
  return {
    rows: rows.map((row) => `${row.kind}:${row.originalLine ?? '-'}:${row.modifiedLine ?? '-'}`),
    hunks: hunks.map((hunk) => `${hunk.index}@${hunk.originalStartLine}:${hunk.modifiedStartLine}`),
  };
}

describe('выравнивание версий', () => {
  it('совпадающие тексты — все ряды равны, блоков нет', () => {
    const result = summary('a\nb\nc', 'a\nb\nc');
    expect(result.rows).toEqual(['equal:1:1', 'equal:2:2', 'equal:3:3']);
    expect(result.hunks).toEqual([]);
  });

  it('изменённая строка — один ряд-замена', () => {
    const { rows, hunks } = buildDiff('a\nb\nc', 'a\nB\nc');
    expect(rows[1]).toMatchObject({
      kind: 'replace',
      originalLine: 2,
      modifiedLine: 2,
      originalText: 'b',
      modifiedText: 'B',
    });
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ originalStartLine: 2, modifiedStartLine: 2, originalCount: 1, modifiedCount: 1 });
  });

  it('вставка строки — ряд со стороны только изменённой версии', () => {
    const { rows, hunks } = buildDiff('a\nc', 'a\nb\nc');
    expect(rows.map((row) => row.kind)).toEqual(['equal', 'insert', 'equal']);
    expect(rows[1]).toMatchObject({ originalLine: null, modifiedLine: 2, modifiedText: 'b' });
    expect(hunks[0]).toMatchObject({ originalStartLine: 2, modifiedStartLine: 2 });
  });

  it('удаление строки — ряд со стороны только исходной версии', () => {
    const { rows, hunks } = buildDiff('a\nb\nc', 'a\nc');
    expect(rows.map((row) => row.kind)).toEqual(['equal', 'delete', 'equal']);
    expect(rows[1]).toMatchObject({ originalLine: 2, modifiedLine: null, originalText: 'b' });
    expect(hunks[0]).toMatchObject({ originalStartLine: 2, modifiedStartLine: 2 });
  });

  it('блок из нескольких строк: замены, затем лишние вставки и удаления', () => {
    // Две строки исходной заменяются тремя: две пары-замены и одна вставка.
    const { rows } = buildDiff('x\n1\n2\ny', 'x\nA\nB\nC\ny');
    expect(rows.map((row) => row.kind)).toEqual(['equal', 'replace', 'replace', 'insert', 'equal']);
    expect(rows[3]).toMatchObject({ originalLine: null, modifiedLine: 4, modifiedText: 'C' });
  });

  it('несколько блоков — отдельные хунки', () => {
    const { hunks } = buildDiff('a\nb\nc\nd\ne', 'a\nB\nc\nD\ne');
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ originalStartLine: 2, modifiedStartLine: 2 });
    expect(hunks[1]).toMatchObject({ originalStartLine: 4, modifiedStartLine: 4 });
  });

  it('чистая вставка в пустой файл', () => {
    const { rows, hunks } = buildDiff('', 'a\nb');
    expect(rows.map((row) => row.kind)).toEqual(['insert', 'insert']);
    expect(hunks[0]).toMatchObject({ originalStartLine: 1, modifiedStartLine: 1, modifiedCount: 2, originalCount: 0 });
  });

  it('чистое удаление всего файла', () => {
    const { rows, hunks } = buildDiff('a\nb', '');
    expect(rows.map((row) => row.kind)).toEqual(['delete', 'delete']);
    expect(hunks[0]).toMatchObject({ originalCount: 2, modifiedCount: 0 });
  });

  it('завершающий перевод строки не даёт фантомной строки', () => {
    // Оба файла с \n в конце и одинаковым содержимым — изменений нет.
    expect(buildDiff('a\nb\n', 'a\nb\n').hunks).toEqual([]);
  });
});
