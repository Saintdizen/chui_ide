/**
 * Сводка журнала прогонов: беседа вместо ленты строк.
 *
 * Журнал писал по записи на прогон, но беседа — это несколько прогонов подряд.
 * Человек идёт с вопросом «что не получилось в этой беседе», а получал двадцать
 * строк, в которых надо складывать токены глазами. Здесь они сложены.
 *
 * Модуль чистый: ни DOM, ни RPC, ни времени. `at` берётся из записи, а не из
 * часов — иначе отчёт менялся бы от того, когда его открыли.
 */

import type { RunStepLog } from './run-log';
import type { RunTelemetryRecord } from './telemetry';

/** Одна проблема прогона: инструмент, причина и сколько раз повторилась. */
export interface RunFailure {
  /** Шаг, на котором случилось. `null` — запись укорочена, номера нет. */
  step: number | null;
  tool: string;
  why: string;
  count: number;
}

/** Сводка по одной беседе. */
export interface RunDigest {
  /** Беседа; `null` — записи без неё (старые или прогон вне чата). */
  conversation: string | null;
  runs: number;
  /** Последний прогон беседы: по нему сводки и упорядочены. */
  at: number;
  ms: number;
  steps: number;
  toolCalls: number;
  tokens: { prompt: number; completion: number; cached: number };
  /** Хотя бы один прогон сообщил расход. Иначе нули — не «ноль», а «неизвестно». */
  usageKnown: boolean;
  finished: { answer: number; limit: number; aborted: number };
  failures: RunFailure[];
  /** Хоть одна запись была укорочена: шаги могли не сохраниться целиком. */
  clipped: boolean;
}

function countFinished(record: RunTelemetryRecord, into: RunDigest['finished']): void {
  const key = record.finished;
  if (key === 'answer' || key === 'limit' || key === 'aborted') into[key] += 1;
}

/**
 * Проблемы шагов. Считаются и «не смог» (`ok: false`), и «сделал, но плохо»
 * (`failed`): упавшие тесты — ровно то, ради чего человек открывает журнал,
 * хотя формально вызов удался.
 */
function collectFailures(steps: readonly RunStepLog[]): RunFailure[] {
  const seen = new Map<string, RunFailure>();
  for (const step of steps) {
    for (const call of step.calls) {
      if (call.ok && !call.failed) continue;
      const why = call.summary?.trim() || (call.failed ? 'итог отрицательный' : 'вызов не удался');
      const key = `${call.name}\u0000${why}`;
      const found = seen.get(key);
      if (found) {
        found.count += 1;
        continue;
      }
      seen.set(key, { step: step.index, tool: call.name, why, count: 1 });
    }
  }
  return [...seen.values()];
}

/**
 * Сгруппировать записи по беседам: свежие сверху.
 *
 * Шаги и вызовы берутся из `trace`, а не пересчитываются по `steps`: запись
 * могла быть укорочена под потолок, и пересчёт показал бы 1 шаг вместо 30 —
 * то есть врал бы ровно там, где человеку нужна правда о длинном прогоне.
 */
export function digestRuns(records: readonly RunTelemetryRecord[]): RunDigest[] {
  const groups = new Map<string | null, RunDigest>();
  for (const record of records) {
    const key = record.conversation ?? null;
    let digest = groups.get(key);
    if (!digest) {
      digest = {
        conversation: key,
        runs: 0,
        at: record.at,
        ms: 0,
        steps: 0,
        toolCalls: 0,
        tokens: { prompt: 0, completion: 0, cached: 0 },
        usageKnown: false,
        finished: { answer: 0, limit: 0, aborted: 0 },
        failures: [],
        clipped: false,
      };
      groups.set(key, digest);
    }
    digest.runs += 1;
    digest.ms += record.ms;
    digest.steps += record.trace.steps;
    digest.toolCalls += record.trace.toolCalls;
    digest.at = Math.max(digest.at, record.at);
    const usage = record.trace.usage;
    if (usage.promptTokens !== undefined || usage.completionTokens !== undefined) {
      digest.usageKnown = true;
    }
    digest.tokens.prompt += usage.promptTokens ?? 0;
    digest.tokens.completion += usage.completionTokens ?? 0;
    digest.tokens.cached += usage.cachedTokens ?? 0;
    countFinished(record, digest.finished);
    digest.failures.push(...collectFailures(record.steps));
    if (record.clipped) digest.clipped = true;
  }
  // Одинаковые провалы из РАЗНЫХ прогонов складываются так же: беседу читают
  // целиком, и «не нашёл файл» в трёх прогонах — одна беда, а не три пункта.
  for (const digest of groups.values()) {
    const merged = new Map<string, RunFailure>();
    for (const failure of digest.failures) {
      const key = `${failure.tool}\u0000${failure.why}`;
      const found = merged.get(key);
      if (found) found.count += failure.count;
      else merged.set(key, { ...failure });
    }
    digest.failures = [...merged.values()];
  }
  return [...groups.values()].sort((a, b) => b.at - a.at);
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} ${few}`;
  return `${count} ${many}`;
}

/** Одна строка сводки: сколько прогонов, сколько ушло и что сломалось. */
export function digestLine(digest: RunDigest): string {
  const parts = [plural(digest.runs, 'прогон', 'прогона', 'прогонов')];
  if (digest.usageKnown) {
    parts.push(`токенов ${digest.tokens.prompt + digest.tokens.completion}`);
  }
  if (digest.steps > 0) parts.push(plural(digest.steps, 'шаг', 'шага', 'шагов'));
  const failures = digest.failures.reduce((sum, item) => sum + item.count, 0);
  if (failures > 0) parts.push(plural(failures, 'сбой', 'сбоя', 'сбоев'));
  return parts.join(' · ');
}
