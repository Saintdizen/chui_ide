import { describe, expect, it } from 'vitest';
import type { FileEdit } from '../src/shared/edits';
import { previewFile } from '../src/renderer/ui/chat-approvals';

/**
 * Предпросмотр правок: по тексту файла и правкам строится то, что видно в ревью.
 *
 * Проверяем чистую часть — без DOM: где именно вырезаются строки, как выглядит
 * подпись диапазона и что происходит, когда правок или строк больше, чем ревью
 * готово показать.
 */

/**
 * Правка-замена: диапазон от начала строки до её конца. `endColumn` намеренно
 * больше любой строки — иначе диапазон вышел бы пустым, а пустой диапазон в DAP
 * означает вставку (у неё удаляемых строк нет).
 */
const edit = (startLine: number, endLine: number, newText: string) => ({
  startLine,
  startColumn: 1,
  endLine,
  endColumn: 1000,
  newText,
});

describe('previewFile', () => {
  it('показывает удалённые строки из файла и добавленные из правки', () => {
    const file: FileEdit = { path: '/proj/a.ts', edits: [edit(2, 2, 'новое\n')] };
    const preview = previewFile(file, 'первая\nвторая\nтретья');

    expect(preview.path).toBe('/proj/a.ts');
    expect(preview.hunks).toHaveLength(1);
    expect(preview.hunks[0]?.removed).toEqual(['вторая']);
    // Хвостовой перевод строки в newText не превращается в пустую добавленную строку.
    expect(preview.hunks[0]?.added).toEqual(['новое']);
  });

  it('подпись диапазона: одна строка или несколько', () => {
    const single = previewFile({ path: 'a', edits: [edit(3, 3, 'x')] }, 'a\nb\nc\nd');
    expect(single.hunks[0]?.label).toBe('строка 3');

    const range = previewFile({ path: 'a', edits: [edit(2, 4, 'x')] }, 'a\nb\nc\nd\ne');
    expect(range.hunks[0]?.label).toBe('строки 2–4');
    expect(range.hunks[0]?.removed).toEqual(['b', 'c', 'd']);
  });

  it('удаление без добавления: добавленных строк нет', () => {
    const preview = previewFile({ path: 'a', edits: [edit(2, 2, '')] }, 'a\nb\nc');
    expect(preview.hunks[0]?.removed).toEqual(['b']);
    expect(preview.hunks[0]?.added).toEqual([]);
  });

  it('файл прочитать не удалось — это видно в предпросмотре', () => {
    const preview = previewFile({ path: '/proj/a.ts', edits: [edit(1, 1, 'x')] }, null);
    expect(preview.error).toBe('не удалось прочитать файл');
    expect(preview.hunks).toEqual([]);
  });

  it('длинную пачку правок показывает не целиком и говорит, сколько осталось', () => {
    const edits = Array.from({ length: 25 }, (_, index) => edit(index + 1, index + 1, 'x'));
    const text = Array.from({ length: 25 }, () => 'line').join('\n');
    const preview = previewFile({ path: 'a', edits }, text);

    expect(preview.hunks).toHaveLength(20);
    expect(preview.extra).toBe(5);
  });

  it('длинную правку обрезает по строкам', () => {
    const many = Array.from({ length: 30 }, (_, index) => `new ${index}`).join('\n');
    const preview = previewFile({ path: 'a', edits: [edit(1, 1, many)] }, 'old');
    expect(preview.hunks[0]?.added).toHaveLength(20);
  });

  it('несколько правок одного файла — отдельные блоки', () => {
    const preview = previewFile({ path: 'a', edits: [edit(1, 1, 'x'), edit(3, 3, 'y')] }, 'a\nb\nc');
    expect(preview.hunks).toHaveLength(2);
    expect(preview.extra).toBe(0);
  });

  it('вставка не показывает строку как удалённую', () => {
    // Нулевой диапазон — это вставка перед строкой: ничего не удаляется, и
    // показывать существующую строку как удалённую было бы враньём.
    const insertion = { startLine: 2, startColumn: 1, endLine: 2, endColumn: 1, newText: 'новая\n' };
    const preview = previewFile({ path: 'a', edits: [insertion] }, 'первая\nвторая\nтретья');
    expect(preview.hunks[0]?.removed).toEqual([]);
    expect(preview.hunks[0]?.added).toEqual(['новая']);
  });
});
