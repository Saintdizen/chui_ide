/**
 * Перепись дублей внутри одного шага агента.
 *
 * «Дульные» здесь не про старые имена — их уже свёл `tool-aliases.ts`. Считаем то,
 * что свёртывание показать не может:
 *  - один и тот же вызов (имя + аргументы) в одном шаге;
 *  - соседние инструменты с пересекающейся работой: `search(action=code)` и
 *    `lsp(definition)` возвращают одно и то же объявление, `run_tests` и
 *    `terminal(action=run, command: 'pytest')` оба гоняют тесты.
 *
 * Это только замер: сами правила лежат в `src/shared/call-overlaps.ts`, а решать,
 * что из этих пар подавлять, должен `ai/service.ts` на живом замере — разные пары
 * бывают оправданы контекстом.
 *
 * Запуск: npx tsx scripts/duplicate-census.ts [каталог-бесед]
 */
import { callOverlaps, overlapExample, repeatedCallIndexes, type CallOverlapKind } from '../src/shared/call-overlaps';
import { censusHeader, loadCensus } from './census-data';

const sample = loadCensus();
console.log(censusHeader(sample));

let steps = 0;
let calls = 0;
let repeats = 0;
let overlaps = 0;
const overlapByKind = new Map<CallOverlapKind, number>();
const repeatByName = new Map<string, number>();
const overlapExamples: string[] = [];

for (const messages of sample.messages) {
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
    steps += 1;
    const callsInStep = message.toolCalls.map((call) => ({
      name: call.name ?? '',
      arguments: call.arguments ?? '',
    }));
    calls += callsInStep.length;

    for (const index of repeatedCallIndexes(callsInStep)) {
      repeats += 1;
      const name = callsInStep[index]?.name ?? '';
      repeatByName.set(name, (repeatByName.get(name) ?? 0) + 1);
    }

    for (const overlap of callOverlaps(callsInStep)) {
      overlaps += 1;
      overlapByKind.set(overlap.kind, (overlapByKind.get(overlap.kind) ?? 0) + 1);
      if (overlapExamples.length < 15) overlapExamples.push(overlapExample(callsInStep, overlap));
    }
  }
}

console.log(`\nШагов с вызовами ${steps}, вызовов ${calls}: повторов в шаге ${repeats}, пересечений ${overlaps}.`);
if (repeatByName.size > 0) {
  console.log('\nповторы одного вызова внутри шага:');
  for (const [name, count] of [...repeatByName.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name.padEnd(14)} ${count}`);
  }
}
if (overlapByKind.size > 0) {
  console.log('\nпересечения инструментов:');
  for (const [kind, count] of [...overlapByKind.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(18)} ${count}`);
  }
}
if (overlapExamples.length > 0) {
  console.log('\nпримеры пересечений:');
  for (const example of overlapExamples) console.log(`  ${example}`);
}
