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
import { modelPricing } from './providers';

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
  };
}

/**
 * Сколько стоил расход для этой модели, в долларах. `null` — модели нет в таблице
 * цен: считать по чужому тарифу хуже, чем не показать вовсе.
 */
export function usageCost(usage: ChatUsage | undefined, model: string): number | null {
  if (!usage) return null;
  const pricing = modelPricing(model);
  if (!pricing) return null;
  const input = usage.promptTokens ?? 0;
  const output = usage.completionTokens ?? 0;
  if (input === 0 && output === 0) return null;
  return (input / 1_000_000) * pricing.input + (output / 1_000_000) * pricing.output;
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
