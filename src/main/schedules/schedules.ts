import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ScheduleResult, TaskSchedule } from '../../shared/scheduling';
import { MAX_SCHEDULES, dueSchedules, nextRunAt, sanitizeSchedules, scheduleProblems } from '../../shared/scheduling';

/**
 * Расписание задач: файл в проекте и часы, которые его читают.
 *
 * Задачи лежат в `<проект>/.chui/schedules.json` — рядом с командами, по той же
 * причине: расписание касается ЭТОГО проекта («по пятницам собери недельный
 * отчёт по заметкам») и уместно в репозитории. Личного здесь нет, поэтому
 * `~/.chui` не нужен.
 *
 * Сам ход ассистента запускает renderer: цикл агента живёт в main, но его
 * инструменты (правки в документной модели, подтверждения, показ файла) — в
 * окне. Поэтому часы только объявляют «время пришло» (`notify`), а отметку о
 * запуске main ставит сам: если окна не окажется, задача не «сгорит» — она
 * попадёт в следующий тик.
 *
 * Здесь же потолки, без которых расписание вредно: задач не больше
 * `MAX_SCHEDULES` (список должен читаться глазами), а отметка о запуске ставится
 * ДО старта хода — иначе зависший прогон запускал бы задачу снова и снова.
 */

/** Где расписание в проекте. */
const SCHEDULES_FILE = path.join('.chui', 'schedules.json');

/** Как часто смотрим на часы. Минута мельче, чем точность правил (у нас нет секунд). */
export const SCHEDULE_TICK_MS = 20_000;

export interface ScheduleServiceDeps {
  /** Корень активного проекта: расписание принадлежит ему. */
  root: () => string | null;
  /** Отдать задачу в интерфейс — он и запустит ход. */
  notify: (schedule: TaskSchedule) => void;
  /** Есть ли кому передать задачу: без окна тик не срабатывает. */
  canRun: () => boolean;
  /** Включён ли ассистент: выключенный не должен тратить токены сам по себе. */
  aiEnabled: () => boolean;
}

/** Хранилище одного файла: чтение терпимое, запись через временный файл. */
export class ScheduleStore {
  async load(root: string): Promise<TaskSchedule[]> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.fileFor(root), 'utf8'));
      // Время НЕ пересчитываем: в файле лежит момент, до которого задача ждёт.
      // Пересчёт при чтении сдвигал бы «сегодня в 09:00» на завтра ровно в
      // тот тик, когда оно наступило, — и задача не срабатывала бы никогда.
      return sanitizeSchedules(raw);
    } catch {
      // Нет файла или он битый — расписания просто нет. Ронять окно из-за этого
      // незачем: пустой список честнее ошибки на весь экран.
      return [];
    }
  }

  async save(root: string, list: readonly TaskSchedule[], now = Date.now()): Promise<TaskSchedule[]> {
    const schedules = this.recalculate(sanitizeSchedules(list), now);
    const file = this.fileFor(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ schedules }, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, file);
    return schedules;
  }

  /** Файл расписания этого проекта — для подсказки в окне и для проб. */
  fileFor(root: string): string {
    return path.join(root, SCHEDULES_FILE);
  }

  /**
   * Пересчитать `nextRunAt` у всех задач от «сейчас». Единственное место, где
   * это поле появляется при записи, поэтому в файле не может остаться время
   * из прошлой зоны или прошлого правила. При чтении не пересчитываем: смысл
   * хранимого времени — «до какого момента задача ждёт», а не «когда бы она
   * сработала, если бы её завели сейчас».
   */
  recalculate(list: readonly TaskSchedule[], now: number): TaskSchedule[] {
    return list.map((schedule) => {
      const next = nextRunAt(schedule, now);
      const { nextRunAt: _stale, ...rest } = schedule;
      void _stale;
      return next === null ? rest : { ...rest, nextRunAt: next };
    });
  }
}

/** Сервис расписания: список, правка, удаление и часы. */
export class ScheduleService {
  private timer: NodeJS.Timeout | null = null;
  /** Задачи, уже отданные в окно и ждущие итога: повторно их не объявляем. */
  private readonly handedOut = new Set<string>();

  constructor(
    private readonly deps: ScheduleServiceDeps,
    private readonly store = new ScheduleStore(),
  ) {}

  async list(): Promise<TaskSchedule[]> {
    const root = this.deps.root();
    if (!root) return [];
    return this.store.load(root);
  }

  /** Завести или изменить задачу. Возвращается весь список — окно рисует его целиком. */
  async save(input: TaskSchedule): Promise<TaskSchedule[]> {
    const root = this.requireRoot();
    const problems = scheduleProblems(input);
    if (problems.length > 0) throw new Error(problems[0]);
    const list = await this.store.load(root);

    const exists = list.some((schedule) => schedule.id === input.id);
    if (!exists && list.length >= MAX_SCHEDULES) {
      throw new Error(`Больше ${MAX_SCHEDULES} задач расписание не держит`);
    }

    const schedule: TaskSchedule = {
      ...input,
      id: input.id || randomUUID(),
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      createdAt: exists ? (list.find((item) => item.id === input.id)?.createdAt ?? Date.now()) : Date.now(),
    };
    const next = exists ? list.map((item) => (item.id === schedule.id ? schedule : item)) : [...list, schedule];
    return this.store.save(root, next);
  }

  async remove(id: string): Promise<TaskSchedule[]> {
    const root = this.requireRoot();
    const list = await this.store.load(root);
    this.handedOut.delete(id);
    return this.store.save(
      root,
      list.filter((schedule) => schedule.id !== id),
    );
  }

  /**
   * Итог запуска: отмечаем его в файле и пересчитываем следующее срабатывание.
   * Разовая задача после запуска выключается — второй раз ей срабатывать нечем.
   */
  async finish(id: string, result: ScheduleResult): Promise<TaskSchedule[]> {
    const root = this.deps.root();
    if (!root) return [];
    const list = await this.store.load(root);
    this.handedOut.delete(id);
    const now = Date.now();
    const next = list.map((schedule) => {
      if (schedule.id !== id) return schedule;
      const fired: TaskSchedule = { ...schedule, lastRunAt: now, lastResult: result };
      if (schedule.repeat === 'once') fired.enabled = false;
      return fired;
    });
    return this.store.save(root, next);
  }

  /** Запустить часы. Повторный вызов ничего не делает. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), SCHEDULE_TICK_MS);
    // Часы не должны держать приложение живым после закрытия окон.
    this.timer.unref?.();
  }

  dispose(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Один взгляд на часы: кому пора — тем и объявляем.
   *
   * Отметка о запуске ставится здесь же, до хода: иначе задача, чей прогон
   * затянулся, объявлялась бы на каждом тике. Если передать её некому (нет окна
   * или ассистент выключен), ничего не трогаем — время останется в прошлом, и
   * задача сработает в следующем тике, когда окно появится.
   */
  async tick(now = Date.now()): Promise<void> {
    if (!this.deps.canRun() || !this.deps.aiEnabled()) return;
    const root = this.deps.root();
    if (!root) return;

    const list = await this.store.load(root);
    const due = dueSchedules(list, now).filter((schedule) => !this.handedOut.has(schedule.id));
    if (due.length === 0) return;

    let changed = false;
    const updated = list.map((schedule) => {
      if (!due.some((item) => item.id === schedule.id)) return schedule;
      changed = true;
      this.handedOut.add(schedule.id);
      const fired: TaskSchedule = { ...schedule, lastRunAt: now };
      if (schedule.repeat === 'once') fired.enabled = false;
      return fired;
    });
    if (changed) await this.store.save(root, updated, now);

    for (const schedule of due) this.deps.notify(schedule);
  }

  private requireRoot(): string {
    const root = this.deps.root();
    if (!root) throw new Error('Проект не открыт');
    return root;
  }
}
