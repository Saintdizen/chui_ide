import { describe, expect, it } from 'vitest';
import { addRunTrace, addUsage, formatCost, formatTokens, usageCost } from '../src/shared/usage';

/**
 * Сложение расхода и подсчёт стоимости: правило, а не запуск. Цены берём из
 * `shared/providers.ts` — модели, которых там нет, стоимости не имеют.
 */

describe('addUsage', () => {
  it('складывает числа по всем полям', () => {
    expect(addUsage({ promptTokens: 100, completionTokens: 20 }, { promptTokens: 50, completionTokens: 5 })).toEqual({
      promptTokens: 150,
      completionTokens: 25,
      cachedTokens: undefined,
    });
  });

  it('отсутствующее поле считается нулём, но если его нет с обеих сторон — его нет', () => {
    expect(addUsage({ promptTokens: 10 }, {})).toEqual({
      promptTokens: 10,
      completionTokens: undefined,
      cachedTokens: undefined,
    });
    expect(addUsage(undefined, undefined)).toEqual({
      promptTokens: undefined,
      completionTokens: undefined,
      cachedTokens: undefined,
    });
  });

  it('один из аргументов отсутствует — берётся второй', () => {
    expect(addUsage(undefined, { promptTokens: 7, completionTokens: 3 }).promptTokens).toBe(7);
  });
});

describe('addRunTrace', () => {
  it('складывает шаги, вызовы и расход', () => {
    const a = { steps: 2, toolCalls: 5, usage: { promptTokens: 100, completionTokens: 10 } };
    const b = { steps: 1, toolCalls: 3, usage: { promptTokens: 40, completionTokens: 4 } };
    expect(addRunTrace(a, b)).toEqual({
      steps: 3,
      toolCalls: 8,
      usage: { promptTokens: 140, completionTokens: 14, cachedTokens: undefined },
    });
  });

  it('отсутствующий след не обнуляет второй', () => {
    const only = { steps: 1, toolCalls: 1, usage: { promptTokens: 5 } };
    expect(addRunTrace(undefined, only)).toBe(only);
    expect(addRunTrace(only, undefined)).toBe(only);
  });
});

describe('usageCost', () => {
  it('считается по цене модели за миллион токенов', () => {
    // gpt-4o: input 2.5, output 10 за 1M.
    const cost = usageCost({ promptTokens: 1_000_000, completionTokens: 1_000_000 }, 'gpt-4o');
    expect(cost).toBeCloseTo(12.5, 5);
  });

  it('неизвестная модель — стоимости нет, а не ноль', () => {
    expect(usageCost({ promptTokens: 1000 }, 'какая-то-модель')).toBeNull();
  });

  it('нет расхода — стоимости нет', () => {
    expect(usageCost({}, 'gpt-4o')).toBeNull();
    expect(usageCost(undefined, 'gpt-4o')).toBeNull();
  });
});

describe('формат чисел', () => {
  it('токены сокращаются, мелкие — как есть', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1200)).toBe('1.2K');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });

  it('стоимость: мелкую показываем точнее', () => {
    expect(formatCost(1.5)).toBe('1.50');
    expect(formatCost(0.0042)).toBe('0.0042');
  });
});

describe('usageCost и кеш промпта', () => {
  it('попадание в кеш считается по скидке, а не по полной цене', () => {
    // gpt-4o: input 2.5, попадание в кеш вдвое дешевле — 1.25 за 1M.
    const cost = usageCost({ promptTokens: 1_000_000, cachedTokens: 1_000_000 }, 'gpt-4o');
    expect(cost).toBeCloseTo(1.25, 5);
  });

  it('запись в кеш у Anthropic дороже обычного ввода', () => {
    // claude-sonnet: input 3, запись 3.75 за 1M.
    const cost = usageCost({ promptTokens: 1_000_000, cacheCreationTokens: 1_000_000 }, 'claude-sonnet-4-5');
    expect(cost).toBeCloseTo(3.75, 5);
  });

  it('смешанный запрос не оплачивает кеш дважды', () => {
    // 1M всего: из них 600k из кеша (1.25), 100k записано (2.5), 300k обычных (2.5).
    const cost = usageCost({ promptTokens: 1_000_000, cachedTokens: 600_000, cacheCreationTokens: 100_000 }, 'gpt-4o');
    expect(cost).toBeCloseTo((600_000 * 1.25 + 400_000 * 2.5) / 1_000_000, 5);
  });
});
