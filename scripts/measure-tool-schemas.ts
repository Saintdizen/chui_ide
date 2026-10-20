/**
 * Замер схем инструментов: сколько токенов несёт каждый набор в каждом запросе.
 *
 * Разовый инструмент для работы над ценой схемы — в сборку не входит. Запуск:
 *   npx tsx scripts/measure-tool-schemas.ts
 */
import { estimateTextTokens } from '../src/shared/context-fit';
import { AGENT_TOOLS, toOpenAiTools } from '../src/shared/tools';
import { TOOL_PRESETS, toolPresetAllows, type ToolPresetId } from '../src/shared/tool-presets';

function toolsForPreset(preset: ToolPresetId) {
  return AGENT_TOOLS.filter((spec) => toolPresetAllows(preset, spec.name));
}

const rows: { name: string; tools: number; tokens: number }[] = [];

for (const preset of TOOL_PRESETS) {
  const specs = toolsForPreset(preset.id);
  const text = JSON.stringify(toOpenAiTools(specs));
  rows.push({ name: preset.id, tools: specs.length, tokens: estimateTextTokens(text) });
}

rows.sort((a, b) => a.tokens - b.tokens);
for (const row of rows) {
  console.log(`${row.name.padEnd(12)} ${String(row.tools).padStart(3)}  ${row.tokens}`);
}

// Поимённо — чтобы правка была направленной, а не на глаз.
const auto = toolsForPreset('auto');
const per = auto.map((spec) => ({
  name: spec.name,
  tokens: estimateTextTokens(JSON.stringify(toOpenAiTools([spec]))),
}));
per.sort((a, b) => b.tokens - a.tokens);
console.log('\nauto, по инструментам:');
for (const row of per) console.log(`${row.name.padEnd(14)} ${row.tokens}`);
