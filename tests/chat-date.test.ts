import { describe, expect, it } from 'vitest';
import { formatChatDate } from '../src/shared/chat-date';

/**
 * Поиск по дате в беседах: строка даты — то, что видит и человек, и поиск.
 * Поэтому формат фиксированный, а не локальный: иначе «12.03» искалось бы
 * только на машинах с русской локалью.
 */
describe('formatChatDate', () => {
  it('пишет день, месяц, год и месяц словом', () => {
    expect(formatChatDate(new Date(2026, 2, 12, 10, 0).getTime())).toBe('12.03.2026 (март 2026)');
  });

  it('месяц словом в родительном падеже не нужен — ищем по основе', () => {
    expect(formatChatDate(new Date(2026, 8, 1).getTime())).toContain('сентябрь');
  });

  it('нет даты — пустая строка, а не «01.01.1970»', () => {
    expect(formatChatDate(0)).toBe('');
    expect(formatChatDate(Number.NaN)).toBe('');
  });
});
