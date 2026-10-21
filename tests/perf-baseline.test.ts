import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePerfBaseline, perfRegressions } from '../src/shared/perf';

/**
 * Сравнение замеров с базой — не в CI, а на своей машине.
 *
 * Абсолютные миллисекунды в CI плавают от загрузки раннера: такой сторож ловил
 * бы машину, а не сползание кода. Поэтому порядок ручной и короткий:
 *
 *   CHUI_PERF=1 npm start          # или открыть с ?perf=1
 *   __chuiPerf() в DevTools        # JSON → perf-last.json в корень проекта
 *   npm test -- perf-baseline      # сравнение с perf-baseline.json
 *
 * Нет одного из файлов — тест пропускается: требовать замеры от каждого прогона
 * значит получить зелёный сторож, который ничего не сторожит.
 */

const root = process.cwd();
const read = (name: string): string | null => {
  const file = path.join(root, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
};

const baselineText = read('perf-baseline.json');
const lastText = read('perf-last.json');

const baseline = baselineText ? parsePerfBaseline(baselineText) : null;
const last = lastText ? parsePerfBaseline(lastText) : null;

describe.skipIf(!baseline || !last)('база производительности', () => {
  it('снимок читается тем же разбором, что и база', () => {
    expect(last?.version).toBe(1);
    expect(last?.spans.length).toBeGreaterThan(0);
  });

  it('ни одна фаза не сползла сверх запаса', () => {
    const found = perfRegressions(
      (last?.spans ?? []).map(({ phase, ms }) => ({ phase, ms })),
      baseline,
    );
    const report = found
      .map((row) => `${row.phase}: ${Math.round(row.ms)} мс при базе ${row.baseMs} (порог ${Math.round(row.limitMs)})`)
      .join('\n');
    expect(report, `Сползло против базы:\n${report}`).toBe('');
  });
});
