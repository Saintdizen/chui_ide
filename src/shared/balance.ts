/**
 * Состояние счёта у провайдера — ответ `GET /user/balance`.
 *
 * Деньги у каждого провайдера свои, и без этой цифры человек узнаёт об
 * исчерпанном балансе по ошибке 402 посреди работы агента. У локальных серверов
 * баланса нет вовсе, поэтому «нет данных» здесь — нормальный ответ, а не ошибка.
 */
export interface BalanceItem {
  /** Валюта как её называет провайдер: `USD`, `CNY`. */
  currency: string;
  /** Всего доступно. */
  total: number;
  /** Из них подарочных. */
  granted?: number;
  /** Из них пополненных. */
  toppedUp?: number;
}

export interface AccountBalance {
  /** Можно ли тратить: `false` — счёт исчерпан, запросы не пройдут. */
  available: boolean;
  items: readonly BalanceItem[];
}

function money(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/** Разбор ответа `/user/balance`; неизвестная форма даёт `null`, а не нули. */
export function parseBalance(payload: unknown): AccountBalance | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const raw = Array.isArray(record.balance_infos)
    ? record.balance_infos
    : Array.isArray(record.data)
      ? record.data
      : [];

  const items: BalanceItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const currency = typeof item.currency === 'string' ? item.currency : '';
    const total = money(item.total_balance);
    if (!currency || total === undefined) continue;
    items.push({
      currency,
      total,
      granted: money(item.granted_balance),
      toppedUp: money(item.topped_up_balance),
    });
  }

  // Без списка валют ответ бессмысленен: показывать «0 USD» из пустоты нельзя.
  if (items.length === 0) return null;
  return { available: record.is_available !== false, items };
}

/** Баланс человеческим текстом: «12.34 USD»; пустой список — «нет данных». */
export function formatBalance(balance: AccountBalance | null): string {
  if (!balance || balance.items.length === 0) return 'счёт: нет данных';
  const parts = balance.items.map((item) => `${item.total.toFixed(2)} ${item.currency}`);
  return `счёт: ${parts.join(', ')}${balance.available ? '' : ' · исчерпан'}`;
}
