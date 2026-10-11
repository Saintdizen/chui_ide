import { describe, expect, it } from 'vitest';
import { parseStashList } from '../src/shared/git-stash';

const line = (ref: string, subject: string): string => `${ref}\u001f${subject}`;

describe('parseStashList', () => {
  it('пустой вывод — пустой список', () => {
    expect(parseStashList('')).toEqual([]);
    expect(parseStashList('\n')).toEqual([]);
  });

  it('запись без сообщения: ветка и заголовок коммита', () => {
    expect(parseStashList(line('stash@{0}', 'WIP on main: 1a2b3c4 правка'))).toEqual([
      { index: 0, ref: 'stash@{0}', message: 'правка', branch: 'main' },
    ]);
  });

  it('запись с сообщением -m', () => {
    expect(parseStashList(line('stash@{1}', 'On feature/login: доработки формы'))).toEqual([
      { index: 1, ref: 'stash@{1}', message: 'доработки формы', branch: 'feature/login' },
    ]);
  });

  it('несколько записей — по строкам, в порядке вывода', () => {
    const text = [line('stash@{0}', 'On main: свежая'), line('stash@{1}', 'WIP on dev: abc старее')].join('\n');
    expect(parseStashList(text).map((entry) => entry.index)).toEqual([0, 1]);
    expect(parseStashList(text)[0]!.branch).toBe('main');
    expect(parseStashList(text)[1]!.branch).toBe('dev');
  });

  it('незнакомый заголовок сохраняется как есть, ветка — null', () => {
    expect(parseStashList(line('stash@{2}', 'просто текст'))).toEqual([
      { index: 2, ref: 'stash@{2}', message: 'просто текст', branch: null },
    ]);
  });

  it('строки без ссылки stash пропускаются', () => {
    const text = ['мусор', line('HEAD', 'не stash'), line('stash@{0}', 'WIP on main: 1a2b3c4 ok')].join('\n');
    expect(parseStashList(text)).toEqual([{ index: 0, ref: 'stash@{0}', message: 'ok', branch: 'main' }]);
  });
});
