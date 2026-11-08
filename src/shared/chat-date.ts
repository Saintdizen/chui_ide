/**
 * Дата беседы для поиска.
 *
 * Своё форматирование, а не `toLocaleDateString`: строка нужна не человеку как
 * украшение, а поиску — по ней ищут «12.03», «2026-03» и «март». Локаль меняла
 * бы написание от машины к машине, и поиск ломался бы то там, то тут.
 */
const MONTHS = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

/** `12.03.2026 (март 2026)` — по такой строке ищут и число, и месяц, и год. */
export function formatChatDate(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  const date = new Date(at);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}.${month}.${year} (${MONTHS[date.getMonth()]} ${year})`;
}
