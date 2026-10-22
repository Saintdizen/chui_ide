import { describe, expect, it } from 'vitest';
import { fitOutput, fitOutputLines } from '../src/shared/output-budget';
import { estimateTextTokens } from '../src/shared/context-fit';
import { failureText, MAX_OUTPUT_TOKENS, runTool, type ToolContext } from '../src/main/ai/agent-tools';

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
    expect(estimateTextTokens(result)).toBeLessThanOrEqual(MAX_OUTPUT_TOKENS);
    expect(ctx.stepBudget!.tokensLeft).toBe(6000 - estimateTextTokens(result));
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
    const first = await runTool(ctx, 'lsp', JSON.stringify({ action: 'outline', path: '/project/a.ts' }));
    expect(first.ok).toBe(true);
    expect(estimateTextTokens(first.detail!)).toBeLessThanOrEqual(MAX_OUTPUT_TOKENS);
    expect(budget.tokensLeft).toBe(6000 - estimateTextTokens(first.detail!));
    const second = await runTool(ctx, 'lsp', JSON.stringify({ action: 'outline', path: '/project/b.ts' }));
    expect(estimateTextTokens(first.detail! + second.detail!)).toBeLessThanOrEqual(6000);
    expect(second.detail).toContain('вывод обрезан');
    expect(budget.left).toBe(24_000 - first.detail!.length - second.detail!.length);
  });
});
