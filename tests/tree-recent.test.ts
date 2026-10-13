import { describe, expect, it } from 'vitest';
import { isRecentlyModified, RECENT_WINDOW_MS, recentLabel } from '../src/renderer/core/tree-recent';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = 1_700_000_000_000;

describe('isRecentlyModified: тронут ли файл недавно', () => {
  it('файл в пределах окна — свежий', () => {
    expect(isRecentlyModified(NOW - MINUTE, NOW)).toBe(true);
    expect(isRecentlyModified(NOW - 23 * HOUR, NOW)).toBe(true);
  });

  it('файл старше окна — нет', () => {
    expect(isRecentlyModified(NOW - RECENT_WINDOW_MS - 1, NOW)).toBe(false);
    expect(isRecentlyModified(NOW - 30 * HOUR, NOW)).toBe(false);
  });

  it('ровно на границе окна — ещё свежий', () => {
    expect(isRecentlyModified(NOW - RECENT_WINDOW_MS, NOW)).toBe(true);
  });

  it('окно задаётся: час — значит час', () => {
    expect(isRecentlyModified(NOW - 30 * MINUTE, NOW, HOUR)).toBe(true);
    expect(isRecentlyModified(NOW - 2 * HOUR, NOW, HOUR)).toBe(false);
  });

  it('время «в будущем» считаем свежим: часы на машинах расходятся', () => {
    expect(isRecentlyModified(NOW + 5 * MINUTE, NOW)).toBe(true);
  });

  it('время неизвестно (0) или битое — не свежий', () => {
    expect(isRecentlyModified(0, NOW)).toBe(false);
    expect(isRecentlyModified(Number.NaN, NOW)).toBe(false);
    expect(isRecentlyModified(-5, NOW)).toBe(false);
  });

  it('окно ноль или отрицательное — не свежий никто', () => {
    expect(isRecentlyModified(NOW, NOW, 0)).toBe(false);
    expect(isRecentlyModified(NOW, NOW, -1)).toBe(false);
  });
});

describe('recentLabel: когда тронут — словами', () => {
  it('секунды и минуты', () => {
    expect(recentLabel(NOW - 5 * 1000, NOW)).toBe('только что');
    expect(recentLabel(NOW - 5 * MINUTE, NOW)).toBe('5 мин назад');
    expect(recentLabel(NOW - 59 * MINUTE, NOW)).toBe('59 мин назад');
  });

  it('часы и дни', () => {
    expect(recentLabel(NOW - 3 * HOUR, NOW)).toBe('3 ч назад');
    expect(recentLabel(NOW - 25 * HOUR, NOW)).toBe('вчера');
    expect(recentLabel(NOW - 3 * RECENT_WINDOW_MS, NOW)).toBe('3 дн назад');
  });

  it('правка «в будущем» — «только что», а не «через час»', () => {
    expect(recentLabel(NOW + HOUR, NOW)).toBe('только что');
  });

  it('время неизвестно — пусто', () => {
    expect(recentLabel(0, NOW)).toBe('');
    expect(recentLabel(Number.NaN, NOW)).toBe('');
  });
});
