/**
 * Замеры фаз работы приложения.
 *
 * До сих пор `performance.now()` в renderer был ровно один — вокруг ответа модели.
 * Любая правка интерфейса «для скорости» делалась на глаз, и сползание замечалось
 * только жалобой. Здесь — одна точка, куда фазы пишут своё время, и одна форма
 * ответа: список фаз с миллисекундами.
 *
 * Замеры бесплатны, когда выключены: `begin`/`end` сразу выходят, а `now()` не
 * зовётся вовсе. Включаются флагом (см. `perfEnabled`), а не всегда — иначе любой
 * прогон начинает мерить то, что никому не нужно.
 *
 * Абсолютные числа в CI плавают: машина занята, диск холодный. Поэтому бюджет —
 * не «не больше N мс», а «не хуже базовой линии с запасом»: базу снимают один
 * раз на своей машине и хранят рядом с кодом, а сравнение даёт регрессию в
 * процентах. База, придуманная на глаз, ловила бы не сползание, а разницу машин.
 */

/** Фаза, которую меряем. Список закрыт: новая фаза — новая строка здесь. */
export type PerfPhase =
  /** main: старт приложения → окно показано. */
  | 'main:window'
  /** renderer: загрузка бандла → интерфейс смонтирован. */
  | 'app:boot'
  /** Открытие проекта: запрос → модели известно дерево. */
  | 'project:open'
  /** Открытие проекта → первый кадр с новым деревом. */
  | 'project:paint'
  /** Поиск по проекту: запрос → результат. */
  | 'search:project'
  /** Отправка сообщения → первый токен ответа. */
  | 'chat:first-token';

/** Один замер: фаза и сколько она заняла. */
export interface PerfSpan {
  phase: PerfPhase;
  ms: number;
}

/** Сводка по фазе: худший замер и сколько раз мерили. */
export interface PerfSummary {
  phase: PerfPhase;
  ms: number;
  samples: number;
}

/**
 * Включены ли замеры. Флаг приходит снаружи: renderer не видит переменных
 * окружения так же, как main (у него своё окно и свой `location`).
 */
export function perfEnabled(flag: string | null | undefined): boolean {
  if (!flag) return false;
  const value = flag.trim().toLowerCase();
  return value === '1' || value === 'on' || value === 'true' || value === 'yes';
}

/** Значение `now()` по умолчанию: в renderer — точные часы браузера. */
function defaultNow(): number {
  return typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

export interface PerfTracker {
  /** Включён ли трекер: выключенный не пишет ничего. */
  readonly enabled: boolean;
  /** Включить замеры на ходу: зовётся из `enablePerf`, до первого замера. */
  setEnabled(on: boolean): void;
  /** Начать фазу. Повторный `begin` той же фазы начинает заново. */
  begin(phase: PerfPhase): void;
  /** Закончить фазу. `null` — фаза не начиналась или трекер выключен. */
  end(phase: PerfPhase): PerfSpan | null;
  /** Записать готовое время: когда начало фазы живёт в другом месте. */
  record(phase: PerfPhase, ms: number): PerfSpan | null;
  /** Все замеры в порядке появления. */
  spans(): PerfSpan[];
}

export function createPerfTracker(options: {
  enabled: boolean;
  now?: () => number;
  /** Куда отдать готовый замер: по умолчанию — никуда, только в `spans()`. */
  onSpan?: (span: PerfSpan) => void;
}): PerfTracker {
  const now = options.now ?? defaultNow;
  let on = options.enabled;
  const started = new Map<PerfPhase, number>();
  const collected: PerfSpan[] = [];

  const push = (span: PerfSpan): PerfSpan => {
    collected.push(span);
    options.onSpan?.(span);
    return span;
  };

  return {
    get enabled() {
      return on;
    },
    setEnabled(next) {
      on = next;
    },
    begin(phase) {
      if (!on) return;
      started.set(phase, now());
    },
    end(phase) {
      if (!on) return null;
      const at = started.get(phase);
      if (at === undefined) return null;
      started.delete(phase);
      return push({ phase, ms: now() - at });
    },
    record(phase, ms) {
      if (!on) return null;
      return push({ phase, ms });
    },
    spans() {
      return [...collected];
    },
  };
}

/**
 * Сводка: по одной строке на фазу, время — худшее.
 *
 * Худшее, а не среднее: поиск по проекту на большом проекте бьёт по отзывчивости
 * именно своим максимумом, а среднее по мелким запросам его размывает.
 */
export function summarizePerf(spans: PerfSpan[]): PerfSummary[] {
  const byPhase = new Map<PerfPhase, PerfSummary>();
  for (const span of spans) {
    const seen = byPhase.get(span.phase);
    if (!seen) {
      byPhase.set(span.phase, { phase: span.phase, ms: span.ms, samples: 1 });
      continue;
    }
    seen.samples += 1;
    if (span.ms > seen.ms) seen.ms = span.ms;
  }
  return [...byPhase.values()].sort((a, b) => b.ms - a.ms);
}

/** Запас к базовой линии: 50% — шум машины и прогрева, а не сползание. */
export const PERF_SLACK_SHARE = 0.5;

/** База замеров: что считаем «как было». */
export interface PerfBaseline {
  /** Версия формата: база без неё — из другого времени и не годится. */
  version: 1;
  /** Когда снимали (ISO). Нужна, чтобы понимать, с чем сравниваем. */
  takenAt: string;
  /** Машина: число ядер и платформа, иначе сравнение бессмысленно. */
  machine?: string;
  spans: Array<{ phase: PerfPhase; ms: number }>;
}

/** Снятая регрессия: фаза стала медленнее базы сверх запаса. */
export interface PerfRegression {
  phase: PerfPhase;
  ms: number;
  baseMs: number;
  /** Порог, выше которого это уже регрессия (`baseMs` + запас). */
  limitMs: number;
}

/**
 * Сравнить замеры с базой.
 *
 * Фазы, которых нет в базе, не считаются регрессией: новая фаза — это новый
 * замер, а не сползание. Фазы, которых нет в замерах, тоже молчат: не мерили —
 * значит нечего сказать.
 */
export function perfRegressions(
  spans: PerfSpan[],
  baseline: PerfBaseline | null,
  slackShare = PERF_SLACK_SHARE,
): PerfRegression[] {
  if (baseline?.version !== 1) return [];
  const base = new Map(baseline.spans.map((span) => [span.phase, span.ms]));
  const regressions: PerfRegression[] = [];
  for (const summary of summarizePerf(spans)) {
    const baseMs = base.get(summary.phase);
    if (baseMs === undefined) continue;
    const limitMs = baseMs * (1 + Math.max(0, slackShare));
    if (summary.ms > limitMs) {
      regressions.push({ phase: summary.phase, ms: summary.ms, baseMs, limitMs });
    }
  }
  return regressions.sort((a, b) => b.ms / b.baseMs - a.ms / a.baseMs);
}

/** Собрать базу из текущих замеров: так она и появляется — из живого прогона. */
export function perfBaselineFrom(spans: PerfSpan[], meta: { takenAt?: string; machine?: string } = {}): PerfBaseline {
  return {
    version: 1,
    takenAt: meta.takenAt ?? new Date().toISOString(),
    ...(meta.machine ? { machine: meta.machine } : {}),
    spans: summarizePerf(spans).map(({ phase, ms }) => ({ phase, ms: Math.round(ms) })),
  };
}

/** Разбор базы из файла: битый или чужой формат —`null`, а не падение. */
export function parsePerfBaseline(text: string): PerfBaseline | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Partial<PerfBaseline>;
    if (candidate.version !== 1 || !Array.isArray(candidate.spans)) return null;
    const spans = candidate.spans
      .filter(
        (span): span is { phase: PerfPhase; ms: number } =>
          typeof span === 'object' &&
          span !== null &&
          typeof (span as { phase?: unknown }).phase === 'string' &&
          typeof (span as { ms?: unknown }).ms === 'number',
      )
      .map((span) => ({ phase: span.phase, ms: span.ms }));
    return {
      version: 1,
      takenAt: typeof candidate.takenAt === 'string' ? candidate.takenAt : '',
      ...(typeof candidate.machine === 'string' ? { machine: candidate.machine } : {}),
      spans,
    };
  } catch {
    return null;
  }
}

/**
 * Прибор по умолчанию: один на процесс.
 *
 * Фазы пересекают границы модулей (открытие проекта начинается в модели и
 * заканчивается в `app.ts`), поэтому трекер — общий, а не по файлу.
 */
export const perf = createPerfTracker({ enabled: false });

/** Включить замеры в этом процессе. Зовётся один раз при старте. */
export function enablePerf(on = true): PerfTracker {
  perf.setEnabled(on);
  return perf;
}
