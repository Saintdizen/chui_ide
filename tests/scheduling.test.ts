import { describe, expect, it } from 'vitest';
import {
  MAX_SCHEDULES,
  describeSchedule,
  dueSchedules,
  intervalLabel,
  nextRunAt,
  parseScheduleDate,
  parseScheduleTime,
  sanitizeSchedules,
  scheduleProblems,
  weekdaysLabel,
} from '../src/shared/scheduling';

/**
 * Расписание задач: арифметика времени и доверие к файлу.
 *
 * Часы проверяются на фиксированных моментах: «сейчас» передаётся аргументом,
 * поэтому тест не зависит от того, когда его запустили. Единственная внешняя
 * зависимость — база часовых поясов (`Intl`), и она в Node есть.
 */

/** Задача с разумными значениями по умолчанию: в каждом тесте меняем только нужное. */
const base = {
  id: 'task-1',
  title: 'Отчёт',
  prompt: 'Собери недельный отчёт',
  repeat: 'daily' as const,
  time: '09:00',
  timezone: 'Europe/Moscow',
  enabled: true,
  createdAt: 0,
};

/** 2026-03-10T06:00:00Z — вторник, 09:00 по Москве: время задачи уже прошло. */
const TUESDAY_9_MSK = Date.UTC(2026, 2, 10, 6, 0);

describe('время и дата в правиле', () => {
  it('разбирает время строго', () => {
    expect(parseScheduleTime('09:00')).toEqual({ hours: 9, minutes: 0 });
    expect(parseScheduleTime(' 23:59 ')).toEqual({ hours: 23, minutes: 59 });
    for (const bad of ['', '9', '9:5', '24:00', '12:60', '12:0a', 'девять']) {
      expect(parseScheduleTime(bad), bad).toBeNull();
    }
  });

  it('дата проверяется на существование', () => {
    expect(parseScheduleDate('2026-03-10')).toEqual({ year: 2026, month: 3, day: 10 });
    expect(parseScheduleDate('2026-02-31')).toBeNull();
    expect(parseScheduleDate('2026-3-10')).toBeNull();
    expect(parseScheduleDate('')).toBeNull();
  });
});

describe('следующее срабатывание', () => {
  it('ежедневная задача переезжает на завтра, если сегодняшнее время прошло', () => {
    const next = nextRunAt(base, TUESDAY_9_MSK);
    // 2026-03-11 09:00 по Москве (UTC+3) — среда.
    expect(next).toBe(Date.UTC(2026, 2, 11, 6, 0));
  });

  it('время впереди — срабатывание сегодня', () => {
    const next = nextRunAt({ ...base, time: '18:00' }, TUESDAY_9_MSK);
    expect(next).toBe(Date.UTC(2026, 2, 10, 15, 0));
  });

  it('недельная задача ищет ближайший выбранный день', () => {
    // Вторник; ждём пятницу.
    const next = nextRunAt({ ...base, repeat: 'weekly', weekdays: [5] }, TUESDAY_9_MSK);
    expect(new Date(next!).getUTCDay()).toBe(5);
    expect(next).toBe(Date.UTC(2026, 2, 13, 6, 0));
  });

  it('недельная задача без дней не срабатывает никогда', () => {
    expect(nextRunAt({ ...base, repeat: 'weekly', weekdays: [] }, TUESDAY_9_MSK)).toBeNull();
  });

  it('разовая задача в прошлом не срабатывает, а в будущем — срабатывает', () => {
    const past = nextRunAt({ ...base, repeat: 'once', date: '2026-03-01' }, TUESDAY_9_MSK);
    expect(past).toBeNull();
    const future = nextRunAt({ ...base, repeat: 'once', date: '2026-04-01' }, TUESDAY_9_MSK);
    expect(future).toBe(Date.UTC(2026, 3, 1, 6, 0));
  });

  it('выключенная задача не срабатывает', () => {
    expect(nextRunAt({ ...base, enabled: false }, TUESDAY_9_MSK)).toBeNull();
  });

  it('час срабатывания считается по зоне задачи, а не по местной', () => {
    // Один и тот же «09:00» в разных зонах — разные моменты (UTC и Москва).
    const utc = nextRunAt({ ...base, timezone: 'UTC' }, TUESDAY_9_MSK)!;
    const msk = nextRunAt({ ...base, timezone: 'Europe/Moscow' }, TUESDAY_9_MSK)!;
    expect(new Date(utc).toISOString()).toBe('2026-03-10T09:00:00.000Z');
    expect(new Date(msk).toISOString()).toBe('2026-03-11T06:00:00.000Z');
  });

  it('переход на летнее время не сдвигает задачу на час', () => {
    // Europe/Berlin: в ночь на 29 марта 2026 часы уходят с 02:00 на 03:00.
    // Задача «09:00 ежедневно» после перехода обязана остаться в 09:00 по Берлину (07:00Z).
    const before = nextRunAt(
      { ...base, timezone: 'Europe/Berlin' },
      Date.UTC(2026, 2, 28, 12, 0), // 28 марта, 13:00 по Берлину
    );
    expect(new Date(before!).toISOString()).toBe('2026-03-29T07:00:00.000Z');
  });

  it('несуществующее местное время переносится на следующий день, а не в полночь', () => {
    // 02:30 в Берлине 29 марта 2026 не существует: такой день выпадает из правила.
    const next = nextRunAt(
      { ...base, timezone: 'Europe/Berlin', time: '02:30' },
      Date.UTC(2026, 2, 28, 20, 0), // 28 марта, 21:00 по Берлину
    );
    // 30 марта 00:30 UTC — это 02:30 по Берлину уже летнего времени (UTC+2).
    expect(new Date(next!).toISOString()).toBe('2026-03-30T00:30:00.000Z');
  });

  it('сломанное правило не срабатывает и не бросает исключение', () => {
    expect(nextRunAt({ ...base, time: '' }, TUESDAY_9_MSK)).toBeNull();
    expect(nextRunAt({ ...base, timezone: 'Марс/Олимп' }, TUESDAY_9_MSK)).toBeNull();
  });
});

describe('кому пора', () => {
  it('берёт только включённые задачи с прошедшим временем, начиная с самой старой', () => {
    const list = [
      { ...base, id: 'now', nextRunAt: TUESDAY_9_MSK },
      { ...base, id: 'old', nextRunAt: TUESDAY_9_MSK - 5 * 60_000 },
      { ...base, id: 'ahead', nextRunAt: TUESDAY_9_MSK + 60_000 },
      { ...base, id: 'off', nextRunAt: TUESDAY_9_MSK, enabled: false },
      { ...base, id: 'never' },
    ];
    expect(dueSchedules(list, TUESDAY_9_MSK).map((item) => item.id)).toEqual(['old', 'now']);
  });
});

describe('чтение файла расписания', () => {
  it('принимает и массив, и обёртку { schedules }', () => {
    expect(sanitizeSchedules([base])).toHaveLength(1);
    expect(sanitizeSchedules({ schedules: [base] })).toHaveLength(1);
  });

  it('выбрасывает задачи без запроса, времени или с чужим поясом', () => {
    const list = sanitizeSchedules([
      base,
      { ...base, id: 'no-prompt', prompt: '  ' },
      { ...base, id: 'bad-time', time: '25:00' },
      { ...base, id: 'bad-zone', timezone: 'Nowhere/Special' },
      { ...base, id: undefined },
      { ...base, id: 'once-without-date', repeat: 'once' },
      null,
      'мусор',
    ]);
    expect(list.map((item) => item.id)).toEqual(['task-1']);
  });

  it('повтор идентификатора не создаёт вторую задачу', () => {
    expect(sanitizeSchedules([base, { ...base, title: 'Другая' }])).toHaveLength(1);
  });

  it('приводит дни недели: целые 0..6, без повторов и по возрастанию', () => {
    const [schedule] = sanitizeSchedules([{ ...base, repeat: 'weekly', weekdays: [3, 1, 3, 9, -1, 1.5, 0] }]);
    expect(schedule!.weekdays).toEqual([0, 1, 3]);
  });

  it('больше потолка задач не берёт', () => {
    const many = Array.from({ length: MAX_SCHEDULES + 5 }, (_, index) => ({ ...base, id: `task-${index}` }));
    expect(sanitizeSchedules(many)).toHaveLength(MAX_SCHEDULES);
  });
});

describe('подписи и проверки формы', () => {
  it('правило описывается словами', () => {
    expect(describeSchedule({ ...base, repeat: 'weekly', weekdays: [1, 3, 5] })).toBe(
      'пн, ср, пт в 09:00 · Europe/Moscow',
    );
    expect(describeSchedule(base)).toBe('ежедневно в 09:00 · Europe/Moscow');
    expect(describeSchedule({ ...base, repeat: 'once', date: '2026-03-10' })).toBe(
      '2026-03-10 в 09:00 · Europe/Moscow',
    );
    expect(weekdaysLabel([0, 6])).toBe('вс, сб');
  });

  it('форма объясняет, чего не хватает', () => {
    const problems = scheduleProblems({
      title: ' ',
      prompt: '',
      time: '9',
      timezone: '',
      repeat: 'weekly',
      weekdays: [],
    });
    expect(problems).toHaveLength(5);
    expect(scheduleProblems({ title: 'a', prompt: 'b', time: '09:00', timezone: 'UTC', repeat: 'daily' })).toEqual([]);
  });
});

describe('интервал: каждые N минут', () => {
  /** Интервальная задача: времени суток у неё нет, зато есть минуты. */
  const every = { ...base, repeat: 'interval' as const, time: undefined, intervalMinutes: 15 };

  it('считается от прошлого запуска, а не от часов на стене', () => {
    const next = nextRunAt({ ...every, lastRunAt: TUESDAY_9_MSK }, TUESDAY_9_MSK);
    expect(next).toBe(TUESDAY_9_MSK + 15 * 60_000);
  });

  it('без прошлого запуска отсчёт идёт от заведения задачи', () => {
    const created = TUESDAY_9_MSK - 5 * 60_000;
    expect(nextRunAt({ ...every, createdAt: created }, TUESDAY_9_MSK)).toBe(created + 15 * 60_000);
  });

  it('простой не догоняется: пропущенное срабатывание одно, а не сотня', () => {
    // Задача не запускалась сутки: «каждые 15 минут» — это одно срабатывание сейчас.
    const next = nextRunAt({ ...every, lastRunAt: TUESDAY_9_MSK - 24 * 3_600_000 }, TUESDAY_9_MSK);
    expect(next).toBe(TUESDAY_9_MSK);
  });

  it('выключенная и сломанная задача не срабатывает', () => {
    expect(nextRunAt({ ...every, enabled: false }, TUESDAY_9_MSK)).toBeNull();
    for (const intervalMinutes of [0, -15, 7 * 24 * 60 + 1, 1.5]) {
      expect(nextRunAt({ ...every, intervalMinutes }, TUESDAY_9_MSK), String(intervalMinutes)).toBeNull();
    }
    expect(nextRunAt({ ...every, intervalMinutes: undefined }, TUESDAY_9_MSK)).toBeNull();
  });

  it('подпись называет интервал по-человечески', () => {
    expect(describeSchedule({ ...every, intervalMinutes: 15 })).toBe('каждые 15 минут');
    expect(describeSchedule({ ...every, intervalMinutes: 1 })).toBe('каждую минуту');
    expect(describeSchedule({ ...every, intervalMinutes: 60 })).toBe('каждый час');
    expect(describeSchedule({ ...every, intervalMinutes: 180 })).toBe('каждые 3 часа');
    expect(describeSchedule({ ...every, intervalMinutes: 2880 })).toBe('каждые 2 дня');
    expect(intervalLabel(5)).toBe('каждые 5 минут');
  });

  it('чтение файла разбирает интервал и не требует времени суток', () => {
    const [schedule] = sanitizeSchedules([
      {
        id: 'i-1',
        title: 'Пинг',
        prompt: 'Проверь сборку',
        repeat: 'interval',
        intervalMinutes: 20,
        timezone: 'UTC',
        enabled: true,
        createdAt: 1,
      },
    ]);
    expect(schedule?.intervalMinutes).toBe(20);
    expect(schedule?.time).toBeUndefined();
  });

  it('интервал без минут и с минутами вне пределов выбрасывается', () => {
    const bad = [
      { id: 'i-2', title: 'Пинг', prompt: 'П', repeat: 'interval', timezone: 'UTC', createdAt: 1 },
      { id: 'i-3', title: 'Пинг', prompt: 'П', repeat: 'interval', intervalMinutes: 0, timezone: 'UTC', createdAt: 1 },
      {
        id: 'i-4',
        title: 'Пинг',
        prompt: 'П',
        repeat: 'interval',
        intervalMinutes: 99999,
        timezone: 'UTC',
        createdAt: 1,
      },
    ];
    expect(sanitizeSchedules(bad)).toEqual([]);
  });

  it('форма просит минуты у интервала и время у остальных', () => {
    const common = { title: 'т', prompt: 'п', timezone: 'UTC' };
    expect(scheduleProblems({ ...common, repeat: 'interval', intervalMinutes: 15 })).toEqual([]);
    expect(scheduleProblems({ ...common, repeat: 'interval' })).toContain(
      'Для интервала нужно число минут — например 15',
    );
    expect(scheduleProblems({ ...common, repeat: 'daily' })).toContain('Время — в виде ЧЧ:ММ, например 09:00');
  });
});
