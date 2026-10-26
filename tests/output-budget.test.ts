import { describe, expect, it } from 'vitest';
import { fitOutput, fitOutputLines } from '../src/shared/output-budget';
import { CHARS_PER_TOKEN, CHARS_PER_TOKEN_WIDE, estimateTextTokens } from '../src/shared/context-fit';
import { runTool } from '../src/main/ai/agent-tools';
import type { ToolContext } from '../src/main/ai/tool-context';
import { MAX_OUTPUT_TOKENS } from '../src/main/ai/output-budget';
import { failureText } from '../src/main/ai/tool-rules';

describe('ограничение цены результата', () => {
  it('учитывает состав текста, сохраняет хвост и не разрывает Unicode', () => {
    const limit = { chars: 1000, tokens: 100 };
    for (const source of ['a'.repeat(2000), 'я'.repeat(2000), '😀'.repeat(2000)]) {
      for (const tail of [false, true]) {
        const result = fitOutput(source, limit, tail);
        expect(result.length).toBeLessThanOrEqual(limit.chars);
        expect(estimateTextTokens(result)).toBeLessThanOrEqual(limit.tokens);
        expect(result.isWellFormed()).toBe(true);
      }
    }
    expect(fitOutput('prefix\nimportant error', { chars: 15, tokens: 100 }, true)).toBe('important error');
  });

  it('строки для правок показываются целиком', () => {
    expect(fitOutputLines('1 | first\n2 | second', { chars: 15, tokens: 100 })).toMatchObject({
      text: '1 | first',
      lines: 1,
      complete: false,
    });
    expect(fitOutputLines('one long line', { chars: 3, tokens: 100 })).toMatchObject({
      text: '',
      lines: 0,
      complete: false,
    });
  });

  it('длинная ошибка тоже подчиняется бюджету вместе с её заголовком', async () => {
    const ctx = {
      workspace: {
        readFile: async () => {
          throw new Error('я'.repeat(30_000));
        },
      },
      symbols: { outline: async () => [] },
      stepBudget: { left: 24_000, tokensLeft: 6000 },
    } as unknown as ToolContext;
    const outcome = await runTool(ctx, 'lsp', JSON.stringify({ action: 'outline', path: '/project/a.ts' }));
    expect(outcome.ok).toBe(false);
    const result = failureText(outcome);
    expect(result).toMatch(/^Ошибка: /);
    expect(result).not.toContain('Ошибка: Ошибка:');
    // Бюджет шага задаётся в ЕДИНИЦАХ УЗКОЙ СТАВКИ — так его читает `outputRoom`.
    // Считаем ответ той же ставкой: `estimateTextTokens` на кириллице даёт вдвое больше,
    // и сверять с ним надо не сам потолок, а переведённый в широкую ставку.
    const narrowTokens = (text: string) =>
      Math.ceil((estimateTextTokens(text) * CHARS_PER_TOKEN_WIDE) / CHARS_PER_TOKEN);
    const wideCap = Math.ceil((MAX_OUTPUT_TOKENS * CHARS_PER_TOKEN) / CHARS_PER_TOKEN_WIDE);
    expect(narrowTokens(result)).toBeLessThanOrEqual(MAX_OUTPUT_TOKENS);
    expect(estimateTextTokens(result)).toBeLessThanOrEqual(wideCap);
    expect(ctx.stepBudget!.tokensLeft).toBe(6000 - narrowTokens(result));
  });

  it('общий сторож учитывает весь текст структурного ответа и общий бюджет токенов', async () => {
    const budget = { left: 24_000, tokensLeft: 6000 };
    const ctx = {
      workspace: { rootPath: () => '/project', readFile: async () => ({ text: 'code' }) },
      stepBudget: budget,
      symbols: {
        projectSymbols: async () => [],
        languageFor: () => 'typescript',
        outline: async () =>
          Array.from({ length: 500 }, (_, index) => ({
            name: `имя${index}_${'я'.repeat(40)}`,
            kind: 'функция',
            line: index + 1,
            endLine: index + 1,
            children: [],
          })),
      },
    } as unknown as ToolContext;
    const narrow = (text: string) => Math.ceil((estimateTextTokens(text) * CHARS_PER_TOKEN_WIDE) / CHARS_PER_TOKEN);
    const first = await runTool(ctx, 'lsp', JSON.stringify({ action: 'outline', path: '/project/a.ts' }));
    expect(first.ok).toBe(true);
    // Оба бюджета — в единицах узкой ставки, поэтому и считать надо так же (см. clipOutcome).
    expect(narrow(first.detail!)).toBeLessThanOrEqual(MAX_OUTPUT_TOKENS);
    expect(budget.tokensLeft).toBe(6000 - narrow(first.detail!));
    const second = await runTool(ctx, 'lsp', JSON.stringify({ action: 'outline', path: '/project/b.ts' }));
    expect(narrow(first.detail! + second.detail!)).toBeLessThanOrEqual(6000);
    expect(second.detail).toContain('вывод обрезан');
    expect(budget.left).toBe(24_000 - first.detail!.length - second.detail!.length);
  });
});
