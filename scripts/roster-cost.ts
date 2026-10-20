/**
 * Сколько стоит РОСТЕР — инструменты, которые идут строкой вместо схемы.
 *
 * Решение «вернуть схему из ростера» считается так: цена схемы против цены строки,
 * помноженная на число шагов прогона. Настоящая частота вызова берётся из телеметрии
 * (`~/.config/chui-ide/telemetry/runs.jsonl`, поле `steps[].calls[].name`).
 *
 * `trace` в журнале — итоговые числа (`steps`, `toolCalls`), а не список вызовов;
 * имена живут в `steps`. Старые записи без `steps` пропускаются молча.
 *
 * Запуск: npx tsx scripts/roster-cost.ts [telemetry.jsonl]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { estimateTextTokens } from '../src/shared/context-fit';
import { AGENT_TOOLS, toOpenAiTools } from '../src/shared/tools';
import { ROSTER_TOOLS, toolPresetAllows } from '../src/shared/tool-presets';

const specOf = (name: string) => AGENT_TOOLS.find((tool) => tool.name === name)!;
const schemaTokens = (name: string) => estimateTextTokens(JSON.stringify(toOpenAiTools([specOf(name)])));

const auto = AGENT_TOOLS.filter((spec) => toolPresetAllows('auto', spec.name));
const withSchemas = estimateTextTokens(JSON.stringify(toOpenAiTools(auto)));
const rosterLine = estimateTextTokens(ROSTER_TOOLS.join(', '));

console.log(`auto: схем ${auto.length} — ${withSchemas} токенов; ростер — ${ROSTER_TOOLS.length} имён в ${rosterLine} токенах`);
console.log('\nцена схемы каждого ростера:');
const costs = ROSTER_TOOLS.map((name) => ({ name, tokens: schemaTokens(name) })).sort((a, b) => b.tokens - a.tokens);
for (const row of costs) console.log(`  ${row.name.padEnd(14)} ${String(row.tokens).padStart(4)}`);

const file = process.argv[2] ?? join(homedir(), '.config/chui-ide/telemetry/runs.jsonl');
interface RunStep { calls?: { name?: string }[] }
interface RunRecord { mode: string; trace: { steps: number }; steps?: RunStep[] }
let runs: RunRecord[] = [];
try {
  runs = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
} catch {
  console.log(`\nтелеметрии нет (${file}) — частота вызовов неизвестна, решаем по цене схемы`);
  process.exit(0);
}

const agent = runs.filter((run) => run.mode === 'agent');
const steps = agent.reduce((sum, run) => sum + run.trace.steps, 0);
const perName = new Map<string, number>();
let calls = 0;
for (const run of agent) {
  // Имена — в `steps[].calls`; в `trace` только счётчики.
  for (const step of run.steps ?? []) {
    for (const call of step.calls ?? []) {
      const name = call.name;
      if (!name) continue;
      calls += 1;
      perName.set(name, (perName.get(name) ?? 0) + 1);
    }
  }
}

console.log(`\nпрогонов ${agent.length}, шагов ${steps}, вызовов ${calls} (${(calls / steps).toFixed(2)} на шаг)`);
console.log('\nростер: цена схемы против частоты вызова');
for (const row of costs) {
  const used = perName.get(row.name) ?? 0;
  const perSteps = used === 0 ? Infinity : steps / used;
  const payback = row.tokens > 0 ? (steps * row.tokens) / Math.max(used, 1) : 0;
  console.log(
    `  ${row.name.padEnd(14)} ${String(row.tokens).padStart(4)} т.  зван ${String(used).padStart(3)} раз` +
      `  → раз в ${perSteps === Infinity ? '∞' : Math.round(perSteps)} шагов` +
      `  (схема стоила бы ${payback.toFixed(0)} т. за прогон)`,
  );
}
