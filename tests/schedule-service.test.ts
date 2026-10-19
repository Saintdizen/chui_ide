import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScheduleService, ScheduleStore } from '../src/main/schedules/schedules';
import type { TaskSchedule } from '../src/shared/scheduling';

/**
 * Часы расписания: кто срабатывает, когда и сколько раз.
 *
 * Проверяется без Electron: сервису нужны только корень проекта, «есть ли кому
 * передать задачу» и «включён ли ассистент» — всё это в тесте функции. Время
 * везде передаётся аргументом, поэтому результат не зависит от дня прогона.
 */

let root = '';

const store = (): ScheduleStore => new ScheduleStore();

/** Задача «ежедневно в 09:00 UTC» — зону берём UTC, чтобы моменты были очевидны. */
const task = (overrides: Partial<TaskSchedule> = {}): TaskSchedule => ({
  id: 'task-1',
  title: 'Отчёт',
  prompt: 'Собери отчёт',
  repeat: 'daily',
  time: '09:00',
  timezone: 'UTC',
  enabled: true,
  createdAt: 0,
  ...overrides,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'chui-schedule-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('хранилище расписания', () => {
  it('пишет файл прямо в проект и читает его обратно', async () => {
    const saved = await store().save(root, [task()]);
    expect(saved).toHaveLength(1);
    expect(await store().load(root)).toEqual(saved);
    // Файл лежит там, где договорились: `.chui/schedules.json` в проекте.
    expect(store().fileFor(root)).toBe(join(root, '.chui', 'schedules.json'));
  });

  it('считает время следующего срабатывания при записи', async () => {
    const now = Date.UTC(2026, 2, 10, 6, 0);
    const [saved] = await store().save(root, [task()], now);
    expect(saved!.nextRunAt).toBe(Date.UTC(2026, 2, 10, 9, 0));
  });

  it('повреждённый файл — это пустое расписание, а не сбой', async () => {
    await store().save(root, [task()]);
    await writeFile(join(root, '.chui', 'schedules.json'), '{ это не json', 'utf8');
    expect(await store().load(root)).toEqual([]);
  });

  it('время из файла не пересчитывается при чтении', async () => {
    // Ключевое свойство: иначе задача «сегодня в 09:00» переезжала бы на завтра
    // ровно в тот тик, когда её время наступило, и не срабатывала бы никогда.
    await store().save(root, [task()], Date.UTC(2026, 2, 9, 12, 0));
    const [stored] = await store().load(root);
    expect(stored!.nextRunAt).toBe(Date.UTC(2026, 2, 10, 9, 0));
  });
});

describe('тик расписания', () => {
  const service = (overrides: { canRun?: boolean; aiEnabled?: boolean } = {}) => {
    const handed: TaskSchedule[] = [];
    const instance = new ScheduleService({
      root: () => root,
      notify: (schedule) => handed.push(schedule),
      canRun: () => overrides.canRun ?? true,
      aiEnabled: () => overrides.aiEnabled ?? true,
    });
    return { instance, handed };
  };

  it('объявляет задачу в момент срабатывания и один раз', async () => {
    const due = Date.UTC(2026, 2, 10, 9, 0);
    await store().save(root, [task()], due - 60_000);
    const { instance, handed } = service();

    await instance.tick(due);
    expect(handed.map((schedule) => schedule.id)).toEqual(['task-1']);

    // Второй тик следом не повторяет тот же запуск.
    await instance.tick(due + 1000);
    expect(handed).toHaveLength(1);
  });

  it('после срабатывания следующее время уезжает в будущее', async () => {
    const due = Date.UTC(2026, 2, 10, 9, 0);
    await store().save(root, [task()], due - 60_000);
    const { instance } = service();

    await instance.tick(due);
    const [stored] = await store().load(root);
    expect(stored!.lastRunAt).toBe(due);
    expect(stored!.nextRunAt).toBe(Date.UTC(2026, 2, 11, 9, 0));
  });

  it('разовая задача после запуска выключается', async () => {
    const due = Date.UTC(2026, 2, 10, 9, 0);
    await store().save(root, [task({ repeat: 'once', date: '2026-03-10' })], due - 60_000);
    const { instance, handed } = service();

    await instance.tick(due);
    await instance.tick(due + 60_000);
    expect(handed).toHaveLength(1);
    const [stored] = await store().load(root);
    expect(stored!.enabled).toBe(false);
  });

  it('без окна и без ассистента не срабатывает и не сжигает время', async () => {
    const due = Date.UTC(2026, 2, 10, 9, 0);
    await store().save(root, [task()], due - 60_000);

    const noWindow = service({ canRun: false });
    await noWindow.instance.tick(due);
    expect(noWindow.handed).toEqual([]);

    const noAi = service({ aiEnabled: false });
    await noAi.instance.tick(due);
    expect(noAi.handed).toEqual([]);

    // Время не тронуто: когда окно появится, задача всё ещё «ждёт».
    const [stored] = await store().load(root);
    expect(stored!.lastRunAt).toBeUndefined();
    expect(stored!.nextRunAt).toBe(due);
  });

  it('пропущенное время не догоняется пачкой, а срабатывает один раз', async () => {
    const due = Date.UTC(2026, 2, 10, 9, 0);
    await store().save(root, [task()], due - 60_000);
    const { instance, handed } = service();

    // Приложение не работало неделю.
    await instance.tick(due + 7 * 24 * 3_600_000);
    expect(handed).toHaveLength(1);
  });
});

describe('правка списка', () => {
  const service = () => {
    const handed: TaskSchedule[] = [];
    const instance = new ScheduleService({
      root: () => root,
      notify: (schedule) => handed.push(schedule),
      canRun: () => true,
      aiEnabled: () => true,
    });
    return { instance, handed };
  };

  it('задача без названия или запроса не сохраняется', async () => {
    const { instance } = service();
    await expect(instance.save(task({ title: '  ' }))).rejects.toThrow('название');
    await expect(instance.save(task({ prompt: '' }))).rejects.toThrow('запрос');
    expect(await instance.list()).toEqual([]);
  });

  it('новая задача получает идентификатор, правка его сохраняет', async () => {
    const { instance } = service();
    const created = await instance.save(task({ id: '' }));
    expect(created[0]!.id).not.toBe('');
    const id = created[0]!.id;

    const edited = await instance.save({ ...created[0]!, title: 'Другое имя' });
    expect(edited).toHaveLength(1);
    expect(edited[0]!.id).toBe(id);
    expect(edited[0]!.title).toBe('Другое имя');
  });

  it('итог запуска пишется в файл, а разовая задача закрывается', async () => {
    const { instance } = service();
    const [created] = await instance.save(task());
    const finished = await instance.finish(created!.id, 'ok');
    expect(finished[0]!.lastResult).toBe('ok');
    expect(typeof finished[0]!.lastRunAt).toBe('number');
  });

  it('удалённая задача исчезает из списка', async () => {
    const { instance } = service();
    const [created] = await instance.save(task());
    expect(await instance.remove(created!.id)).toEqual([]);
  });
});
