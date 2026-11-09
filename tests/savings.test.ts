import { describe, expect, it } from 'vitest';
import { savingsLine, savingsSummary } from '../src/main/ai/savings';
import { inTokens } from '../src/main/ai/search-cache';

/**
 * Сводка экономии среза (п.67).
 *
 * Экономия разбросана по пяти механизмам, и каждый по отдельности выглядит
 * мелочью. Вместе — число, без которого пункт экономии не проверить.
 */

describe('сводка экономии', () => {
  it('складывает части и считает токены', () => {
    const summary = savingsSummary([
      { name: 'readModes', chars: 4000, times: 3 },
      { name: 'repeats', chars: 2000, times: 1 },
    ]);
    expect(summary.chars).toBe(6000);
    expect(summary.tokens).toBeGreaterThan(1000);
    expect(summary.tokens).toBeLessThan(6000);
  });

  it('нулевые механизмы в сводку не идут', () => {
    const summary = savingsSummary([{ name: 'tree', chars: 0, times: 0 }]);
    expect(summary.parts).toEqual([]);
    expect(savingsLine(summary)).toContain('нечего показать');
  });

  it('порядок — по вкладу', () => {
    const summary = savingsSummary([
      { name: 'repeats', chars: 100, times: 1 },
      { name: 'searchCache', chars: 900, times: 2 },
    ]);
    expect(summary.parts.map((part) => part.name)).toEqual(['кэш поиска', 'повторы ответов']);
  });

  it('в строке видно общий итог и разбивку', () => {
    const line = savingsLine(savingsSummary([{ name: 'tree', chars: 5000, times: 1 }]));
    expect(line).toContain('экономия:');
    expect(line).toContain('дерево папки');
  });

  it('перевод в токены — тот же, что у истории чата', () => {
    const stats = inTokens({ hits: 1, misses: 0, savedChars: 3500 });
    expect(stats.savedTokens).toBeGreaterThan(800);
    expect(stats.savedTokens).toBeLessThan(3500);
  });
});
