import { randomUUID } from 'node:crypto';
import {
  describeSchedule,
  resultLabel,
  scheduleProblems,
  systemTimezone,
  type ScheduleRepeat,
  type TaskSchedule,
} from '../../shared/scheduling';
import type { ToolContext, ToolOutcome } from './agent-tools';

/**
 * Инструменты расписания: `schedule_create`, `schedule_list`, `schedule_update`,
 * `schedule_delete`.
 *
 * Расписание до сих пор ставилось только окном: человек открывал «Расписание
 * задач…» и заполнял форму. Отсюда же задачу ставит сам агент — одной фразой
 * «каждый будний день к 9:00 собери сводку по вчерашним коммитам».
 *
 * У каждого действия свой инструмент, а не один `schedule` с полем `action`:
 * так модель видит четыре коротких описания вместо одного длинного, а промах
 * («забыл id») чинится по названию инструмента. Правка идёт на месте: id и
 * история запусков сохраняются — иначе правка одного поля начинала бы задачу
 * заново, со сброшенным «прошлый запуск: ошибка».
 *
 * Модуль знает только про `ScheduleTools` (файл и часы живут в main), поэтому
 * проверяется без диска — см. `tests/schedule-tools.test.ts`.
 */

/** Строка задачи для модели: id, название, правило и когда следующий запуск. */
export function scheduleLine(schedule: TaskSchedule): string {
  const when =
    typeof schedule.nextRunAt === 'number'
      ? new Date(schedule.nextRunAt).toLocaleString('ru-RU', {
          timeZone: schedule.timezone,
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'не рассчитан';
  const state = schedule.enabled ? `следующий запуск: ${when}` : 'приостановлена';
  const last = schedule.lastResult ? ` · прошлый: ${resultLabel(schedule.lastResult)}` : '';
  return `${schedule.id} · ${schedule.title} — ${describeSchedule(schedule)}; ${state}${last}`;
}

/**
 * Найти задачу по id. Сперва точное совпадение, потом единственное по началу:
 * длинный id модель сокращает, и отказ на таком вызове был бы лишним кругом.
 */
export function findSchedule(
  list: readonly TaskSchedule[],
  raw: string,
): { found: TaskSchedule } | { problem: string } {
  const exact = list.find((schedule) => schedule.id === raw);
  if (exact) return { found: exact };
  const partial = list.filter((schedule) => schedule.id.startsWith(raw));
  if (partial.length === 1) return { found: partial[0]! };
  if (partial.length > 1) {
    return { problem: `Под «${raw}» подходит несколько задач: ${partial.map((item) => item.id).join(', ')}` };
  }
  if (list.length === 0) return { problem: 'Расписание пустое: сначала schedule_create' };
  return { problem: `Задачи с id «${raw}» нет. Есть: ${list.map((item) => item.id).join(', ')}` };
}

/** Правило из аргумента: всё, чего не знаем, — ошибка формы, а не догадка. */
function readRepeat(value: unknown): ScheduleRepeat | null {
  return value === 'daily' || value === 'weekly' || value === 'once' || value === 'interval' ? value : null;
}

/** Дни недели из аргумента: целые 0–6, без повторов и по возрастанию. */
function readWeekdays(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const days = value.filter(
    (day): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6,
  );
  return [...new Set(days)].sort((left, right) => left - right);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Правило не поняли — подсказываем сразу все четыре, иначе модель гадает. */
const REPEAT_HINT = 'repeat: daily, weekly, once или interval.';

/** Завести задачу. Пустое имя или сломанное правило — отказ словами, а не запись наугад. */
export async function scheduleCreate(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.schedules) return { ok: false, summary: 'Расписание недоступно' };

  const repeat = readRepeat(args.repeat);
  if (!repeat) return { ok: false, summary: 'Не понял правило', detail: REPEAT_HINT };

  const every = typeof args.intervalMinutes === 'number' ? Math.round(args.intervalMinutes) : undefined;
  const schedule: TaskSchedule = {
    // id придумываем здесь: по нему же задачу правят и удаляют.
    id: randomUUID(),
    title: text(args.title) ?? '',
    prompt: text(args.prompt) ?? '',
    repeat,
    timezone: text(args.timezone) ?? systemTimezone(),
    enabled: true,
    createdAt: Date.now(),
    ...(text(args.time) ? { time: text(args.time)! } : {}),
    ...(repeat === 'weekly' ? { weekdays: readWeekdays(args.weekdays) ?? [] } : {}),
    ...(repeat === 'once' ? { date: text(args.date) ?? '' } : {}),
    ...(repeat === 'interval' && every !== undefined ? { intervalMinutes: every } : {}),
  };

  const problems = scheduleProblems(schedule);
  if (problems.length > 0) return { ok: false, summary: 'Задача не заведена', detail: `${problems.join('; ')}.` };

  const list = await ctx.schedules.save(schedule);
  return {
    ok: true,
    summary: `задача «${schedule.title}» заведена`,
    detail:
      `id ${schedule.id} · ${describeSchedule(schedule)}. Запустится, только когда проект открыт. ` +
      `Всего задач: ${list.length}.`,
  };
}

/** Список задач: id — то, по чему модель правит и удаляет. */
export async function scheduleList(ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.schedules) return { ok: false, summary: 'Расписание недоступно' };

  const list = await ctx.schedules.list();
  if (list.length === 0) {
    return { ok: true, summary: 'расписание пустое', detail: 'Задач нет. Завести — schedule_create.' };
  }
  return { ok: true, summary: `задач: ${list.length}`, detail: list.map(scheduleLine).join('\n') };
}

/**
 * Правка на месте: меняются только названные поля, id и история запусков живут.
 * Поля, которых у нового правила быть не может (у интервала — время суток), снимаются:
 * иначе в файле осталось бы «каждые 15 минут в 09:00».
 */
export async function scheduleUpdate(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.schedules) return { ok: false, summary: 'Расписание недоступно' };

  const id = text(args.id);
  if (!id) return { ok: false, summary: 'Нужен id', detail: 'id берётся из schedule_list.' };

  const located = findSchedule(await ctx.schedules.list(), id);
  if ('problem' in located) return { ok: false, summary: 'Задача не найдена', detail: located.problem };

  const current = located.found;
  const repeat = args.repeat === undefined ? current.repeat : readRepeat(args.repeat);
  if (!repeat) return { ok: false, summary: 'Не понял правило', detail: REPEAT_HINT };

  const next: TaskSchedule = { ...current, repeat };
  const title = text(args.title);
  const prompt = text(args.prompt);
  const timezone = text(args.timezone);
  if (title) next.title = title;
  if (prompt) next.prompt = prompt;
  if (timezone) next.timezone = timezone;
  if (typeof args.enabled === 'boolean') next.enabled = args.enabled;

  if (repeat === 'interval') {
    // Интервалу время суток, дни и дата не нужны — зато нужны минуты.
    delete next.time;
    delete next.weekdays;
    delete next.date;
    const every = typeof args.intervalMinutes === 'number' ? Math.round(args.intervalMinutes) : current.intervalMinutes;
    if (every === undefined) delete next.intervalMinutes;
    else next.intervalMinutes = every;
  } else {
    delete next.intervalMinutes;
    const wallClock = text(args.time) ?? current.time;
    if (!wallClock) {
      return { ok: false, summary: 'Нужно время', detail: `Для правила ${repeat} укажи time в виде ЧЧ:ММ.` };
    }
    next.time = wallClock;
    if (repeat === 'weekly') next.weekdays = readWeekdays(args.weekdays) ?? current.weekdays ?? [];
    else delete next.weekdays;
    if (repeat === 'once') {
      const on = text(args.date) ?? current.date;
      if (!on) return { ok: false, summary: 'Нужна дата', detail: 'Для разовой задачи укажи date в виде ГГГГ-ММ-ДД.' };
      next.date = on;
    } else {
      delete next.date;
    }
  }

  const problems = scheduleProblems(next);
  if (problems.length > 0) return { ok: false, summary: 'Задача не изменена', detail: `${problems.join('; ')}.` };

  const saved = await ctx.schedules.save(next);
  const updated = saved.find((item) => item.id === next.id) ?? next;
  return { ok: true, summary: `задача «${next.title}» изменена`, detail: scheduleLine(updated) };
}

/** Удаление по id: единственное действие расписания, которое ничего не оставляет. */
export async function scheduleDelete(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.schedules) return { ok: false, summary: 'Расписание недоступно' };

  const id = text(args.id);
  if (!id) return { ok: false, summary: 'Нужен id', detail: 'id берётся из schedule_list.' };

  const located = findSchedule(await ctx.schedules.list(), id);
  if ('problem' in located) return { ok: false, summary: 'Задача не найдена', detail: located.problem };

  const left = await ctx.schedules.remove(located.found.id);
  return {
    ok: true,
    summary: `задача «${located.found.title}» удалена`,
    detail: `Осталось задач: ${left.length}.`,
  };
}
