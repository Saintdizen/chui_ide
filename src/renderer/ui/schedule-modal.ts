import type { RpcClient } from '../core/rpc';
import type { ScheduleRepeat, TaskSchedule } from '../../shared/scheduling';
import {
  MAX_SCHEDULE_TITLE,
  WEEKDAY_SHORT_ORDER,
  describeSchedule,
  formatScheduleTime,
  parseScheduleTime,
  resultLabel,
  scheduleProblems,
  systemTimezone,
  weekdayName,
} from '../../shared/scheduling';
import { clear, h, svgIcon } from './dom';
import { createModal } from './modal';
import { createSelect, type SelectView } from './select';

export interface ScheduleModalDeps {
  rpc: RpcClient;
  notify(message: string, kind?: 'info' | 'error'): void;
  /**
   * Запустить задачу сейчас. Ход живёт в панели чата, поэтому окно только просит
   * об этом: само оно беседу не ведёт.
   */
  runNow(schedule: TaskSchedule): Promise<void>;
}

export interface ScheduleModalView {
  element: HTMLElement;
  open(): Promise<void>;
  close(): void;
}

/** Что предлагаем в списке повторов: подпись — для человека, значение — в файл. */
const REPEAT_OPTIONS: { value: ScheduleRepeat; label: string }[] = [
  { value: 'daily', label: 'Каждый день' },
  { value: 'weekly', label: 'По дням недели' },
  { value: 'once', label: 'Один раз' },
  { value: 'interval', label: 'Каждые несколько минут' },
];

/** Порядок дней в форме начинается с понедельника: так неделю читают, а не как `getDay`. */
const MONDAY_FIRST = WEEKDAY_SHORT_ORDER;

/**
 * Экран «Расписание задач»: когда ассистент начинает ход сам.
 *
 * Задачи живут в проекте (`.chui/schedules.json`), читает и пишет их main — окно
 * только показывает список и собирает правило. Время задаётся вместе с часовым
 * поясом: «по пятницам в 17:00» без пояса означало бы разное время на разных
 * машинах, а задача должна срабатывать там, где её завели.
 */
export function createScheduleModal(deps: ScheduleModalDeps): ScheduleModalView {
  let schedules: TaskSchedule[] = [];
  let busy = false;
  /** Задача, которую сейчас правят; `null` — форма заводит новую. */
  let editingId: string | null = null;
  /**
   * Была ли задача включена до правки. Правка не меняет этого сама: править
   * приостановленную задачу — не повод её включить.
   */
  let editingEnabled = true;

  const listBox = h('div', { class: 'schedule-list' });
  const noteBox = h('div', { class: 'schedule-note' });

  /* ── форма задачи ──────────────────────────────────────────────────────── */

  const titleInput = h('input', {
    class: 'field-input',
    type: 'text',
    spellcheck: false,
    maxlength: String(MAX_SCHEDULE_TITLE),
    placeholder: 'Например: недельный отчёт',
  });
  const promptInput = h('textarea', {
    class: 'field-input schedule-prompt',
    rows: '3',
    spellcheck: false,
    placeholder: 'Что попросить у ассистента. Текст уйдёт как обычный вопрос в новую беседу.',
  });
  const repeatSelect: SelectView = createSelect({ title: 'Как часто' });
  repeatSelect.setOptions(REPEAT_OPTIONS.map(({ value, label }) => ({ value, label })));
  repeatSelect.setValue('weekly');
  const timeInput = h('input', { class: 'field-input schedule-time', type: 'time', value: '09:00' });
  const dateInput = h('input', { class: 'field-input schedule-date', type: 'date' });
  // Интервал — минуты, а не время суток: он отсчитывается от прошлого запуска.
  const everyInput = h('input', {
    class: 'field-input schedule-every',
    type: 'number',
    min: '1',
    max: '10080',
    step: '1',
    value: '30',
  });
  const zoneInput = h('input', {
    class: 'field-input',
    type: 'text',
    spellcheck: false,
    value: systemTimezone(),
    placeholder: 'Europe/Moscow',
  });
  const weekdayBoxes = new Map<number, HTMLInputElement>();
  const weekdayRow = h('div', { class: 'schedule-weekdays' });
  for (const day of MONDAY_FIRST) {
    const box = h('input', { type: 'checkbox' });
    weekdayBoxes.set(day, box);
    weekdayRow.append(h('label', { class: 'schedule-weekday', title: weekdayName(day) }, box, weekdayName(day, true)));
  }
  const timeRow = h('div', { class: 'field-row' }, h('span', { class: 'field-name' }, 'Время'), timeInput);
  const dateRow = h('div', { class: 'field-row', hidden: true }, h('span', { class: 'field-name' }, 'Дата'), dateInput);
  const everyRow = h(
    'div',
    { class: 'field-row', hidden: true },
    h('span', { class: 'field-name' }, 'Минут'),
    everyInput,
  );
  const weekdayField = h('div', { class: 'field-row' }, h('span', { class: 'field-name' }, 'Дни'), weekdayRow);

  const problemsBox = h('div', { class: 'schedule-problems' });

  const submitButton = h(
    'button',
    { class: 'btn btn-primary', type: 'button', onClick: () => void submit() },
    'Добавить',
  );
  const cancelButton = h('button', { class: 'btn', type: 'button', onClick: () => closeForm() }, 'Отмена');

  const form = h(
    'div',
    { class: 'schedule-form', hidden: true },
    h('div', { class: 'field-label' }, 'Новая задача'),
    titleInput,
    promptInput,
    h('div', { class: 'field-row' }, h('span', { class: 'field-name' }, 'Когда'), repeatSelect.element),
    timeRow,
    weekdayField,
    dateRow,
    everyRow,
    h('div', { class: 'field-row' }, h('span', { class: 'field-name' }, 'Пояс'), zoneInput),
    h(
      'div',
      { class: 'field-hint' },
      'Время — в указанном поясе: «пятница, 17:00, Europe/Moscow» сработает в 17:00 по Москве, ' +
        'даже если компьютер переехал. Задача запускается, только когда проект открыт.',
    ),
    problemsBox,
    h('div', { class: 'schedule-form-actions' }, cancelButton, submitButton),
  );

  const newButton = h(
    'button',
    { class: 'btn btn-primary', type: 'button', onClick: () => openForm(null) },
    'Новая задача',
  );
  // Действия окна — в подвале: тело растёт вместе со списком задач.
  const footer = h('footer', { class: 'modal-footer is-end' }, newButton);

  const modal = createModal({
    className: 'schedule-modal',
    title: 'Расписание задач',
    headerIcon: 'clock',
    footer,
  });
  modal.body.append(noteBox, form, listBox);

  const close = (): void => modal.close();

  /* ── форма: открыть, закрыть, сохранить ────────────────────────────────── */

  const syncFormKind = (): void => {
    const repeat = repeatSelect.value as ScheduleRepeat;
    weekdayField.hidden = repeat !== 'weekly';
    dateRow.hidden = repeat !== 'once';
    // У интервала вместо времени суток — минуты.
    timeRow.hidden = repeat === 'interval';
    everyRow.hidden = repeat !== 'interval';
  };
  repeatSelect.onChange(syncFormKind);

  /** Форма в режиме «правим задачу» или «заводим новую» — от этого зависит подпись. */
  const setEditing = (schedule: TaskSchedule | null): void => {
    editingId = schedule?.id ?? null;
    editingEnabled = schedule?.enabled ?? true;
    const label = form.firstElementChild as HTMLElement;
    label.textContent = schedule ? 'Правка задачи' : 'Новая задача';
    submitButton.textContent = schedule ? 'Сохранить' : 'Добавить';
  };

  function openForm(schedule: TaskSchedule | null): void {
    setEditing(schedule);
    titleInput.value = schedule?.title ?? '';
    promptInput.value = schedule?.prompt ?? '';
    repeatSelect.setValue(schedule?.repeat ?? 'weekly');
    timeInput.value = schedule?.time
      ? formatScheduleTime(parseScheduleTime(schedule.time) ?? { hours: 9, minutes: 0 })
      : '09:00';
    everyInput.value = String(schedule?.intervalMinutes ?? 30);
    zoneInput.value = schedule?.timezone ?? systemTimezone();
    dateInput.value = schedule?.date ?? '';
    const days = new Set(schedule?.weekdays ?? []);
    for (const [day, box] of weekdayBoxes) box.checked = days.has(day);
    clear(problemsBox);
    form.hidden = false;
    // Подвал прячется целиком: пустая полоса с рамкой под формой читалась бы
    // как «здесь что-то не дорисовали».
    footer.hidden = true;
    syncFormKind();
    titleInput.focus();
  }

  function closeForm(): void {
    form.hidden = true;
    footer.hidden = false;
    setEditing(null);
    clear(problemsBox);
  }

  /** Строка задачи в том виде, в каком её ждёт файл. */
  const draftFromForm = (): TaskSchedule => {
    const repeat = repeatSelect.value as ScheduleRepeat;
    return {
      id: editingId ?? '',
      title: titleInput.value.trim(),
      prompt: promptInput.value.trim(),
      repeat,
      timezone: zoneInput.value.trim(),
      // Интервалу время суток не нужно, а правилам по часам не нужны минуты.
      ...(repeat === 'interval'
        ? { intervalMinutes: Number(everyInput.value) || 0 }
        : { time: timeInput.value || '09:00' }),
      ...(repeat === 'weekly'
        ? { weekdays: [...weekdayBoxes].filter(([, box]) => box.checked).map(([day]) => day) }
        : {}),
      ...(repeat === 'once' && dateInput.value ? { date: dateInput.value } : {}),
      enabled: editingEnabled,
      createdAt: Date.now(),
    };
  };

  async function submit(): Promise<void> {
    if (busy) return;
    const draft = draftFromForm();
    clear(problemsBox);
    const problems = scheduleProblems(draft);
    if (problems.length > 0) {
      for (const text of problems) problemsBox.append(h('p', { class: 'schedule-problem' }, text));
      return;
    }

    busy = true;
    try {
      schedules = await deps.rpc.request('schedule.save', { schedule: draft });
      deps.notify(editingId ? 'Задача обновлена' : `Задача «${draft.title}» заведена`);
      closeForm();
      render();
    } catch (error) {
      problemsBox.append(h('p', { class: 'schedule-problem' }, error instanceof Error ? error.message : String(error)));
    } finally {
      busy = false;
    }
  }

  /* ── список ────────────────────────────────────────────────────────────── */

  /** Когда задача сработает в следующий раз — в ЕЁ поясе, а не в местном. */
  const nextLabel = (schedule: TaskSchedule): string => {
    if (!schedule.enabled) return 'приостановлена';
    if (typeof schedule.nextRunAt !== 'number') return 'время не рассчитано';
    try {
      return new Intl.DateTimeFormat('ru-RU', {
        timeZone: schedule.timezone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(schedule.nextRunAt));
    } catch {
      return new Date(schedule.nextRunAt).toLocaleString('ru-RU');
    }
  };

  const lastLabel = (schedule: TaskSchedule): string => {
    if (typeof schedule.lastRunAt !== 'number') return '';
    const when = new Date(schedule.lastRunAt).toLocaleString('ru-RU', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    return schedule.lastResult ? `${when} · ${resultLabel(schedule.lastResult)}` : when;
  };

  const row = (schedule: TaskSchedule): HTMLElement => {
    const enabledBox = h('input', { type: 'checkbox' });
    enabledBox.checked = schedule.enabled;
    enabledBox.addEventListener('change', () => {
      void patch(schedule, { enabled: enabledBox.checked });
    });

    const run = h('button', { class: 'icon-btn', type: 'button', title: 'Выполнить сейчас' }, svgIcon('play', 14));
    run.addEventListener('click', () => {
      // Задачу запускаем и тогда, когда она приостановлена: это разовое действие
      // человека, а не срабатывание расписания. Окно закрываем — ход идёт в чате.
      close();
      void deps.runNow(schedule);
    });

    const edit = h('button', { class: 'icon-btn', type: 'button', title: 'Изменить' }, svgIcon('pencil', 14));
    edit.addEventListener('click', () => openForm(schedule));

    const remove = h('button', { class: 'icon-btn', type: 'button', title: 'Удалить' }, svgIcon('trash', 14));
    remove.addEventListener('click', () => void drop(schedule));

    const last = lastLabel(schedule);

    return h(
      'div',
      { class: `schedule-item${schedule.enabled ? '' : ' is-off'}` },
      h(
        'div',
        { class: 'schedule-info' },
        h('div', { class: 'schedule-title' }, schedule.title),
        h('div', { class: 'schedule-meta' }, describeSchedule(schedule)),
        h('div', { class: 'schedule-when' }, `следующий запуск: ${nextLabel(schedule)}`),
        last ? h('div', { class: 'schedule-last' }, `последний: ${last}`) : null,
      ),
      h(
        'div',
        { class: 'schedule-actions' },
        h('label', { class: 'schedule-check', title: 'Включить или приостановить' }, enabledBox, 'включена'),
        run,
        edit,
        remove,
      ),
    );
  };

  async function patch(schedule: TaskSchedule, changes: Partial<TaskSchedule>): Promise<void> {
    try {
      schedules = await deps.rpc.request('schedule.save', { schedule: { ...schedule, ...changes } });
      render();
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
      render();
    }
  }

  async function drop(schedule: TaskSchedule): Promise<void> {
    try {
      schedules = await deps.rpc.request('schedule.remove', { id: schedule.id });
      deps.notify(`Задача «${schedule.title}» удалена`);
      render();
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  function render(): void {
    clear(listBox);
    clear(noteBox);
    if (schedules.length === 0) {
      listBox.append(h('p', { class: 'schedule-empty' }, 'Расписание пустое. Задача — это запрос и правило «когда».'));
      return;
    }
    for (const schedule of schedules) listBox.append(row(schedule));
    noteBox.append(
      h(
        'p',
        { class: 'schedule-hint' },
        'Задачи живут в проекте (.chui/schedules.json) и запускаются, пока проект открыт. ' +
          'Каждый запуск — новая беседа: переписка прошлого раза её не отягощает.',
      ),
    );
  }

  async function open(): Promise<void> {
    modal.open();
    closeForm();
    render();
    try {
      schedules = await deps.rpc.request('schedule.list');
    } catch (error) {
      schedules = [];
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    }
    render();
  }

  return { element: modal.element, open, close };
}
