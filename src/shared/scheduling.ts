/**
 * Расписание задач: когда ассистент начинает ход сам, без вопроса в поле.
 *
 * Задача — это заготовленный запрос и правило «когда». Правил намеренно три:
 * разово, каждый день, по дням недели. Крона здесь не нужна: человек пишет
 * «каждую пятницу в 17:00», а не «0 17 * * 5», и всё, что сложнее трёх правил,
 * проще выразить словами в самом запросе.
 *
 * Время задачи задано В ЗОНЕ, а не смещением: «ежедневно в 9:00» в
 * Europe/Moscow остаётся девятью часами и после перевода стрелок, а смещение
 * сдвинуло бы запуск на час. Поэтому вся арифметика идёт через `Intl`, а не
 * через `Date`.
 *
 * Модуль чистый: ни диска, ни Electron. Хранит и запускает main
 * (`main/schedules/schedules.ts`), показывает renderer. Поэтому и проверяется
 * он без всего этого — см. `tests/scheduling.test.ts`.
 */

/** Как часто повторяется задача. */
export type ScheduleRepeat = 'once' | 'daily' | 'weekly';

/** Чем кончился последний запуск: ответ пришёл, отказ, не начинали или оборвали. */
export type ScheduleResult = 'ok' | 'failed' | 'skipped' | 'stopped';

/** Одна задача расписания. */
export interface TaskSchedule {
  /** Идентификатор в файле расписания: по нему задача правится и удаляется. */
  id: string;
  /** Название — то, что видно в списке и в уведомлении. */
  title: string;
  /** Запрос, который уйдёт ассистенту как обычный вопрос. */
  prompt: string;
  repeat: ScheduleRepeat;
  /** Время в зоне `timezone`: `HH:MM`. */
  time: string;
  /** Зона IANA, например `Europe/Moscow`. */
  timezone: string;
  /** Дни недели для `weekly`: 0 — воскресенье, 1 — понедельник. */
  weekdays?: number[];
  /** Дата для `once`: `YYYY-MM-DD` в той же зоне. */
  date?: string;
  /** Выключенная задача остаётся в списке, но не запускается. */
  enabled: boolean;
  /** Когда задачу завели: по этому списку стабильный порядок. */
  createdAt: number;
  /** Время последнего запуска, мс. */
  lastRunAt?: number;
  /** Итог последнего запуска. */
  lastResult?: ScheduleResult;
  /**
   * Время следующего запуска, мс. Считает main и хранит в файле: список должен
   * показывать «когда в следующий раз» без пересчёта в интерфейсе.
   */
  nextRunAt?: number;
}

/** Больше задач — это уже не расписание, а список дел: за ним не уследить. */
export const MAX_SCHEDULES = 20;
/** Потолок названия: в строке списка оно и так обрезается. */
export const MAX_SCHEDULE_TITLE = 80;
/** Запрос — это вопрос, а не сочинение; длиннее модель всё равно обрежет по смыслу. */
export const MAX_SCHEDULE_PROMPT = 4000;

/** Названия дней недели, начиная с воскресенья — как в `Date.getDay`. */
const WEEKDAY_NAMES = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const WEEKDAY_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/**
 * Дни в том порядке, в каком их выбирают в форме: неделя с понедельника.
 * Числа — те же, что у `Date.getDay`, поэтому `вс` стоит в конце.
 */
export const WEEKDAY_SHORT_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** Календарный день в какой-то зоне. */
interface DayParts {
  year: number;
  /** Месяц, 1-based: так его печатает `Intl`. */
  month: number;
  day: number;
  /** 0 — воскресенье. */
  weekday: number;
}

/** Разобранное время суток. */
export interface ClockTime {
  hours: number;
  minutes: number;
}

/**
 * `HH:MM` → часы и минуты. Строгий разбор: `9:5`, `25:00` и пустое — не время.
 * Строгость здесь важна: опечатка иначе превратилась бы в «задача не запускается
 * никогда» без единого сообщения.
 */
export function parseScheduleTime(raw: string): ClockTime | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

/** `HH:MM` в виде, в котором его удобно и хранить, и показывать. */
export function formatScheduleTime(time: ClockTime): string {
  return `${String(time.hours).padStart(2, '0')}:${String(time.minutes).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` → календарный день. Отдельного `Date` не нужно: зона тут ни при чём. */
export function parseScheduleDate(raw: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Проверка «такая дата существует» через UTC: 31 февраля иначе прошло бы разбор.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** День недели календарной даты: 0 — воскресенье. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Известна ли системе такая зона. Неизвестную `Intl` отвергает исключением. */
export function isValidTimezone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Зона, в которой живёт человек: её предлагаем по умолчанию. */
export function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Календарный день и время суток в нужной зоне.
 *
 * `Intl` — единственный способ узнать местное время без сторонних библиотек, а
 * `formatToParts` не зависит от локали: числа приходят отдельными частями.
 */
function zonedParts(at: number, timeZone: string): (DayParts & { hour: number; minute: number }) | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(at));
  } catch {
    return null;
  }

  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : Number.NaN;
  };

  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  // В некоторых сборках ICU полночь печатается как «24» — приводим к нулю.
  const hour = pick('hour') % 24;
  const minute = pick('minute');
  if (![year, month, day, hour, minute].every((value) => Number.isFinite(value))) return null;

  return { year, month, day, hour, minute, weekday: weekdayOf(year, month, day) };
}

/**
 * Момент (мс), когда в зоне `timeZone` наступает `minutes` минут от полуночи
 * указанного дня.
 *
 * Обратная задача к `zonedParts`: `Intl` умеет «момент → местное время», а нам
 * нужно наоборот, поэтому смещение подбирается в пару шагов. Если такого времени
 * в этом дне не существует (переход на летнее время вырезал час), возвращаем
 * `null`: пусть задача перейдёт на следующий день, а не сработает наугад.
 */
function epochForWallClock(day: DayParts, minutes: number, timeZone: string): number | null {
  const target = Date.UTC(day.year, day.month - 1, day.day) + minutes * 60_000;
  let guess = target;
  for (let step = 0; step < 3; step += 1) {
    const local = zonedParts(guess, timeZone);
    if (!local) return null;
    const asUtc = Date.UTC(local.year, local.month - 1, local.day) + local.hour * 3_600_000 + local.minute * 60_000;
    const shift = guess - asUtc;
    const next = target + shift;
    if (next === guess) break;
    guess = next;
  }

  // Приближение могло съехать: проверяем, что в этот момент местное время то же.
  const check = zonedParts(guess, timeZone);
  if (!check) return null;
  if (check.hour * 60 + check.minute !== minutes) return null;
  if (check.day !== day.day || check.month !== day.month || check.year !== day.year) return null;
  return guess;
}

/** Тот же календарный день через `offset` дней (без перехода в UTC и обратно). */
function addDays(day: DayParts, offset: number): DayParts {
  const shifted = new Date(Date.UTC(day.year, day.month - 1, day.day + offset));
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const date = shifted.getUTCDate();
  return { year, month, day: date, weekday: shifted.getUTCDay() };
}

/** Сколько дней вперёд искать: неделя покрывает недельное правило, 8 — сутки на переход стрелок. */
const SEARCH_DAYS = { daily: 8, weekly: 15 } as const;

/**
 * Когда задача сработает в следующий раз — или `null`, если уже никогда:
 * выключена, разовая и прошедшая, или правило сломано.
 *
 * Считается от `from` (обычно «сейчас»), а не от прошлого запуска: приложение
 * могло быть закрыто неделю, и догонять каждый пропуск не нужно — достаточно,
 * чтобы следующее срабатывание было в будущем.
 */
export function nextRunAt(schedule: TaskSchedule, from: number): number | null {
  if (!schedule.enabled) return null;
  const time = parseScheduleTime(schedule.time);
  if (!time) return null;
  if (!isValidTimezone(schedule.timezone)) return null;
  const minutes = time.hours * 60 + time.minutes;

  const today = zonedParts(from, schedule.timezone);
  if (!today) return null;

  if (schedule.repeat === 'once') {
    const date = schedule.date ? parseScheduleDate(schedule.date) : null;
    if (!date) return null;
    const at = epochForWallClock(
      { ...date, weekday: weekdayOf(date.year, date.month, date.day) },
      minutes,
      schedule.timezone,
    );
    return at !== null && at > from ? at : null;
  }

  if (schedule.repeat === 'weekly') {
    const days = schedule.weekdays ?? [];
    // Пустой набор дней — это «никогда»: правило без дней не имеет смысла, и
    // молча превращать его в «каждый день» было бы подменой решения человека.
    if (days.length === 0) return null;
    const wanted = new Set(days);
    for (let offset = 0; offset <= SEARCH_DAYS.weekly; offset += 1) {
      const day = addDays(today, offset);
      if (!wanted.has(day.weekday)) continue;
      const at = epochForWallClock(day, minutes, schedule.timezone);
      if (at !== null && at > from) return at;
    }
    return null;
  }

  for (let offset = 0; offset <= SEARCH_DAYS.daily; offset += 1) {
    const at = epochForWallClock(addDays(today, offset), minutes, schedule.timezone);
    if (at !== null && at > from) return at;
  }
  return null;
}

/**
 * Задачи, которым пора: включённые и с временем запуска не позже `now`.
 * Порядок — по времени запуска: если запустились две, старшая первой.
 */
export function dueSchedules(list: readonly TaskSchedule[], now: number): TaskSchedule[] {
  return list
    .filter((schedule) => schedule.enabled && typeof schedule.nextRunAt === 'number' && schedule.nextRunAt <= now)
    .sort((left, right) => (left.nextRunAt ?? 0) - (right.nextRunAt ?? 0));
}

/** Названия дней недели для подписи: полное и короткое. */
export function weekdayName(day: number, short = false): string {
  const index = ((day % 7) + 7) % 7;
  return (short ? WEEKDAY_SHORT : WEEKDAY_NAMES)[index] ?? '';
}

/** «пн, ср, пт» — короткой строкой, как в подписи задачи. */
export function weekdaysLabel(days: readonly number[]): string {
  return [...days]
    .sort((left, right) => left - right)
    .map((day) => weekdayName(day, true))
    .join(', ');
}

/**
 * Подпись правила одной строкой: «ежедневно в 09:00 · Europe/Moscow».
 * Живёт здесь, а не в интерфейсе, чтобы список и уведомление говорили одинаково.
 */
export function describeSchedule(schedule: TaskSchedule): string {
  const time = parseScheduleTime(schedule.time);
  const at = time ? formatScheduleTime(time) : schedule.time;
  let rule: string;
  if (schedule.repeat === 'once') {
    rule = schedule.date ? `${schedule.date} в ${at}` : `разово в ${at}`;
  } else if (schedule.repeat === 'weekly') {
    const days = schedule.weekdays ?? [];
    rule = days.length > 0 ? `${weekdaysLabel(days)} в ${at}` : `в ${at} (дни не выбраны)`;
  } else {
    rule = `ежедневно в ${at}`;
  }
  return `${rule} · ${schedule.timezone}`;
}

/** Итог запуска словом — для строки списка. */
export function resultLabel(result: ScheduleResult): string {
  switch (result) {
    case 'ok':
      return 'готово';
    case 'failed':
      return 'ошибка';
    case 'skipped':
      return 'пропущен';
    case 'stopped':
      return 'остановлен';
  }
}

/**
 * Привести прочитанный файл к списку задач, которому можно верить.
 *
 * Мусор в файле не должен ронять список: испорченная задача выбрасывается, а
 * остальные остаются. Обрезаем по потолкам — иначе одна строка на мегабайт
 * делала бы окно нечитаемым.
 */
export function sanitizeSchedules(raw: unknown): TaskSchedule[] {
  const source = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { schedules?: unknown }).schedules)
      ? (raw as { schedules: unknown[] }).schedules
      : [];
  const found: TaskSchedule[] = [];
  const seen = new Set<string>();

  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    const title = typeof value.title === 'string' ? value.title.trim().slice(0, MAX_SCHEDULE_TITLE) : '';
    const prompt = typeof value.prompt === 'string' ? value.prompt.trim().slice(0, MAX_SCHEDULE_PROMPT) : '';
    const repeat =
      value.repeat === 'daily' || value.repeat === 'weekly' || value.repeat === 'once' ? value.repeat : null;
    const time = typeof value.time === 'string' ? value.time.trim() : '';
    const timezone = typeof value.timezone === 'string' ? value.timezone.trim() : '';
    // Задача без идентификатора, названия, запроса или правила — не задача:
    // запускать нечего, а в списке она выглядела бы рабочей.
    if (!id || seen.has(id)) continue;
    if (!title || !prompt || !repeat) continue;
    if (!parseScheduleTime(time) || !isValidTimezone(timezone)) continue;
    if (repeat === 'once' && !(typeof value.date === 'string' && parseScheduleDate(value.date))) continue;

    const weekdays =
      repeat === 'weekly' && Array.isArray(value.weekdays)
        ? [
            ...new Set(
              value.weekdays.filter(
                (day): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6,
              ),
            ),
          ].sort((left, right) => left - right)
        : undefined;

    seen.add(id);
    found.push({
      id,
      title,
      prompt,
      repeat,
      time,
      timezone,
      ...(weekdays ? { weekdays } : {}),
      ...(typeof value.date === 'string' && repeat === 'once' ? { date: value.date } : {}),
      enabled: value.enabled !== false,
      createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
      ...(typeof value.lastRunAt === 'number' && Number.isFinite(value.lastRunAt)
        ? { lastRunAt: value.lastRunAt }
        : {}),
      ...(value.lastResult === 'ok' ||
      value.lastResult === 'failed' ||
      value.lastResult === 'skipped' ||
      value.lastResult === 'stopped'
        ? { lastResult: value.lastResult }
        : {}),
      ...(typeof value.nextRunAt === 'number' && Number.isFinite(value.nextRunAt)
        ? { nextRunAt: value.nextRunAt }
        : {}),
    });
    if (found.length >= MAX_SCHEDULES) break;
  }

  return found;
}

/**
 * Что не так с задачей, которую собираются сохранить. Пустой список — можно.
 * Проверка одна на окно и на main: правила интерфейса и диска совпадают.
 */
export function scheduleProblems(draft: {
  title: string;
  prompt: string;
  time: string;
  timezone: string;
  repeat: ScheduleRepeat;
  weekdays?: readonly number[];
  date?: string;
}): string[] {
  const problems: string[] = [];
  if (!draft.title.trim()) problems.push('Нужно название — по нему задача видна в списке');
  if (!draft.prompt.trim()) problems.push('Нужен запрос — это то, что уйдёт ассистенту');
  if (!parseScheduleTime(draft.time)) problems.push('Время — в виде ЧЧ:ММ, например 09:00');
  if (!isValidTimezone(draft.timezone)) problems.push('Неизвестный часовой пояс — например Europe/Moscow');
  if (draft.repeat === 'weekly' && (draft.weekdays ?? []).length === 0) {
    problems.push('Для недельного правила выберите хотя бы один день');
  }
  if (draft.repeat === 'once' && !(draft.date && parseScheduleDate(draft.date))) {
    problems.push('Для разовой задачи нужна дата в виде ГГГГ-ММ-ДД');
  }
  return problems;
}
