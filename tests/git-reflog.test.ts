import { describe, expect, it } from 'vitest';
import { parseReflog } from '../src/shared/git-reflog';

const line = (hash: string, ref: string, date: string, action: string): string =>
  `${hash}\u001f${ref}\u001f${date}\u001f${action}`;

describe('parseReflog', () => {
  it('пустой вывод — пустой список', () => {
    expect(parseReflog('')).toEqual([]);
    expect(parseReflog('\n')).toEqual([]);
  });

  it('разбирает запись целиком', () => {
    expect(parseReflog(line('a1b2c3d', 'HEAD@{0}', '2024-01-02', 'commit: правка'))).toEqual([
      { hash: 'a1b2c3d', ref: 'HEAD@{0}', date: '2024-01-02', action: 'commit: правка' },
    ]);
  });

  it('несколько записей — по строкам', () => {
    const text = [
      line('aaa1111', 'HEAD@{0}', '2024-02-01', 'reset: moving to HEAD~1'),
      line('bbb2222', 'HEAD@{1}', '2024-01-30', 'commit: второй'),
    ].join('\n');
    expect(parseReflog(text)).toHaveLength(2);
    expect(parseReflog(text)[0]!.ref).toBe('HEAD@{0}');
  });

  it('описание может содержать разделители — оно берётся целиком', () => {
    expect(parseReflog(line('abc1234', 'HEAD@{0}', '2024-01-01', 'checkout: moving to main'))).toEqual([
      { hash: 'abc1234', ref: 'HEAD@{0}', date: '2024-01-01', action: 'checkout: moving to main' },
    ]);
  });

  it('строки без ссылки пропускаются', () => {
    expect(parseReflog(['мусор', 'a1b2c3d\u001f\u001f\u001f', line('v', 'HEAD@{0}', 'д', 'ок')].join('\n'))).toEqual([
      { hash: 'v', ref: 'HEAD@{0}', date: 'д', action: 'ок' },
    ]);
  });
});
