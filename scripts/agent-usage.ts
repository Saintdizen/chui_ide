/**
 * Замер по телеметрии прогонов: `~/.config/chui-ide/telemetry/counts.jsonl`.
 *
 * Один JSON на прогон: `trace` (шаги, prompt/cached/output) и `steps[].calls[]`
 * ({ name, ok, chars, flags }). Флаги ставит сам агент — `shell-read`, `cd`,
 * `whole-read`, `paths` — поэтому мерить их здесь можно без домыслов.
 *
 * Разница с `scripts/call-census.ts`: тот смотрит беседы (`chats/*.json`) и видит
 * аргументы (действия, отказы), а этот — только счётчики прогонов; зато только
 * он знает цену шага и долю кеша. «Меньше шагов» и «спустить порог whole-read»
 * проверяются этими числами, а не ощущением: лишний шаг ≈ 7к токенов, поэтому
 * файл целиком дешевле второго шага только пока ответ в них влезает (см. p90).
 *
 * Запуск: npx tsx scripts/agent-usage.ts [путь-к-counts.jsonl]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface Call {
  name: string;
  ok?: boolean;
  chars?: number;
  flags?: string[];
}

interface Run {
  trace?: { steps?: number; prompt?: number; cached?: number; output?: number };
  steps?: { calls?: Call[] }[];
}

const path = process.argv[2] ?? join(homedir(), '.config', 'chui-ide', 'telemetry', 'counts.jsonl');
const runs: Run[] = [];
for (const line of readFileSync(path, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    runs.push(JSON.parse(line) as Run);
  } catch {
    // Оборванная строка (прогон ещё идёт) — не повод падать.
  }
}

if (runs.length === 0) {
  console.log(`нет прогонов в ${path}`);
  process.exit(0);
}

const perName = new Map<string, { calls: number; fail: number; chars: number }>();
const perFlag = new Map<string, { calls: number; chars: number }>();
const wholeReads: number[] = [];
const rangeReads: number[] = [];
let steps = 0;
let prompt = 0;
let cached = 0;
let output = 0;

for (const run of runs) {
  steps += run.trace?.steps ?? 0;
  prompt += run.trace?.prompt ?? 0;
  cached += run.trace?.cached ?? 0;
  output += run.trace?.output ?? 0;
  for (const step of run.steps ?? []) {
    for (const call of step.calls ?? []) {
      const slot = perName.get(call.name) ?? { calls: 0, fail: 0, chars: 0 };
      slot.calls += 1;
      if (call.ok === false) slot.fail += 1;
      slot.chars += call.chars ?? 0;
      perName.set(call.name, slot);
      for (const flag of call.flags ?? []) {
        const at = perFlag.get(flag) ?? { calls: 0, chars: 0 };
        at.calls += 1;
        at.chars += call.chars ?? 0;
        perFlag.set(flag, at);
      }
      if (call.name === 'read' && (call.chars ?? 0) > 0) {
        (call.flags?.includes('whole-read') ? wholeReads : rangeReads).push(call.chars ?? 0);
      }
    }
  }
}

const share = (part: number, whole: number) => (whole === 0 ? '0 %' : `${Math.round((part / whole) * 100)} %`);
const sum = (values: number[]) => values.reduce((acc, value) => acc + value, 0);
const mean = (values: number[]) => (values.length === 0 ? 0 : sum(values) / values.length);
const quantile = (values: number[], at: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))] ?? 0;
};

console.log(`прогонов ${runs.length} в ${path}`);
console.log(
  `шагов ${steps} (${(steps / runs.length).toFixed(1)} на прогон), prompt на шаг ${Math.round(prompt / Math.max(steps, 1))}, ` +
    `кеш ${share(cached, prompt)}, вывод ${output}`,
);

const charsTotal = sum([...perName.values()].map((slot) => slot.chars));
console.log('\nимя            вызовов  ошибок  симв/вызов  доля вывода');
for (const [name, slot] of [...perName.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
  const perCall = Math.round(slot.chars / slot.calls)
    .toString()
    .padStart(10);
  console.log(
    `  ${name.padEnd(14)} ${String(slot.calls).padStart(5)}  ${share(slot.fail, slot.calls).padStart(6)}  ${perCall}  ${share(slot.chars, charsTotal).padStart(10)}`,
  );
}

if (perFlag.size > 0) {
  console.log('\nфлаги (флаг считает агент, не этот скрипт):');
  for (const [flag, slot] of [...perFlag.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
    console.log(
      `  ${flag.padEnd(12)} вызовов ${String(slot.calls).padStart(4)}, симв/вызов ${Math.round(slot.chars / slot.calls)}, всего ${share(slot.chars, charsTotal)} вывода`,
    );
  }
}

console.log('\nчтение: размер ответа в символах');
for (const [label, values] of [
  ['целиком ', wholeReads],
  ['диапазон', rangeReads],
] as [string, number[]][]) {
  console.log(
    `  ${label} ${String(values.length).padStart(4)} вызовов  средний ${Math.round(mean(values))}  медиана ${quantile(values, 0.5)}  p90 ${quantile(values, 0.9)}`,
  );
}
console.log('  лишний шаг ≈ 7к токенов: «целиком» дешевле, пока ответ влезает в них; выше p90 — уже вес.');
