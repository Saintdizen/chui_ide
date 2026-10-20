import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/main/ai/agent-tools';
import {
  findSchedule,
  scheduleAction,
  scheduleCreate,
  scheduleDelete,
  scheduleLine,
  scheduleList,
  scheduleUpdate,
} from '../src/main/ai/schedule-tools';
import type { TaskSchedule } from '../src/shared/scheduling';

/**
 * Инструменты расписания: четыре действия, которыми агент ставит задачи сам.
 *
 * Проверяем то, что дорого ошибить: задача без правила не заводится, правка
 * меняет только названное и не сбрасывает историю, а промах по id объясняется
 * списком, а не молчаливым созданием второй задачи.
 */

/** Задача в памяти вместо файла: `ScheduleTools` — единственное, что знает инструмент. */
function harness(initial: TaskSchedule[] = []): { ctx: ToolContext; stored: TaskSchedule[] } {
  const stored = [...initial];
  const ctx = {
    workspace: {} as ToolContext['workspace'],
    schedules: {
      list: async () => [...stored],
      save: async (schedule: TaskSchedule) => {
        const index = stored.findIndex((item) => item.id === schedule.id);
        if (index >= 0) stored[index] = schedule;
        else stored.push(schedule);
        return [...stored];
      },
      remove: async (id: string) => {
        const index = stored.findIndex((item) => item.id === id);
        if (index >= 0) stored.splice(index, 1);
        return [...stored];
      },
    },
  } as ToolContext;
  return { ctx, stored };
}

/** Уже заведённая задача: её правят и удаляют в тестах. */
const existing: TaskSchedule = {
  id: 'a1b2c3d4-0000-4000-8000-000000000000',
  title: 'Отчёт',
  prompt: 'Собери недельный отчёт',
  repeat: 'daily',
  time: '09:00',
  timezone: 'Europe/Moscow',
  enabled: true,
  createdAt: 1_000,
  lastRunAt: 2_000,
  lastResult: 'failed',
  nextRunAt: 3_000,
};

describe('schedule_create', () => {
  it('заводит ежедневную задачу и возвращает её id', async () => {
    const { ctx, stored } = harness();
    const outcome = await scheduleCreate(ctx, {
      title: 'Сводка',
      prompt: 'Собери сводку по вчерашним коммитам',
      repeat: 'daily',
      time: '09:00',
      timezone: 'Europe/Moscow',
    });

    expect(outcome.ok).toBe(true);
    expect(stored).toHaveLength(1);
    // id нужен модели: по нему задача потом правится и удаляется.
    expect(outcome.detail).toContain(stored[0]!.id);
    expect(outcome.detail).toContain('ежедневно в 09:00');
  });

  it('ставит интервал в минутах, а не время суток', async () => {
    const { ctx, stored } = harness();
    const outcome = await scheduleCreate(ctx, {
      title: 'Проверка сборки',
      prompt: 'Проверь, не сломалась ли сборка',
      repeat: 'interval',
      intervalMinutes: 15,
    });

    expect(outcome.ok).toBe(true);
    expect(stored[0]!.intervalMinutes).toBe(15);
    // Времени суток у интервала нет — и в файле его быть не должно.
    expect(stored[0]!.time).toBeUndefined();
    expect(stored[0]!.timezone).toBeTruthy();
  });

  it('без правила или без времени задача не заводится', async () => {
    const { ctx, stored } = harness();
    const noRepeat = await scheduleCreate(ctx, { title: 'а', prompt: 'б' });
    expect(noRepeat.ok).toBe(false);
    expect(noRepeat.detail).toContain('repeat');

    const noTime = await scheduleCreate(ctx, { title: 'а', prompt: 'б', repeat: 'daily' });
    expect(noTime.ok).toBe(false);
    expect(noTime.detail).toContain('ЧЧ:ММ');

    const emptyTitle = await scheduleCreate(ctx, { title: '  ', prompt: 'б', repeat: 'daily', time: '09:00' });
    expect(emptyTitle.ok).toBe(false);
    expect(stored).toHaveLength(0);
  });

  it('интервал вне пределов отвергается словами', async () => {
    const { ctx } = harness();
    for (const minutes of [0, -5, 100_000]) {
      const outcome = await scheduleCreate(ctx, {
        title: 'т',
        prompt: 'п',
        repeat: 'interval',
        intervalMinutes: minutes,
      });
      expect(outcome.ok, String(minutes)).toBe(false);
      expect(outcome.detail).toContain('Интервал');
    }
  });
});

describe('schedule: list', () => {
  const list = (ctx: ToolContext) => scheduleAction(ctx, { action: 'list' });

  it('пустое расписание говорит об этом, а не молчит', async () => {
    const { ctx } = harness();
    const outcome = await list(ctx);
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('пустое');
  });

  it('строка задачи несёт id, правило и прошлый итог', async () => {
    const { ctx } = harness([existing]);
    const outcome = await list(ctx);
    expect(outcome.summary).toContain('1');
    expect(outcome.detail).toContain(existing.id);
    expect(outcome.detail).toContain('ежедневно в 09:00');
    expect(outcome.detail).toContain('прошлый: ошибка');
  });
});
describe('schedule_update', () => {
  it('меняет названное и сохраняет id и историю запусков', async () => {
    const { ctx, stored } = harness([existing]);
    const outcome = await scheduleUpdate(ctx, { id: existing.id, title: 'Сводка' });

    expect(outcome.ok).toBe(true);
    expect(stored[0]!.title).toBe('Сводка');
    // Правка — это не новая задача: id и история остаются на месте.
    expect(stored[0]!.id).toBe(existing.id);
    expect(stored[0]!.lastRunAt).toBe(existing.lastRunAt);
    expect(stored[0]!.lastResult).toBe('failed');
    expect(stored).toHaveLength(1);
  });

  it('перевод на интервал снимает время суток, дни и дату', async () => {
    const { ctx, stored } = harness([{ ...existing, repeat: 'weekly', weekdays: [1, 3] }]);
    const outcome = await scheduleUpdate(ctx, { id: existing.id, repeat: 'interval', intervalMinutes: 30 });
    expect(outcome.ok).toBe(true);
    expect(stored[0]!.repeat).toBe('interval');
    expect(stored[0]!.time).toBeUndefined();
    expect(outcome.detail).toContain('30');
  });
});

describe('schedule_update: отказы', () => {
  it('возврат с интервала требует время: без него правило не собрать', async () => {
    const { ctx } = harness([{ ...existing, repeat: 'interval', intervalMinutes: 30, time: undefined }]);
    const outcome = await scheduleUpdate(ctx, { id: existing.id, repeat: 'daily' });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('ЧЧ:ММ');
  });

  it('приостановка — это поле enabled, а не удаление', async () => {
    const { ctx, stored } = harness([existing]);
    const outcome = await scheduleUpdate(ctx, { id: existing.id, enabled: false });
    expect(outcome.ok).toBe(true);
    expect(stored[0]!.enabled).toBe(false);
    expect(stored).toHaveLength(1);
  });

  it('промах по id объясняется списком, а не заводит вторую задачу', async () => {
    const { ctx, stored } = harness([existing]);
    const outcome = await scheduleUpdate(ctx, { id: 'zzz', title: 'Другая' });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain(existing.id);
    expect(stored).toHaveLength(1);
  });

  it('сокращённый id находится, если он один такой', async () => {
    const { ctx } = harness([existing]);
    const outcome = await scheduleUpdate(ctx, { id: 'a1b2c3', title: 'Сводка' });
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('Сводка');
  });
});

describe('schedule_delete', () => {
  it('удаляет по id и говорит, сколько осталось', async () => {
    const { ctx, stored } = harness([existing]);
    const outcome = await scheduleDelete(ctx, { id: existing.id });
    expect(outcome.ok).toBe(true);
    expect(stored).toHaveLength(0);
    expect(outcome.detail).toContain('0');
  });

  it('повторное удаление — отказ с намёком на список', async () => {
    const { ctx } = harness([]);
    const outcome = await scheduleDelete(ctx, { id: existing.id });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('schedule');
  });

  it('без подключённого расписания инструмент честно отказывает', async () => {
    const outcome = await scheduleList({ workspace: {} as ToolContext['workspace'] });
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('Расписание');
  });
});

describe('поиск по id', () => {
  it('неоднозначный префикс отвергается, а не угадывается', () => {
    const list = [
      { ...existing, id: 'aaaa-1' },
      { ...existing, id: 'aaaa-2' },
    ];
    const found = findSchedule(list, 'aaaa');
    expect('problem' in found && found.problem).toContain('несколько');
  });

  it('строка задачи без рассчитанного запуска не врёт датой', () => {
    const line = scheduleLine({ ...existing, nextRunAt: undefined, lastResult: undefined });
    expect(line).toContain('не рассчитан');
    expect(line).not.toContain('прошлый');
  });
});
