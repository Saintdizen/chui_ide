/**
 * Время одного вызова инструмента — так, как его читает человек.
 *
 * Число нужно, чтобы отличать «прочитал файл» от «собрал проект»: в карточке
 * инструмента видно имя и аргументы, но не видно, куда ушла минута. Дробные
 * секунды ниже секунды не показываем — на глаз это уже шум.
 */
export function formatCallTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const rounded = Math.round(ms);
  if (rounded < 1000) return `${rounded} мс`;
  if (rounded < 60_000) return `${(rounded / 1000).toFixed(1)} с`;
  const minutes = Math.floor(rounded / 60_000);
  const seconds = Math.round((rounded % 60_000) / 1000);
  // Округление может дать 60 с — тогда это уже следующая минута.
  if (seconds === 60) return `${minutes + 1} мин`;
  return seconds > 0 ? `${minutes} мин ${seconds} с` : `${minutes} мин`;
}
