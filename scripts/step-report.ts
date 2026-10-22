#!/usr/bin/env -S npx tsx
/**
 * Отчёт по счётчику шагов (`counts.jsonl`, см. `src/shared/step-counts.ts`).
 *
 * Зачем отдельно от `scripts/output-census.ts`. Перепись по `chats/*.json` видит
 * только итоги прогона: сколько шагов и сколько токенов всего. Внутри шага там
 * пусто — поэтому нельзя ответить ни «сколько стоил отказ», ни «сколько стоил
 * повторный read», и любая правка инструментов проверялась на глаз. Счётчик шагов
 * пишется всегда и без текстов переписки: имена инструментов, числа, пометки.
 *
 * Запуск: `npx tsx scripts/step-report.ts [путь к counts.jsonl]`
 * По умолчанию — `~/.config/chui-ide/telemetry/counts.jsonl`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseCounts } from '../src/shared/step-counts';

/** Символов на токен — грубая оценка: точного токенайзера у нас нет. */
const CHARS_PER_TOKEN = 4;

const file = process.argv[2] ?? path.join(homedir(), '.config/chui-ide/telemetry/counts.jsonl');
const text = existsSync(file) ? readFileSync(file, 'utf8') : '';

if (!text) {
  console.log(`Нет журнала: ${file}`);
  console.log('Он появляется сам после первого прогона агента (настройка не нужна).');
  process.exit(0);
}

const runs = parseCounts(text);
const steps = runs.flatMap((run) => run.steps);
const calls = steps.flatMap((step) => step.calls);

if (calls.length === 0) {
  console.log(`В журнале ${runs.length} прогонов, но ни одного вызова: ${file}`);
  process.exit(0);
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

const outTokens = sum(calls.map((call) => call.chars)) / CHARS_PER_TOKEN;
console.log(`Журнал: ${file}`);
console.log(`Прогонов ${runs.length}, шагов ${steps.length}, вызовов ${calls.length}`);
console.log(
  `Попутно: ${runs[0] ? new Date(runs[0].at).toISOString().slice(0, 16) : '—'} … ${runs.at(-1) ? new Date(runs.at(-1)!.at).toISOString().slice(0, 16) : '—'}`,
);

// Отказы: цена шага. «ok: false» — вызов ответил ошибкой или аргумент не сошёлся.
const failed = calls.filter((call) => !call.ok);
console.log('');
console.log(`Отказы: ${failed.length} из ${calls.length} (${Math.round((failed.length / calls.length) * 100)}%)`);
const byName = top(failed.map((call) => call.name));
for (const [name, count] of byName) {
  const reasons = top(failed.filter((call) => call.name === name).map((call) => call.reason ?? '—'));
  const detail = reasons.map(([reason, n]) => `${reason} ×${n}`).join(', ');
  console.log(`  ${name.padEnd(12)} ${String(count).padStart(4)}   ${detail}`);
}

// Вывод по инструментам: это и есть цена инструмента, а не его схема.
console.log('');
console.log(`Вывод: ${Math.round(outTokens)} ток. (${sum(calls.map((c) => c.chars))} симв.)`);
// В трассе каждый результат обрезан `MAX_RUN_FIELD`, поэтому у больших чтений цена
// недосчитана: доли инструментов верны, абсолютные токены — нижняя граница.
console.log('  (результаты в трассе обрезаны 4 000 симв.: цена больших чтений — нижняя граница)');
const byTool = new Map<string, { count: number; chars: number; max: number }>();
for (const call of calls) {
  const entry = byTool.get(call.name) ?? { count: 0, chars: 0, max: 0 };
  entry.count += 1;
  entry.chars += call.chars;
  entry.max = Math.max(entry.max, call.chars);
  byTool.set(call.name, entry);
}
const tools = [...byTool.entries()].sort((a, b) => b[1].chars - a[1].chars);
for (const [name, entry] of tools) {
  const share = Math.round((entry.chars / sum(calls.map((c) => c.chars))) * 100);
  const avg = Math.round(entry.chars / entry.count);
  console.log(
    `  ${name.padEnd(12)} ${String(entry.count).padStart(4)} выз. ${String(Math.round(entry.chars / CHARS_PER_TOKEN)).padStart(7)} ток. ` +
      `сред ${String(Math.round(avg / CHARS_PER_TOKEN)).padStart(5)} макс ${String(Math.round(entry.max / CHARS_PER_TOKEN)).padStart(5)}  ${share}%`,
  );
}

// Пометки вызовов — то, ради чего этот журнал и нужен: доля `cd`, чтения через шелл,
// целых чтений и пачек. По ним видно, работает ли правка инструментов.
const flagged = new Map<string, number>();
for (const call of calls) {
  for (const flag of call.flags ?? []) flagged.set(flag, (flagged.get(flag) ?? 0) + 1);
}
if (flagged.size > 0) {
  console.log('');
  console.log('Пометки вызовов:');
  for (const [flag, count] of [...flagged.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(
      `  ${flag.padEnd(12)} ${String(count).padStart(4)}  (${Math.round((count / calls.length) * 100)}% вызовов)`,
    );
  }
}

// Пересечения инструментов в одном шаге: модель могла попросить то же самое дважды.
const overlaps = steps.flatMap((step) => step.overlaps ?? []);
if (overlaps.length > 0) {
  console.log('');
  console.log(`Пересечения инструментов в одном шаге: ${overlaps.length}`);
  const byKind = top(overlaps.map((item) => item.kind));
  for (const [kind, count] of byKind) {
    console.log(`  ${kind.padEnd(16)} ${count}`);
  }
}

// Шаг: цена и кеш. Кеш префикса — единственная причина, по которой постоянная часть
// (схемы + промпт + ростер) стоит не столько, сколько весит.
const stepOut = steps.map((step) => step.out ?? 0);
const prompt = sum(steps.map((step) => step.usage?.prompt ?? 0));
const cached = sum(steps.map((step) => step.usage?.cached ?? 0));
const cacheCreation = sum(steps.map((step) => step.usage?.cacheCreation ?? 0));
console.log('');
console.log(
  `Шаг: вывод медиана ${median(stepOut)} ток., 90% ${percentile(stepOut, 0.9)} ток., макс ${Math.max(0, ...stepOut)} ток.`,
);
if (prompt > 0) {
  console.log(
    `Кеш: ${Math.round((cached / prompt) * 100)}% префикса из кеша (${cached} из ${prompt} ток. входа, ${steps.length} шагов)`,
  );
}
if (cacheCreation > 0) {
  console.log(`Часть входа, записанная в кеш: ${cacheCreation} ток. из ${prompt} ток.`);
}

function top(values: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}
