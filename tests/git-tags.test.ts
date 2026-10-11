import { describe, expect, it } from 'vitest';
import { parseTagList } from '../src/shared/git-tags';

const line = (name: string, commit: string, subject: string): string => `${name}\t${commit}\t${subject}`;

describe('parseTagList', () => {
  it('пустой вывод — пустой список', () => {
    expect(parseTagList('')).toEqual([]);
    expect(parseTagList('\n')).toEqual([]);
  });

  it('разбирает имя, коммит и заголовок', () => {
    expect(parseTagList(line('v1.2.0', 'a1b2c3d', 'релиз 1.2.0'))).toEqual([
      { name: 'v1.2.0', commit: 'a1b2c3d', subject: 'релиз 1.2.0' },
    ]);
  });

  it('несколько тегов — по строкам, в порядке вывода', () => {
    const text = [line('v1.0.0', 'aaa1111', 'первый'), line('v0.9.0', 'bbb2222', '')].join('\n');
    expect(parseTagList(text)).toEqual([
      { name: 'v1.0.0', commit: 'aaa1111', subject: 'первый' },
      { name: 'v0.9.0', commit: 'bbb2222', subject: '' },
    ]);
  });

  it('заголовок может быть пустым (лёгкий тег без темы)', () => {
    expect(parseTagList('v1.0.0\tabc1234')).toEqual([{ name: 'v1.0.0', commit: 'abc1234', subject: '' }]);
  });

  it('строки без имени пропускаются', () => {
    expect(parseTagList(['', '\tabc1234\tпусто', line('v2', 'ccc3333', 'ок')].join('\n'))).toEqual([
      { name: 'v2', commit: 'ccc3333', subject: 'ок' },
    ]);
  });
});
