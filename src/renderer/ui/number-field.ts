export type FieldNumber = { ok: true; value: number } | { ok: false; hint: string };

/**
 * Разобрать число из поля настройки: мусор — не ноль. `Number('')` — это 0, а
 * браузер отдаёт пустую строку и для пустого поля, и для «12abc», и именно поэтому
 * неправильное значение раньше молча становилось минимумом настройки.
 *
 * Отдельно от поля — чтобы правило было в одном месте и проверялось без DOM.
 */
export function parseFieldNumber(raw: string, min: number, max: number): FieldNumber {
  const text = raw.trim().replace(',', '.');
  if (text === '') return { ok: false, hint: 'Ожидалось число' };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, hint: 'Ожидалось число' };
  if (value < min || value > max) return { ok: false, hint: `Ожидалось число от ${min} до ${max}` };
  return { ok: true, value };
}
