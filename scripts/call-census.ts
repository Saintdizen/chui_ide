/**
 * Перепись вызовов инструментов — по файлам бесед, а не по телеметрии.
 *
 * `runs.jsonl` на этой машине не создаётся, а настоящие вызовы лежат в
 * `~/.config/chui-ide/chats/*.json`: `conversations[].messages[]`, у ассистента
 * `toolCalls[{ name, arguments }]`, результат — следующая реплика `role: 'tool'`
 * с тем же `toolCallId`.
 *
 * Что считаем и зачем:
 *  - вызовы по имени и по паре (имя, `action`) — частота решает, везти инструмент
 *    схемой (74–427 ток. на шаг) или строкой ростера (~9 ток.);
 *  - значение `action`, которого нет в схеме, — промах вызова: имя в ростере без
 *    перечня значений экономит токены ровно до первого такого промаха;
 *  - повтор тем же инструментом сразу после ошибки — «лишний шаг переделки»,
 *    та же цена, только видная в шагах, а не в токенах.
 *
 * Беседа — не выборка: в ней только те задачи, что человек реально ставил. Малые
 * числа (10–20 вызовов на имя) — повод прочитать пару случаев руками, а не верить
 * процентам.
 *
 * Запуск: npx tsx scripts/call-census.ts [каталог-бесед]
 *
 * Не путать с `scripts/measure-terminal-usage.py`: тот считает, КАК зовут
 * `terminal` (cd/pipe/read — для З1), а этот — ЧТО вообще зовут и с какими
 * аргументами (для решения по схемам и ростру).
 */
import { censusHeader, isFailure, loadCensus, retryNames } from './census-data';
import { estimateTextTokens } from '../src/shared/context-fit';
import { AGENT_TOOLS, toOpenAiTools } from '../src/shared/tools';
import { ROSTER_TOOLS, WIDENED_TOOLS } from '../src/shared/tool-presets';

const sample = loadCensus();
console.log(censusHeader(sample));

const specOf = (name: string) => AGENT_TOOLS.find((tool) => tool.name === name);
const schemaTokens = (name: string): number => {
  const spec = specOf(name);
  return spec ? estimateTextTokens(JSON.stringify(toOpenAiTools([spec]))) : 0;
};
const enumOf = (name: string, field: string): string[] => {
  const schema = specOf(name)?.inputSchema as { properties?: Record<string, { enum?: string[] }> } | undefined;
  const values = schema?.properties?.[field]?.enum;
  return Array.isArray(values) ? values : [];
};

const perName = new Map<string, number>();
const perAction = new Map<string, number>();
const badAction = new Map<string, number>();
const failures = new Map<string, number>();
const retries = new Map<string, number>();
let steps = 0;
let calls = 0;
const chats = sample.chats.length;
const examples: string[] = [];

for (const messages of sample.messages) {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
    steps += 1;
    for (const call of message.toolCalls) {
      const rawName = call.name;
      if (!rawName) continue;
      // Старое имя — не ошибка модели, а след прошлого промпта: считаем по
      // каноническому, иначе `file` выглядит незванным рядом с `create_file`.
      const name = rawName;
      calls += 1;
      perName.set(name, (perName.get(name) ?? 0) + 1);

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments ?? '') as Record<string, unknown>;
      } catch {
        // Аргументы не разобрались — это уже промах формы, считаем как есть.
      }
      const action = typeof args.action === 'string' ? args.action : '(нет)';
      perAction.set(`${name}.${action}`, (perAction.get(`${name}.${action}`) ?? 0) + 1);

      const allowed = enumOf(name, 'action');
      if (allowed.length > 0 && action !== '(нет)' && !allowed.includes(action)) {
        badAction.set(name, (badAction.get(name) ?? 0) + 1);
        if (examples.length < 12) examples.push(`${name}(action: ${action})`);
      }

      // Результат — ближайшая реплика `tool` с тем же `toolCallId`.
      const result = messages
        .slice(index + 1)
        .find((candidate) => candidate.role === 'tool' && candidate.toolCallId === call.id);
      if (result && isFailure(result)) {
        failures.set(name, (failures.get(name) ?? 0) + 1);
      }
    }

    for (const name of retryNames(messages, index)) retries.set(name, (retries.get(name) ?? 0) + 1);
  }
}

const share = (part: number, whole: number) => (whole === 0 ? '0 %' : `${Math.round((part / whole) * 100)} %`);
const rows = [...perName.entries()].sort((a, b) => b[1] - a[1]);

console.log(
  `бесед ${chats}, шагов-ассистента ${steps}, вызовов ${calls} (${(calls / Math.max(steps, 1)).toFixed(2)} на шаг)\n`,
);
console.log('имя            вызовов  доля  схема/ростер  ошибок  переделок');
for (const [name, used] of rows) {
  const tokens = schemaTokens(name);
  const where = ROSTER_TOOLS.includes(name) ? 'ростер' : WIDENED_TOOLS.includes(name) ? 'докачка' : 'схема';
  const fails = failures.get(name) ?? 0;
  const again = retries.get(name) ?? 0;
  console.log(
    `  ${name.padEnd(14)} ${String(used).padStart(4)}  ${share(used, calls).padStart(5)}  ${String(tokens).padStart(4)} ${where.padEnd(7)}  ${String(fails).padStart(4)} ${share(fails, used).padStart(5)}  ${String(again).padStart(4)} ${share(again, used).padStart(5)}`,
  );
}

console.log('\nдействия по именам из «докачки» (имя без перечня `action` в ростере):');
for (const name of WIDENED_TOOLS) {
  const used = perName.get(name) ?? 0;
  const actions = rows.length === 0 ? [] : [...perAction.entries()].filter(([key]) => key.startsWith(`${name}.`));
  const allowed = enumOf(name, 'action');
  const bad = badAction.get(name) ?? 0;
  console.log(
    `  ${name}: зван ${used} раз, значений вне схемы ${bad} (${share(bad, used)}), схема ${allowed.length ? allowed.join('|') : '—'}`,
  );
  if (used > 0) {
    for (const [key, count] of actions.sort((a, b) => b[1] - a[1])) {
      console.log(`      ${key.slice(name.length + 1).padEnd(12)} ${count}`);
    }
  }
}

if (examples.length > 0) {
  console.log('\nпримеры значений вне схемы:');
  for (const line of examples) console.log(`  ${line}`);
}

const planned = ['file', 'history', 'mcp', 'show'];
console.log('\nрешение по спорным (цена схемы против частоты):');
for (const name of planned) {
  const used = perName.get(name) ?? 0;
  const tokens = schemaTokens(name);
  const perStep = used === 0 ? '∞' : `${(steps / used).toFixed(1)} шагов`;
  console.log(
    `  ${name.padEnd(14)} ${String(tokens).padStart(4)} т.  зван ${String(used).padStart(4)}  (раз в ${perStep})  ` +
      `разница схемы и строки ростера ≈ ${Math.round((tokens - 9) * steps)} входных т. без учёта кеша`,
  );
}
