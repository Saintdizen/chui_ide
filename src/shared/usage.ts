/**
 * Расход токенов и его стоимость: сложение и подсчёт.
 *
 * Провайдер сообщает расход по одному запросу, а агентский прогон — это несколько
 * «модель → инструмент → модель». Чтобы посчитать расход за весь прогон, а не за
 * последний шаг, значения надо складывать, и правило сложения простое, но его легко
 * размазать по вызовам и ошибиться. Поэтому оно здесь, чистое и под тестом.
 *
 * Стоимость считаем только для моделей из таблицы цен (`shared/providers.ts`):
 * для неизвестной модели честнее вернуть `null`, чем выдумать число.
 */

import type { ChatRunTrace, ChatUsage } from './api';
import { isPeakTariff, pricingAt } from './providers';

/** Сложить два следа прогона: шаги, вызовы и расход. Нужен для накопления по беседе. */
export function addRunTrace(a: ChatRunTrace | undefined, b: ChatRunTrace | undefined): ChatRunTrace | undefined {
  if (!a) return b;
  if (!b) return a;
  return { steps: a.steps + b.steps, toolCalls: a.toolCalls + b.toolCalls, usage: addUsage(a.usage, b.usage) };
}

/** Сложить два расхода. Отсутствующее поле считается нулём, но остаётся отсутствующим, если его нет с обеих сторон. */
export function addUsage(a: ChatUsage | undefined, b: ChatUsage | undefined): ChatUsage {
  const sum = (left: number | undefined, right: number | undefined): number | undefined => {
    if (left === undefined && right === undefined) return undefined;
    return (left ?? 0) + (right ?? 0);
  };
  return {
    promptTokens: sum(a?.promptTokens, b?.promptTokens),
    completionTokens: sum(a?.completionTokens, b?.completionTokens),
    cachedTokens: sum(a?.cachedTokens, b?.cachedTokens),
    cacheCreationTokens: sum(a?.cacheCreationTokens, b?.cacheCreationTokens),
  };
}

/**
 * Сколько стоил расход для этой модели, в долларах. `null` — модели нет в таблице
 * цен: считать по чужому тарифу хуже, чем не показать вовсе.
 *
 * Три статьи входа стоят по-разному, и это не придирка: попадание в кеш дешевле
 * обычного ввода (у Anthropic — вдесятеро), а запись в кеш дороже (в 1.25 раза).
 * Считать всё по цене обычного ввода значит показывать цифру, по которой нельзя
 * решить, окупается ли кеш.
 */
export function usageCost(usage: ChatUsage | undefined, model: string, at?: Date): number | null {
  if (!usage) return null;
  // Тариф зависит от времени: в непиковые часы DeepSeek берёт вдвое меньше.
  const pricing = pricingAt(model, at);
  if (!pricing) return null;
  const total = usage.promptTokens ?? 0;
  const output = usage.completionTokens ?? 0;
  if (total === 0 && output === 0) return null;

  // `cachedTokens` — часть `promptTokens`, поэтому из общего вычитается: без этого
  // кешированное оплачивалось бы дважды — по полной цене и со скидкой.
  const cached = Math.min(Math.max(0, usage.cachedTokens ?? 0), total);
  const written = Math.min(Math.max(0, usage.cacheCreationTokens ?? 0), total - cached);
  const plain = Math.max(0, total - cached - written);

  return (
    (plain * pricing.input + cached * pricing.cachedInput + written * pricing.cacheWrite + output * pricing.output) /
    1_000_000
  );
}

/**
 * Подсказка про тариф, если сейчас дорогая половина суток. `null` — модель в
 * цену не входит или у неё нет дешёвых часов.
 *
 * Смысл не в том, чтобы что-то отложить (очереди задач у нас нет), а в том,
 * чтобы человек, запускающий длинный прогон, видел цену своих часов: у DeepSeek
 * тот же прогон вне 01–04 и 06–10 UTC стоит вдвое меньше.
 */
export function peakTariffHint(model: string, at: Date = new Date()): string | null {
  // Только DeepSeek: у остальных провайдеров дешёвого тарифа нет, и
  // `isPeakTariff` там врет по умолчанию («всегда пик»).
  if (!model.trim().toLowerCase().startsWith('deepseek')) return null;
  if (!pricingAt(model, at)) return null;
  if (!isPeakTariff(model, at)) return null;
  return 'сейчас пик, вне 01–04 и 06–10 UTC вдвое дешевле';
}

/** Короткая запись числа токенов: 1 200 → «1.2K». */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

/** Стоимость в долларах: мелкие суммы показываем с большей точностью. */
export function formatCost(value: number): string {
  if (value > 0 && value < 0.01) return value.toFixed(4);
  return value.toFixed(2);
}
