import { describe, expect, it } from 'vitest';
import { RepeatTracker } from '../src/main/ai/repeat-tracker';

/**
 * Сквозной счётчик повторов ответов (п.65).
 *
 * Внутри одного ответа повторы свёрнуты, а между шагами их не было видно: тот
 * же run_tests, тот же git status, тот же terminal. Первый повтор ещё отдаём —
 * рядом с ним модель видит, что спросила дважды, — а с третьего подряд
 * заменяем пометкой.
 */

const same = 'совпадений: 3\nsrc/a.ts:10\nsrc/a.ts:20';

describe('трекер повторов', () => {
  it('новый ответ — не трогаем', () => {
    const tracker = new RepeatTracker();
    expect(tracker.note('search\u0000a', same, 'search: 3')).toBeUndefined();
    expect(tracker.stats().collapsed).toBe(0);
  });

  it('второй подряд отдаём, третий — сворачиваем', () => {
    const tracker = new RepeatTracker();
    tracker.note('k', same, 'search: 3');
    expect(tracker.note('k', same, 'search: 3')).toBeUndefined();
    const note = tracker.note('k', same, 'search: 3');
    expect(note).toBeDefined();
    expect(note).toContain('search: 3');
    expect(note).toContain('ничего не изменилось');
    expect(tracker.stats()).toEqual({ collapsed: 1, savedChars: same.length });
  });

  it('другой ответ сбрасывает счёт', () => {
    const tracker = new RepeatTracker();
    tracker.note('k', same, 'a');
    tracker.note('k', same, 'a');
    expect(tracker.note('k', 'другое', 'b')).toBeUndefined();
    expect(tracker.note('k', same, 'a')).toBeUndefined();
  });

  it('разные ключи считаются раздельно', () => {
    const tracker = new RepeatTracker();
    tracker.note('a', same, 'x');
    tracker.note('b', same, 'x');
    expect(tracker.note('a', same, 'x')).toBeUndefined();
    expect(tracker.note('b', same, 'x')).toBeUndefined();
  });

  it('правка файла забывает ключи этого файла', () => {
    const tracker = new RepeatTracker();
    tracker.note('run_tests\u0000src/a.ts', same, 'x');
    tracker.note('run_tests\u0000src/a.ts', same, 'x');
    tracker.forget('run_tests\u0000src/a.ts');
    expect(tracker.note('run_tests\u0000src/a.ts', same, 'x')).toBeUndefined();
  });

  it('потолок отпечатков держится', () => {
    const tracker = new RepeatTracker(2);
    tracker.note('a', '1', 'a');
    tracker.note('b', '2', 'b');
    tracker.note('c', '3', 'c');
    // Самый старый вытеснен — он снова «новый».
    expect(tracker.note('a', '1', 'a')).toBeUndefined();
  });
});
