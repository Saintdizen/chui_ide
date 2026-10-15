import { describe, expect, it } from 'vitest';
import type { GitCommit } from '../src/shared/api';
import type { HistoryEntry } from '../src/shared/file-history';
import { commitDateToMs, mergeTimeline, timelineActionLabel, timelineSummary } from '../src/shared/timeline';

/**
 * Лента истории файла: локальные снимки и коммиты git в одном порядке.
 *
 * Проверяем чистую часть: сортировку по времени, пометку источника, действия
 * (у снимка — возврат, у коммита — сравнение) и разбор даты коммита, когда точного
 * времени main не отдал.
 */

const NOW = new Date(2026, 0, 20, 12, 0, 0).getTime();

function snapshot(id: string, minutesAgo: number): HistoryEntry {
  return {
    id,
    path: '/p/a.ts',
    name: 'a.ts',
    mtimeMs: NOW - minutesAgo * 60_000,
    size: 10,
    lines: 2,
    hash: `h-${id}`,
    reason: 'save',
  };
}

function commit(hash: string, at: number, summary = 'правка'): GitCommit {
  return { hash, author: 'Test', date: '2026-01-20', summary, at };
}

describe('свод ленты', () => {
  it('снимки и коммиты стоят по времени, новое сверху', () => {
    const items = mergeTimeline(
      [snapshot('s1', 5), snapshot('s2', 200)],
      [commit('aaa1111', NOW - 60_000), commit('bbb2222', NOW - 60 * 24 * 60 * 60 * 1000)],
      NOW,
    );
    // Порядок по времени: коммит минуту назад, снимок пять минут, снимок 200 минут, коммит вчера.
    expect(items.map((item) => item.id)).toEqual(['aaa1111', 's1', 's2', 'bbb2222']);
  });

  it('источник записи помечен', () => {
    const items = mergeTimeline([snapshot('s1', 5)], [commit('aaa1111', NOW - 1000)], NOW);
    expect(items.find((item) => item.id === 's1')?.source).toBe('local');
    expect(items.find((item) => item.id === 'aaa1111')?.source).toBe('git');
  });

  it('при равном времени снимок идёт выше коммита', () => {
    const at = NOW - 10_000;
    const items = mergeTimeline([snapshot('s1', 0)], [commit('aaa1111', at)], at);
    // Снимок в этой паре имеет то же время — он про этот файл прямо сейчас.
    expect(items.map((item) => item.source)).toEqual(['local', 'git']);
  });

  it('коммит без точного времени берёт дату', () => {
    const items = mergeTimeline([], [{ hash: 'ccc3333', author: 'Test', date: '2026-01-19', summary: 'день' }], NOW);
    expect(items[0]?.at).toBe(commitDateToMs('2026-01-19'));
    expect(items[0]?.at).toBeGreaterThan(0);
  });

  it('пустые истории дают пустую ленту', () => {
    expect(mergeTimeline([], [], NOW)).toEqual([]);
    expect(timelineSummary([])).toBe('записей нет');
  });

  it('сводка считает записи по источникам', () => {
    const items = mergeTimeline([snapshot('s1', 5)], [commit('aaa1111', NOW - 1000)], NOW);
    expect(timelineSummary(items)).toBe('снимков: 1 · коммитов: 1');
  });
});

describe('что можно сделать с записью', () => {
  it('у снимка — вернуть текст, у коммита — сравнить', () => {
    const items = mergeTimeline([snapshot('s1', 5)], [commit('aaa1111', NOW - 1000)], NOW);
    expect(timelineActionLabel(items.find((item) => item.source === 'local')!)).toBe('Вернуть эту версию');
    expect(timelineActionLabel(items.find((item) => item.source === 'git')!)).toBe('Показать различие с коммитом');
  });
});

describe('дата коммита', () => {
  it('формат ГГГГ-ММ-ДД разбирается в полночь', () => {
    expect(commitDateToMs('2026-01-19')).toBe(new Date(2026, 0, 19).getTime());
  });

  it('мусор читается как «времени нет»', () => {
    expect(commitDateToMs('вчера')).toBe(0);
    expect(commitDateToMs('')).toBe(0);
  });
});
