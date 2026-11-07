import type { RunTelemetryRecord } from './telemetry';
import type { ChatUsage } from './api/ai';
import { addUsage, formatCost, usageCost } from './usage';

/**
 * Сводка расхода по журналу прогонов: «сколько за сегодня» и «на что ушло».
 *
 * Дни считаем местные, а не UTC: вопрос «сколько я потратил сегодня» человек
 * задаёт про свой день, а в UTC вечером уже следующий.
 *
 * Провайдер входит в ключ вместе с моделью: один и тот же `gpt-4o` у разных
 * посредников стоит по-разному, складывать их в одну строку — врать в цене.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SpendRow {
  provider: string;
  model: string;
  /** Сколько прогонов было — по нему видно, цена это за один или за день. */
  runs: number;
  usage: ChatUsage;
  /** Сумма денег. `null` — хотя бы у одного прогона модели нет в таблице цен. */
  cost: number | null;
}

export interface SpendSummary {
  /** Начало окна сводки (местная полночь), epoch мс. */
  since: number;
  runs: number;
  usage: ChatUsage;
  /** `null` — хоть один прогон не посчитан: частичная сумма врёт в меньшую. */
  cost: number | null;
  /** Строки по убыванию цены: дорогое — сверху, там, где смотрят. */
  rows: SpendRow[];
  /** Сколько прогонов не попало в деньги: их модели нет в таблице цен. */
  unpricedRuns: number;
}

/** Местная полночь дня, в который попадает момент. */
export function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Сводка за последние `days` дней, включая день, в который попадает `at`.
 *
 * Прогон без использования токенов всё равно считается прогоном: иначе после
 * сорванного запроса сводка делала бы вид, что его не было.
 */
export function summarizeSpend(
  records: readonly RunTelemetryRecord[],
  at: number = Date.now(),
  options: { days?: number } = {},
): SpendSummary {
  const days = Math.max(1, Math.floor(options.days ?? 1));
  const since = startOfDay(at) - (days - 1) * DAY_MS;
  const until = startOfDay(at) + DAY_MS;

  const byModel = new Map<string, SpendRow>();
  let usage: ChatUsage = {};
  let cost = 0;
  let priced = true;
  let runs = 0;
  let unpricedRuns = 0;

  for (const record of records) {
    if (record.at < since || record.at >= until) continue;
    runs += 1;
    const recordUsage = record.trace?.usage;
    usage = addUsage(usage, recordUsage);
    const money = usageCost(recordUsage, record.model, new Date(record.at));
    if (money === null) {
      priced = false;
      unpricedRuns += 1;
    } else {
      cost += money;
    }

    const key = `${record.provider}\u0000${record.model}`;
    const row = byModel.get(key) ?? {
      provider: record.provider,
      model: record.model,
      runs: 0,
      usage: {},
      cost: 0,
    };
    row.runs += 1;
    row.usage = addUsage(row.usage, recordUsage);
    row.cost = row.cost === null || money === null ? null : row.cost + money;
    byModel.set(key, row);
  }

  const rows = [...byModel.values()].sort(
    (left, right) => (right.cost ?? 0) - (left.cost ?? 0) || right.runs - left.runs,
  );
  return { since, runs, usage, cost: priced ? cost : null, rows, unpricedRuns };
}

/** Один день словами: «сегодня» / «вчера» / «3 ноября». */
export function describeDay(at: number, now: number = Date.now()): string {
  const diff = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'вчера';
  return new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

/** Строка сводки текстом: цена, объём и на что ушло больше всего. */
export function describeSpend(summary: SpendSummary): string {
  if (summary.runs === 0) return 'за это время прогонов не было';
  const money = summary.cost === null ? 'цена неизвестна' : `$${formatCost(summary.cost)}`;
  const tokens = summary.usage.promptTokens ?? 0;
  const out = summary.usage.completionTokens ?? 0;
  const head = `${money} за ${summary.runs} прогон(ов), вход ${tokens} / выход ${out}`;
  const top = summary.rows[0];
  if (!top) return head;
  const share = top.cost === null ? '' : `, больше всего — ${top.model}: $${formatCost(top.cost)}`;
  return `${head}${share}`;
}
