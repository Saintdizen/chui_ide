import { describe, expect, it } from 'vitest';
import { betaBaseUrl, isPeakTariff, pricingAt, wireEffort } from '../src/shared/providers';
import { usageCost } from '../src/shared/usage';
import { parseBalance, formatBalance } from '../src/shared/balance';

describe('wireEffort', () => {
  it('DeepSeek знает только low/high/max', () => {
    // Документация советует отображать промежуточные значения на ближайшее:
    // medium у DeepSeek — это high.
    expect(wireEffort('deepseek-flash', 'low')).toBe('low');
    expect(wireEffort('deepseek-flash', 'medium')).toBe('high');
    expect(wireEffort('deepseek-flash', 'high')).toBe('high');
    expect(wireEffort('deepseek-flash', 'max')).toBe('max');
  });

  it('off не отправляется никому', () => {
    expect(wireEffort('deepseek-flash', 'off')).toBeUndefined();
    expect(wireEffort('gpt-4o', 'off')).toBeUndefined();
    expect(wireEffort('gpt-4o', undefined)).toBeUndefined();
  });

  it('прочим моделям шкала уходит как есть', () => {
    expect(wireEffort('o3-mini', 'medium')).toBe('medium');
    expect(wireEffort('o3-mini', 'max')).toBe('max');
  });
});

describe('тариф по времени', () => {
  // Peak: пн–пт, 01–04 и 06–10 UTC. Вне их DeepSeek берёт вдвое меньше.
  const mondayPeak = new Date('2026-10-19T02:00:00Z');
  const mondayOff = new Date('2026-10-19T05:00:00Z');
  const saturday = new Date('2026-10-24T02:00:00Z');

  it('часы пик и непиковые часы', () => {
    expect(isPeakTariff('deepseek-flash', mondayPeak)).toBe(true);
    expect(isPeakTariff('deepseek-flash', mondayOff)).toBe(false);
    // Выходные — целиком непиковый тариф.
    expect(isPeakTariff('deepseek-flash', saturday)).toBe(false);
  });

  it('у других провайдеров времени суток нет', () => {
    expect(isPeakTariff('gpt-4o', mondayOff)).toBe(true);
  });

  it('цена в непиковые часы вдвое ниже', () => {
    const peak = pricingAt('deepseek-flash', mondayPeak);
    const off = pricingAt('deepseek-flash', mondayOff);
    expect(peak?.input).toBeCloseTo(0.3, 10);
    expect(off?.input).toBeCloseTo(0.15, 10);
    expect(off?.output).toBeCloseTo(0.6, 10);
    // Кеш-хит тоже дешевеет: он не выпадает из тарифа.
    expect(off?.cachedInput).toBeCloseTo(0.003, 10);
  });

  it('стоимость считается по времени прогона', () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 0 };
    expect(usageCost(usage, 'deepseek-flash', mondayPeak)).toBeCloseTo(0.3, 6);
    expect(usageCost(usage, 'deepseek-flash', mondayOff)).toBeCloseTo(0.15, 6);
    // Без явного времени берётся текущий момент — считать «всегда пик» было бы
    // другим числом, чем покажет счёт провайдера.
    expect(usageCost(usage, 'deepseek-flash')).toBeCloseTo(pricingAt('deepseek-flash', new Date())!.input, 6);
  });
});

describe('betaBaseUrl', () => {
  it('переписывает адрес DeepSeek на /beta', () => {
    // Строгая схема живёт только на /beta, и держать два адреса в настройках незачем.
    expect(betaBaseUrl('https://api.deepseek.com/v1', true)).toBe('https://api.deepseek.com/beta');
    expect(betaBaseUrl('https://api.deepseek.com', true)).toBe('https://api.deepseek.com/beta');
  });

  it('без strict и для чужих хостов адрес не трогаем', () => {
    expect(betaBaseUrl('https://api.deepseek.com/v1', false)).toBe('https://api.deepseek.com/v1');
    // Шлюз может знать свой /beta, а может и нет: не выдумываем за него путь.
    expect(betaBaseUrl('https://gateway.local/v1', true)).toBe('https://gateway.local/v1');
  });
});

describe('баланс', () => {
  const payload = {
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
    ],
  };

  it('разбирает ответ /user/balance', () => {
    const balance = parseBalance(payload);
    expect(balance).toMatchObject({ available: true });
    // Провайдер присылает суммы строками («110.00»), считаем числами.
    expect(balance?.items[0]).toMatchObject({ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 });
  });

  it('мусор и отсутствие счёта не ломают разбор', () => {
    expect(parseBalance(null)).toBeNull();
    expect(parseBalance({})).toBeNull();
    // Пустой список валют — не «0 USD», а «нечего показать».
    expect(parseBalance({ is_available: false, balance_infos: [] })).toBeNull();
  });

  it('человеческий текст не пустой', () => {
    expect(formatBalance(parseBalance(payload)!)).toContain('110');
  });
});
