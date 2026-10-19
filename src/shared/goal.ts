import type { ChatGoal } from './api';

/**
 * Цель работы — то, что переживает ход беседы.
 *
 * Вопрос живёт один запрос: модель ответила — работа кончилась. Цель так не
 * работает. «Доведи сборку до зелёного» — это не реплика, а условие окончания:
 * пока оно не выполнено, каждый законченный ход — не финал, а пауза. Пока цель
 * открыта, она уходит модели в каждом запросе (в том числе после перезапуска
 * окна), а ход, кончившийся без её закрытия, main продолжает сам.
 *
 * Отсюда две вещи, которые нельзя путать. План (`PlanStep[]`) — это порядок
 * шагов одной задачи, он живёт внутри прогона и умирает вместе с ним. Цель —
 * условие «готово», и живёт она в беседе. Цель без плана законна (человек и так
 * знает, чего хочет), план без цели — тоже (мелкая задача в один ход).
 */

/**
 * Потолок текста цели. Цель — одна фраза про результат, а не задание на абзац:
 * она едет в каждый запрос беседы, и длинный текст платился бы на каждом шаге.
 */
export const GOAL_MAX_CHARS = 300;

/**
 * Сколько раз за прогон main продолжает ход сам.
 *
 * Три — потому что это уже не «ответ», а работа: если модель трижды подряд
 * закончила ход, не закрыв цель, дело не в нехватке шага, а в самой цели
 * (недостижима, понята неверно, нужно решение человека). Дальше честнее
 * остановиться и сказать об этом, чем жечь токены в петле.
 */
export const MAX_GOAL_CONTINUES = 3;

/**
 * Текст цели из недоверенного источника (renderer, файл беседы, аргументы
 * инструмента): пустое — нет цели, длинное — обрезаем по границе слова.
 */
export function sanitizeGoal(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  if (text.length <= GOAL_MAX_CHARS) return text;
  const cut = text.slice(0, GOAL_MAX_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > GOAL_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Разбор аргументов инструмента `update_goal`: поставить цель или закрыть её. */
export interface GoalUpdate {
  /** Новый текст цели. Не задан — цель не меняется. */
  text?: string;
  /** `true` — цель достигнута; `false` — работа продолжается. */
  done?: boolean;
}

export function parseGoalUpdate(raw: string): GoalUpdate | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const update: GoalUpdate = {};
  const text = sanitizeGoal((value as { goal?: unknown }).goal);
  if (text) update.text = text;
  const done = (value as { done?: unknown }).done;
  if (typeof done === 'boolean') update.done = done;
  return update.text === undefined && update.done === undefined ? null : update;
}

/**
 * Строка цели в системном промпте. Едет в каждый запрос, пока цель открыта,
 * поэтому говорит только то, чего модель иначе не поймёт: ход не равен работе,
 * а «готово» объявляется вызовом, а не словами.
 */
export function goalPrompt(goal: ChatGoal | string): string {
  const text = typeof goal === 'string' ? goal : goal.text;
  return [
    `Цель работы (поставлена заранее, держи её в уме до конца): ${text}`,
    'Это не вопрос на один ответ: продолжай, пока цель не достигнута, и не считай законченный ход поводом остановиться.',
    'Когда цель достигнута — закрой её вызовом update_goal с done: true (и повтори текст цели).',
    'Если цель оказалась неверной или недостижимой, скажи об этом прямо, а не отмечай её закрытой.',
  ].join('\n');
}

/**
 * Запрос продолжения: ход кончился, а цель открыта. Модель не знает, что её
 * ответ был промежуточным, — поэтому это сказано словами, как и в случае
 * обрыва по лимиту токенов (см. `CONTINUE_PROMPT` в renderer'е).
 */
export function goalContinuePrompt(goal: ChatGoal | string, attempt: number, limit: number): string {
  const text = typeof goal === 'string' ? goal : goal.text;
  return [
    `Цель ещё не закрыта: ${text}`,
    `Продолжай работу с того места, где остановился (это ${attempt}-е продолжение из ${limit}).`,
    'Если для продолжения нужно решение человека — спроси его через ask, а не гадай.',
    'Если цель достигнута — закрой её вызовом update_goal с done: true.',
  ].join('\n');
}
