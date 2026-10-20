import { describe, expect, it } from 'vitest';
import { agentPrompt } from '../src/shared/agent-prompt';
import { estimateTextTokens } from '../src/shared/context-fit';
import { AGENT_TOOLS, toOpenAiTools } from '../src/shared/tools';
import { TOOL_PRESETS, presetToolNames, type ToolPresetId } from '../src/shared/tool-presets';

/**
 * Бюджет схем инструментов — с отчётом, а не только с порогом.
 *
 * Схемы едут в КАЖДОМ запросе прогона, поэтому их вес — прямая цена шага. Сторож
 * держит три числа: отдельный инструмент не раздувается, описания аргументов не
 * возвращаются к «объясню подробнее», а наборы не толстеют незаметно. Суммы по
 * наборам считает `tool-presets.test.ts`; здесь — разбивка по инструментам, по
 * которой видно, куда уходит вес.
 */
function schemaTokens(spec: (typeof AGENT_TOOLS)[number]): number {
  return estimateTextTokens(JSON.stringify(toOpenAiTools([spec])));
}

function argumentDescriptionTokens(spec: (typeof AGENT_TOOLS)[number]): number {
  const parts: string[] = [];
  const walk = (properties: Record<string, { description?: string; items?: unknown; properties?: unknown }>): void => {
    for (const value of Object.values(properties)) {
      if (typeof value.description === 'string') parts.push(value.description);
      if (value.properties && typeof value.properties === 'object') walk(value.properties as never);
      if (value.items && typeof value.items === 'object') walk({ item: value.items as never });
    }
  };
  walk(spec.inputSchema.properties as never);
  return estimateTextTokens(parts.join(''));
}

const rows = AGENT_TOOLS.map((tool) => ({
  name: tool.name,
  tokens: schemaTokens(tool),
  args: argumentDescriptionTokens(tool),
})).sort((left, right) => right.tokens - left.tokens);

function presetTokens(preset: ToolPresetId): number {
  const allowed = presetToolNames(preset);
  const tools = allowed === null ? AGENT_TOOLS : AGENT_TOOLS.filter((tool) => allowed.has(tool.name));
  return estimateTextTokens(JSON.stringify(toOpenAiTools(tools)));
}

describe('бюджет схем', () => {
  it('ни один инструмент не дороже 500 токенов', () => {
    const heavy = rows.filter((row) => row.tokens > 500);
    expect(heavy).toEqual([]);
  });

  it('описания аргументов вместе влезают в 1 800 токенов', () => {
    const total = rows.reduce((sum, row) => sum + row.args, 0);
    expect(total).toBeLessThan(1_800);
  });

  it('набор по умолчанию дешевле полного хотя бы на пятую часть', () => {
    const full = presetTokens('full');
    const preset = TOOL_PRESETS[0]!;
    expect(presetTokens(preset.id)).toBeLessThan(full * 0.85);
  });

  it('отчёт: куда уходит вес схем', () => {
    console.log(
      rows.map((row) => `${row.name.padEnd(20)} ${String(row.tokens).padStart(5)} (аргументы ${row.args})`).join('\n'),
    );
    expect(rows.length).toBeGreaterThan(40);
  });

  it('отчёт: схемы и промпт по наборам', () => {
    const table = TOOL_PRESETS.map((preset) => {
      const ready = agentPrompt(preset.id, { confirm: true });
      return `${preset.id.padEnd(8)} схемы ${String(presetTokens(preset.id)).padStart(5)} + промпт ${String(
        estimateTextTokens(ready),
      ).padStart(4)} = ${presetTokens(preset.id) + estimateTextTokens(ready)}`;
    });
    console.log(table.join('\n'));
    // Промпт — текст, а не механика: он не должен весить больше части схем.
    for (const preset of TOOL_PRESETS) {
      expect(estimateTextTokens(agentPrompt(preset.id, { confirm: true }))).toBeLessThan(presetTokens(preset.id));
    }
  });
});
