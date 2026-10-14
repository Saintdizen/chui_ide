/**
 * Плавная прокрутка: положение прокрутки на шаге анимации.
 *
 * Прокрутка едет не скачком, а коротким разгоном: глаз успевает понять, куда
 * «уехал» текст (курсор ушёл на 800 строк вниз — иначе строка просто оказывается
 * другой, а что произошло, видно только по номеру в статус-баре).
 *
 * Модуль чистый: времени и кадров он не знает — их подаёт вид (там `requestAnimationFrame`).
 * Так кривую и границы можно проверить без окна (`tests/smooth-scroll.test.ts`).
 */

/** Длительность разгона. Дольше — уже не «плавно», а «вязко» на быстром наборе. */
export const SMOOTH_SCROLL_MS = 120;

/**
 * Разгон мягкий в конце: `ease-out`. В начале прокрутка идёт быстро (дальний прыжок
 * должен случиться сразу), а к цели подходит медленно — так остановка читается.
 */
export function easeOutCubic(progress: number): number {
  const t = Math.min(Math.max(progress, 0), 1);
  return 1 - (1 - t) ** 3;
}

/** Пора ли закончить анимацию. */
export function scrollFinished(elapsedMs: number, durationMs: number = SMOOTH_SCROLL_MS): boolean {
  return elapsedMs >= durationMs || durationMs <= 0;
}

/**
 * Положение прокрутки через `elapsedMs` после начала. Конец всегда равен цели —
 * поэтому последний кадр не «почти доехал», а встаёт ровно.
 */
export function scrollStep(from: number, to: number, elapsedMs: number, durationMs: number = SMOOTH_SCROLL_MS): number {
  if (scrollFinished(elapsedMs, durationMs)) return to;
  return from + (to - from) * easeOutCubic(elapsedMs / durationMs);
}
