#!/usr/bin/env node
/**
 * Где уходит время в прогоне тестов.
 *
 * Зачем: в CI разброс по Windows больше, чем любой выигрыш, за который мы
 * беремся (замер — в TASKS.md). Прежде чем «ускорять тесты», надо знать, что
 * именно гуляет: отдельный файл, отдельный тест или вся машина целиком. Один
 * прогон на этот вопрос не отвечает — нужны несколько подряд, и сравнивать их
 * пофайлово.
 *
 * Поэтому скрипт гоняет vitest с `--reporter=json` нужное число раз и
 * показывает по каждому файлу: время во всех прогонах, среднее и разброс.
 *
 * Запуск:
 *   node scripts/test-time-census.ts                  # 3 прогона, 25 самых долгих
 *   node scripts/test-time-census.ts --runs=5 --top=40 --out=.log/time.json
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface RunFileResult {
  name: string;
  status: string;
  startTime: number;
  endTime: number;
}

interface FileTiming {
  file: string;
  durations: number[];
  mean: number;
  /** Разброс: (макс - мин) — то, что делает прогон непредсказуемым. */
  spread: number;
  /** Разброс в процентах: абсолютные миллисекунды у файлов разного размера несравнимы. */
  spreadPct: number;
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const runs = Math.max(1, Number(arg('runs') ?? '3') || 3);
const top = Math.max(1, Number(arg('top') ?? '25') || 25);
const only = arg('only');
const out = arg('out');
const root = process.cwd();
const tmp = mkdtempSync(path.join(tmpdir(), 'test-time-'));

/**
 * Путь к vitest напрямую, без `npx`.
 *
 * Проверено на Windows-раннере 24.10: `spawnSync('npx', ...)` изнутри скрипта
 * не возвращает ни кода, ни вывода — шаг просто обрывается (9с и отказ, при
 * том что тот же `npx vitest run` обычной строкой `run:` проходит). Через
 * `node_modules/.bin` всё работает, а лишний процесс в каждом прогоне нам и не
 * нужен: замер — про время тестов, а не про скорость поиска бинарника.
 */
function vitestBin(): string {
  const base = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');
  return base;
}

function runOnce(index: number): Map<string, number> {
  const json = path.join(tmp, `run-${index}.json`);
  const args = ['run', '--reporter=json', `--outputFile=${json}`];
  if (only) args.push(only);

  process.stderr.write(`прогон ${index + 1}/${runs}… `);
  const started = Date.now();
  const result = spawnSync(vitestBin(), args, { cwd: root, stdio: 'ignore', shell: process.platform === 'win32' });
  const spent = Date.now() - started;
  // Падение тестов не мешает замеру: время у упавшего файла тоже есть.
  const note = result.status === 0 ? '' : ` (код ${result.status}${result.error ? `, ${result.error.message}` : ''})`;
  process.stderr.write(`${(spent / 1000).toFixed(1)}с${note}\n`);

  const parsed = JSON.parse(readFileSync(json, 'utf8')) as { testResults?: RunFileResult[] };
  const times = new Map<string, number>();
  for (const file of parsed.testResults ?? []) {
    times.set(path.relative(root, file.name), Math.round(file.endTime - file.startTime));
  }
  return times;
}

const samples = Array.from({ length: runs }, (_, i) => runOnce(i));
const files = new Set<string>();
for (const sample of samples) for (const file of sample.keys()) files.add(file);

const timings: FileTiming[] = [];
for (const file of files) {
  const durations = samples.map((sample) => sample.get(file) ?? 0);
  const mean = durations.reduce((sum, ms) => sum + ms, 0) / durations.length;
  const spread = Math.max(...durations) - Math.min(...durations);
  timings.push({ file, durations, mean, spread, spreadPct: mean > 0 ? (spread / mean) * 100 : 0 });
}

const totalMean = timings.reduce((sum, t) => sum + t.mean, 0);
const totals = samples.map((sample) => [...sample.values()].reduce((sum, ms) => sum + ms, 0));

console.log(`\nФайлов: ${timings.length}`);
console.log(`Сумма времени файлов по прогонам: ${totals.map((t) => `${t} мс`).join(' / ')}`);
const spreadTotal = Math.max(...totals) - Math.min(...totals);
console.log(`Средняя сумма: ${Math.round(totalMean)} мс, разброс суммы: ${spreadTotal} мс\n`);

console.log(`Самые долгие (${top}):`);
console.log('  среднее  разброс  разброс%  по прогонам                           файл');
for (const t of [...timings].sort((a, b) => b.mean - a.mean).slice(0, top)) {
  const per = t.durations.map((ms) => String(ms).padStart(5)).join(' ');
  const head = `${String(Math.round(t.mean)).padStart(7)}  ${String(t.spread).padStart(7)}  ${t.spreadPct.toFixed(0).padStart(6)}%`;
  console.log(`  ${head}  ${per}  ${t.file}`);
}

const noisy = [...timings].filter((t) => t.mean >= 200 && t.spreadPct >= 50).sort((a, b) => b.spread - a.spread);
console.log(`\nГуляют сильнее всего (от 200 мс, разброс от 50%): ${noisy.length}`);
for (const t of noisy.slice(0, top)) {
  console.log(`  ±${t.spread} мс (${t.spreadPct.toFixed(0)}%) при среднем ${Math.round(t.mean)} мс — ${t.file}`);
}

if (out) {
  const payload = { takenAt: new Date().toISOString(), platform: process.platform, runs, timings };
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nПодробно: ${out}`);
}
