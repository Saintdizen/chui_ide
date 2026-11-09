import { describe, expect, it } from 'vitest';
import { spendByDay, startOfDay } from '../src/shared/spend';
import type { RunTelemetryRecord } from '../src/shared/telemetry';

const DAY = 24 * 60 * 60 * 1000;
const day = (offset: number, hour = 12) => startOfDay(Date.now()) - offset * DAY + hour * 3600_000;

const record = (at: number, model = 'claude-sonnet-4-5', usage = { promptTokens: 1000, completionTokens: 500 }) =>
  ({ at, model, trace: { usage } }) as unknown as RunTelemetryRecord;

describe('spendByDay: расход по дням', () => {
  it('дни идут подряд, включая пустые', () => {
    const days = spendByDay([record(day(0)), record(day(3))], undefined, { days: 5 });
    expect(days).toHaveLength(5);
    // Пустой день — нули, а не отсутствие точки: иначе график врёт о ритме.
    expect(days.map((entry) => entry.runs)).toEqual([1, 0, 0, 1, 0].reverse());
  });

  it('записи за пределами окна не попадают в график', () => {
    const days = spendByDay([record(day(10))], undefined, { days: 3 });
    expect(days.every((entry) => entry.runs === 0)).toBe(true);
  });

  it('несколько прогонов одного дня складываются в одну точку', () => {
    const days = spendByDay([record(day(0, 9)), record(day(0, 18))], undefined, { days: 2 });
    const today = days[days.length - 1]!;
    expect(today.runs).toBe(2);
    expect(today.usage.promptTokens).toBe(2000);
  });

  it('известная модель даёт цену, а сумма дня считается', () => {
    const days = spendByDay([record(day(0))], undefined, { days: 1 });
    expect(days[0]!.cost).not.toBeNull();
    expect(days[0]!.cost!).toBeGreaterThan(0);
  });

  it('непосчитанный прогон делает цену дня null, а не заниженной суммой', () => {
    const unknown = record(day(0), 'модель-которой-нет', { promptTokens: 10, completionTokens: 0 });
    const days = spendByDay([record(day(0)), unknown], undefined, { days: 1 });
    // Частичная сумма дня на графике выглядела бы как дешёвый день.
    expect(days[0]!.cost).toBeNull();
  });

  it('окно меньше одного дня не бывает', () => {
    expect(spendByDay([], undefined, { days: 0 })).toHaveLength(1);
  });
});
