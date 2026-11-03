import { describe, expect, it } from 'vitest';
import { diffAgainstBase } from '../src/shared/merge-diff';

/**
 * Подсказка «что изменила сторона против общего предка».
 *
 * Главная ловушка, которую здесь стерегут: состояние `same` не должно превратиться
 * в `changed` у всех — тогда сторона выглядит переписанной целиком и подсказка
 * вреднее, чем ничего.
 */
describe('сравнение с общим предком', () => {
  it('обе стороны повторили базу — сравнивать нечего', () => {
    expect(diffAgainstBase('a\nb\n', 'a\nb\n', 'a\nb\n')).toEqual([]);
  });

  it('общая строка остаётся нетронутой, изменённая не остаётся', () => {
    const [hunk] = diffAgainstBase('a\nOURS\nd\n', 'a\nTHEIRS\nd\n', 'a\nb\nd\n');
    expect(hunk?.ours).toEqual([{ text: 'OURS', line: 2, state: 'changed' }]);
    expect(hunk?.theirs).toEqual([{ text: 'THEIRS', line: 2, state: 'changed' }]);
    expect(hunk?.baseLines).toBe(1);
  });

  it('нетронутая строка в спорном абзаце видна как same', () => {
    // Важно, чтобы сторона была видна ЦЕЛИКОМ: вырезать нетронутые строки из абзаца
    // — значит показывать правку в отрыве от места, где она сделана.
    const [hunk] = diffAgainstBase('a\nb\n', 'a\nTHEIRS\n', 'a\nb\n');
    expect(hunk?.ours).toEqual([{ text: 'b', line: 2, state: 'same' }]);
    expect(hunk?.theirs).toEqual([{ text: 'THEIRS', line: 2, state: 'changed' }]);
  });

  it('правки в разных местах — разные абзацы', () => {
    const hunks = diffAgainstBase('X\nb\nc\nY\n', 'a\nb\nc\nd\n', 'a\nb\nc\nd\n');
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.ours[0]).toEqual({ text: 'X', line: 1, state: 'changed' });
    expect(hunks[1]?.ours[0]).toEqual({ text: 'Y', line: 4, state: 'changed' });
  });

  it('пустая база — подсказки нет', () => {
    expect(diffAgainstBase('a\n', 'b\n', '')).toEqual([]);
  });
});
