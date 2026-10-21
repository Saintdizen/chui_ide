import type { ChatUsage } from './api';
import { usageCost } from './usage';

/**
 * Бюджет беседы в деньгах.
 *
 * Потолки по шагам (`maxSteps`, `MAX_GOAL_CONTINUES`) ограничивают длину, но не
 * цену: один шаг на дорогой модели с большим контекстом может стоить как сто
 * дешёвых. Здесь считается сумма за беседу, и при превышении включается
 * деградация — дальше подзадачи идут дешёвой моделью.
 *
 * Почему деградация, а не отказ: обрывать беседу посреди работы хуже, чем
 * доработать её экономнее. Человек дописывает ответ, но каждый следующий шаг
 * оплачивается по меньшему тарифу.
 */
export interface ChatBudgetState {
  /** Потолок на беседу в долларах; 0 — бюджет выключен. */
  limitUsd: number;
  /** Сколько уже потрачено за беседу. */
  spentUsd: number;
}

export type BudgetVerdict =
  /** Всё в порядке, работаем выбранной моделью. */
  | { action: 'ok' }
  /** Потолок пройден: дальше дешёвая модель. `spentUsd` — для сообщения человеку. */
  | { action: 'degrade'; spentUsd: number; limitUsd: number }
  /** Потолок пройден и дешевле идти некуда — честно останавливаемся. */
  | { action: 'stop'; spentUsd: number; limitUsd: number };

/**
 * Что делать при текущем расходе.
 *
 * `limitUsd <= 0` — бюджет выключен (значение по умолчанию): поведение прежнее,
 * ни одна беседа не упирается в потолок, которого человек не ставил.
 *
 * Дешёвая модель считается «есть куда идти», только если она отличается от
 * текущей: иначе деградация ничего не меняет и превратилась бы в бесконечный
 * повторный заход с тем же тарифом.
 */
export function budgetVerdict(state: ChatBudgetState, options: { canDegrade: boolean }): BudgetVerdict {
  const limit = Math.max(0, state.limitUsd);
  if (limit === 0) return { action: 'ok' };

  const spent = Math.max(0, state.spentUsd);
  if (spent < limit) return { action: 'ok' };

  return options.canDegrade
    ? { action: 'degrade', spentUsd: spent, limitUsd: limit }
    : { action: 'stop', spentUsd: spent, limitUsd: limit };
}

/** Стоимость шага; `null` — модель не из прайса, считать нечем. */
export function stepCost(usage: ChatUsage | undefined, model: string): number | null {
  return usageCost(usage, model);
}

/**
 * Текст для человека, когда бюджет упёрся. Одинаковый для деградации и отказа —
 * разница только в хвосте, поэтому собирается в одном месте.
 */
export function budgetMessage(verdict: Extract<BudgetVerdict, { spentUsd: number }>, degrading: boolean): string {
  const spent = verdict.spentUsd.toFixed(2);
  const limit = verdict.limitUsd.toFixed(2);
  return degrading
    ? `Израсходован бюджет беседы: $${spent} из $${limit}. Дальше работаю дешёвой моделью.`
    : `Израсходован бюджет беседы: $${spent} из $${limit}. Продолжить — поднимите потолок в настройках AI.`;
}

/**
 * Сколько токенов контекста считается тяжёлым.
 *
 * Окно модели говорит, сколько влезет, но не сколько это стоит: контекст едет
 * в каждом шаге прогона, и по замерам 21.10.2026 (deepseek-flash) средний шаг
 * вёз 76 000 токенов — 195 000 по тридцатидневной выгрузке. Кеш это удешевляет,
 * но счёт всё равно растёт от объёма, а не от числа инструментов.
 *
 * Порог сознательно ниже окна: у глубокого окна в миллион токенов условие
 * «0.8 окна» не наступает никогда, и сжатие истории молчит.
 */
export const HEAVY_CONTEXT_TOKENS = 80_000;

/**
 * Текст для человека, когда контекст шага перевалил за порог. Говорим один раз
 * за прогон: повтор на каждом шаге превратил бы ленту в счётчик.
 */
export function contextHeavyMessage(tokens: number): string {
  const k = Math.round(tokens / 1000);
  return (
    `Контекст прогона — ${k}k токенов, и каждый следующий шаг несёт его целиком. ` +
    'Старые результаты сворачиваю охотнее; новый прогон начнётся дешевле.'
  );
}
