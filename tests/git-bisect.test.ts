import { describe, expect, it } from 'vitest';
import { parseBisectFirstBad, parseBisectProgress, parseBisectState } from '../src/shared/git-bisect';

/**
 * Разбор хода `git bisect`: строки «Bisecting: … left to test» и итоговое
 * «X is the first bad commit». Тексты взяты в том виде, в каком их печатает git.
 */
describe('parseBisectProgress', () => {
  it('читает остаток версий и примерное число шагов', () => {
    const text = 'Bisecting: 3 revisions left to test after this (roughly 2 steps)';
    expect(parseBisectProgress(text)).toEqual({ remaining: 3, steps: 2 });
  });

  it('одна версия и один шаг — тоже по-английски в единственном числе', () => {
    expect(parseBisectProgress('Bisecting: 1 revision left to test after this (roughly 1 step)')).toEqual({
      remaining: 1,
      steps: 1,
    });
  });

  it('без такой строки — неизвестно', () => {
    expect(parseBisectProgress('что-то другое')).toEqual({ remaining: null, steps: null });
  });
});

describe('parseBisectFirstBad', () => {
  it('находит хеш первого плохого коммита', () => {
    expect(parseBisectFirstBad('abc1234 is the first bad commit')).toBe('abc1234');
  });

  it('полное «detached HEAD» сообщение тоже подходит', () => {
    const text = '4f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a is the first bad commit';
    expect(parseBisectFirstBad(text)).toBe('4f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a');
  });

  it('если итога нет — null', () => {
    expect(parseBisectFirstBad('Bisecting: 3 revisions left')).toBeNull();
  });
});

describe('parseBisectState', () => {
  it('поиск идёт: активен, остаток известен', () => {
    expect(parseBisectState('Bisecting: 5 revisions left to test after this (roughly 3 steps)', true)).toEqual({
      active: true,
      remaining: 5,
      steps: 3,
      firstBad: null,
    });
  });

  it('поиск нашёл виновника: активным больше не считается', () => {
    expect(parseBisectState('abc1234 is the first bad commit', true)).toEqual({
      active: false,
      remaining: null,
      steps: null,
      firstBad: 'abc1234',
    });
  });

  it('без файла BISECT_START поиск не идёт, что бы ни было в тексте', () => {
    expect(parseBisectState('Bisecting: 5 revisions left to test after this (roughly 3 steps)', false).active).toBe(
      false,
    );
  });
});
