/**
 * Во что обходится единый чанк renderer — цифры для решения «делить или нет».
 *
 * Меряем не догадку, а две вещи, которые видно без запуска окна:
 *  - сколько V8 тратит на разбор и компиляцию собранного чанка (это ровно то,
 *    что платит старт до первого кадра, и ровно то, что снимается ленивым
 *    куском);
 *  - сколько весит чанк по диску и в gzip. В Electron файл читается локально,
 *    поэтому сеть тут ни при чём: важен только разбор.
 *
 * Разбор меряется `vm.SourceTextModule` — тот же V8, что в renderer. Модуль не
 * исполняется и не связывается, только разбирается и компилируется: иначе в
 * счёте оказалась бы работа самого приложения.
 *
 * Запуск: `NODE_OPTIONS=--experimental-vm-modules npx tsx scripts/chunk-cost.ts`
 * (после `npm run build:renderer`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as vm from 'node:vm';

const dir = 'dist/renderer/assets';
const file = readdirSync(dir).find((name) => /^index-.*\.js$/.test(name));
if (!file) {
  console.log(`сборки нет: ${dir}/index-*.js. Сначала npm run build:renderer`);
  process.exit(0);
}

const code = readFileSync(join(dir, file), 'utf8');
const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} КБ`;

const { SourceTextModule } = vm as unknown as {
  SourceTextModule?: new (source: string, options?: { identifier?: string }) => unknown;
};

/** Один разбор: разогрев не в счёт, первый прогон тянет ещё и ленивую компиляцию. */
const parseOnce = (): number => {
  if (!SourceTextModule) return Number.NaN;
  const started = performance.now();
  new SourceTextModule(code, { identifier: file });
  return performance.now() - started;
};

parseOnce();
const cold = parseOnce();
const warm = parseOnce();

console.log(`${file}: ${kb(code.length)} по диску, ${kb(gzipSync(code).length)} в gzip`);
if (Number.isNaN(cold)) {
  console.log('время разбора не снято: нужен NODE_OPTIONS=--experimental-vm-modules');
} else {
  console.log(`разбор и компиляция: ${cold.toFixed(1)} мс (повтор ${warm.toFixed(1)} мс)`);
}

// Что даст ленивый кусок: разбор идёт по объёму, поэтому берём цену килобайта.
const perKb = warm / (code.length / 1024);
console.log(`  темп: ${perKb.toFixed(3)} мс на КБ`);
for (const [what, size] of [
  ['модалка настроек', 107],
  ['все модалки вместе', 216],
  ['весь `app.ts`', 163],
] as const) {
  console.log(`  ${what} (${size} КБ): ${(perKb * size).toFixed(1)} мс разбора`);
}
console.log('решение и замер записаны в vite.config.mts, п. 38 TASKS.md');
