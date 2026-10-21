import { describe, expect, it } from 'vitest';
import {
  PERF_SLACK_SHARE,
  createPerfTracker,
  parsePerfBaseline,
  perfBaselineFrom,
  perfEnabled,
  perfRegressions,
  summarizePerf,
} from '../src/shared/perf';

/**
 * Замеры нужны, чтобы сползание скорости было видно числом, а не «кажется,
 * стало медленнее». Поэтому проверяем не только счёт, но и главное свойство:
 * выключенный трекер молчит и ничего не стоит.
 */

describe('трекер фаз', () => {
  it('выключенный не пишет ничего и не ломается', () => {
    const tracker = createPerfTracker({ enabled: false });
    tracker.begin('app:boot');
    expect(tracker.end('app:boot')).toBeNull();
    expect(tracker.record('search:project', 10)).toBeNull();
    expect(tracker.spans()).toEqual([]);
    expect(tracker.enabled).toBe(false);
  });

  it('включённый считает по своим часам', () => {
    let clock = 100;
    const tracker = createPerfTracker({ enabled: true, now: () => clock });
    tracker.begin('app:boot');
    clock = 340;
    expect(tracker.end('app:boot')).toEqual({ phase: 'app:boot', ms: 240 });
    tracker.begin('app:boot');
    clock = 600;
    expect(tracker.end('app:boot')?.ms).toBe(260);
  });

  it('end без begin — null, а не минус бесконечность', () => {
    const tracker = createPerfTracker({ enabled: true, now: () => 5 });
    expect(tracker.end('project:paint')).toBeNull();
  });

  it('включается на ходу: до этого молчал', () => {
    const tracker = createPerfTracker({ enabled: false });
    tracker.begin('app:boot');
    tracker.setEnabled(true);
    expect(tracker.end('app:boot')).toBeNull();
    tracker.begin('app:boot');
    expect(tracker.end('app:boot')).not.toBeNull();
  });
});

describe('сводка', () => {
  it('по строке на фазу, время — худшее, порядок — по убыванию', () => {
    const summary = summarizePerf([
      { phase: 'search:project', ms: 40 },
      { phase: 'app:boot', ms: 900 },
      { phase: 'search:project', ms: 120 },
    ]);
    expect(summary).toEqual([
      { phase: 'app:boot', ms: 900, samples: 1 },
      { phase: 'search:project', ms: 120, samples: 2 },
    ]);
  });
});

describe('база и регрессии', () => {
  const base = {
    version: 1 as const,
    takenAt: '2026-10-21T00:00:00.000Z',
    spans: [{ phase: 'app:boot' as const, ms: 1000 }],
  };

  it('база собирается из живых замеров', () => {
    const built = perfBaselineFrom([{ phase: 'app:boot', ms: 999.6 }], { machine: 'linux' });
    expect(built.version).toBe(1);
    expect(built.machine).toBe('linux');
    expect(built.spans).toEqual([{ phase: 'app:boot', ms: 1000 }]);
  });

  it('в пределах запаса — не регрессия', () => {
    const atLimit = 1000 * (1 + PERF_SLACK_SHARE * 0.9);
    expect(perfRegressions([{ phase: 'app:boot', ms: atLimit }], base)).toEqual([]);
  });

  it('сверх запаса — регрессия с числами', () => {
    const [found] = perfRegressions([{ phase: 'app:boot', ms: 2000 }], base);
    expect(found?.phase).toBe('app:boot');
    expect(found?.baseMs).toBe(1000);
    expect(found?.limitMs).toBe(1500);
  });

  it('новая фаза не считается сползанием', () => {
    expect(perfRegressions([{ phase: 'chat:first-token', ms: 9999 }], base)).toEqual([]);
  });

  it('битая база — null, а не падение', () => {
    expect(parsePerfBaseline('не json')).toBeNull();
    expect(parsePerfBaseline('{"version":2,"spans":[]}')).toBeNull();
    expect(parsePerfBaseline(JSON.stringify(base))?.spans[0]?.ms).toBe(1000);
  });
});

describe('флаг включения', () => {
  it('понимает 1, on, true, yes — и ничего больше', () => {
    for (const flag of ['1', 'on', 'TRUE', ' yes ']) expect(perfEnabled(flag)).toBe(true);
    for (const flag of [null, '', '0', 'off', 'нет']) expect(perfEnabled(flag)).toBe(false);
  });
});
