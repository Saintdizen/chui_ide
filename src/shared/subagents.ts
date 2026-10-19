/**
 * Подзадачи агента: разбор аргументов `task` и сводный отчёт.
 *
 * Одна подзадача — это отдельный агент со своим контекстом: он читает проект и
 * возвращает отчёт, а основной прогон его чтений не видит. Полезно, но по одной
 * штуке медленно: три независимых вопроса («где лежит X», «как устроен Y», «что
 * пишут в документации про Z») ждали друг друга по очереди.
 *
 * Здесь два решения, которые дорого переделывать потом:
 *
 *   1. Предел на раз (`MAX_TASKS`) и на одновременность (`MAX_PARALLEL`). Каждая
 *      подзадача — это свой прогон модели, то есть деньги и токены; десяток разом
 *      человек не заказывал.
 *   2. Одна упавшая подзадача не отменяет остальные. Отчёт поэтому собирается по
 *      каждой отдельно: что нашла, что не смогла и почему. Молча потерять треть
 *      работы хуже, чем показать её с пометкой.
 *
 * Модуль чистый: только разбор аргументов и текст отчёта, поэтому проверяется
 * юнит-тестами без окна и без провайдера.
 */

/** Сколько подзадач принимаем за один вызов: это «несколько», а не «сотня». */
export const MAX_TASKS = 4;

/** Сколько подзадач идут одновременно: каждая — отдельный прогон модели. */
export const MAX_PARALLEL = 3;

/** Короткая подпись подзадачи: она попадает в трассу и в сводку. */
const MAX_DESCRIPTION_CHARS = 80;

/** Одна подзадача в том виде, в каком её исполняет сервис. */
export interface SubagentTask {
  description: string;
  prompt: string;
}

/** Итог разбора аргументов: либо список задач, либо причина отказа. */
export interface SubagentTaskRequest {
  tasks: SubagentTask[];
  /** Что не так с аргументами. Пусто — можно запускать. */
  error?: string;
}

/** Подпись задачи: одна строка, чтобы сводка не расползалась. */
export function clipDescription(raw: unknown, fallback = 'подзадача'): string {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!text) return fallback;
  if (text.length <= MAX_DESCRIPTION_CHARS) return text;
  const cut = text.slice(0, MAX_DESCRIPTION_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_DESCRIPTION_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Разобрать аргументы вызова.
 *
 * Поддерживаем обе формы: одну задачу (`prompt`) и список (`tasks`). Так модель,
 * которая помнит прежнюю схему, всё равно сработает, а не потратит шаг на
 * переучивание. Лишние сверх `MAX_TASKS` отбрасываем и говорим об этом в отказе —
 * молча потерять половину задания хуже, чем попросить переформулировать.
 */
export function parseSubagentTasks(args: Record<string, unknown>): SubagentTaskRequest {
  const single = text(args.prompt);
  if (single) {
    return { tasks: [{ description: clipDescription(args.description), prompt: single }] };
  }

  const raw = args.tasks;
  if (!Array.isArray(raw)) {
    return {
      tasks: [],
      error: 'Нужен либо prompt (одна подзадача), либо tasks — список из 1–4 подзадач ' + '[{ description, prompt }].',
    };
  }

  const tasks: SubagentTask[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;
    const prompt = text(record.prompt);
    if (!prompt) continue;
    tasks.push({ description: clipDescription(record.description), prompt });
  }

  if (tasks.length === 0) {
    return {
      tasks: [],
      error: 'В tasks нет ни одной подзадачи с непустым prompt. Опиши, что именно исследовать.',
    };
  }
  if (tasks.length > MAX_TASKS) {
    return {
      tasks: [],
      error:
        `Подзадач ${tasks.length}, а за раз можно не больше ${MAX_TASKS}: каждая — отдельный прогон модели. ` +
        'Разбей работу на несколько вызовов.',
    };
  }
  return { tasks };
}

/** Задача, которая не дошла до конца: причина словами. */
export interface SubagentFailure {
  description: string;
  reason: string;
}

/**
 * Сводный отчёт для модели.
 *
 * Устроен как отчёт подзадачи: сначала что нашла каждая, потом что не смогла.
 * Отдельный раздел про провал нужен, чтобы модель его заметила и не считала
 * работу выполненной целиком: пустота в середине списка читается как «там ничего
 * нет», а это разные вещи.
 */
export function formatSubagentReport(
  results: readonly { description: string; text: string }[],
  failures: readonly SubagentFailure[] = [],
): string {
  const parts: string[] = [];
  for (const result of results) {
    parts.push(`## ${result.description}\n${result.text.trim()}`);
  }
  if (failures.length > 0) {
    const lines = failures.map((failure) => `- ${failure.description}: ${failure.reason}`);
    parts.push(['## Не удалось', ...lines].join('\n'));
  }
  return parts.join('\n\n');
}

/**
 * Сколько задач запускать сразу. Мельче `MAX_PARALLEL` — по числу задач: гнать
 * три пула ради одной подзадачи незачем.
 */
export function subagentBatchSize(count: number): number {
  return Math.max(1, Math.min(MAX_PARALLEL, count));
}

/**
 * Выполнить задачи, держа не больше `limit` одновременно.
 *
 * Пул, а не `Promise.all` по всему списку: каждая задача — прогон модели, и
 * «запустить всё сразу» означало бы платить за четыре прогона там, где человек
 * просил три. Очередь общая: освободившийся работник берёт следующую задачу.
 *
 * Ошибка задачи не прерывает остальные — она попадает в `failed` со своим
 * индексом. Исключение — отмена прогона: если сигнал сработал, добивать очередь
 * незачем, и отказ уходит наружу.
 */
export async function runWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
  options: { signal?: AbortSignal } = {},
): Promise<{ done: { index: number; value: R }[]; failed: { index: number; error: unknown }[] }> {
  const size = Math.max(1, Math.min(limit, items.length));
  const done: { index: number; value: R }[] = [];
  const failed: { index: number; error: unknown }[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        done.push({ index, value: await run(items[index]!, index) });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        failed.push({ index, error });
      }
    }
  };

  await Promise.all(Array.from({ length: size }, () => worker()));

  // Порядок ответа не должен зависеть от того, кто финишировал первым: иначе
  // отчёт в ленте «прыгал» бы между запусками.
  done.sort((a, b) => a.index - b.index);
  failed.sort((a, b) => a.index - b.index);
  return { done, failed };
}
