/**
 * Вид каретки и высота строки — то, как выглядит место, где человек печатает.
 *
 * Настройки приходят и из формы, и из файла, который правят руками, поэтому значения
 * проверяются здесь, а не на месте использования. Список видов и подписи тоже живут
 * тут: по ним строится выбор в окне настроек, и один список на всех — это меньше
 * поводов разойтись. Модуль чистый: закреплён тестом (`tests/cursor-style.test.ts`).
 */

/** Как рисовать каретку: полоской, блоком или подчёркиванием. */
export const CURSOR_STYLES = ['line', 'block', 'underline'] as const;

export type CursorStyle = (typeof CURSOR_STYLES)[number];

/** Подписи видов для окна настроек. */
export const CURSOR_STYLE_LABELS: Record<CursorStyle, string> = {
  line: 'Полоска',
  block: 'Блок',
  underline: 'Подчёркивание',
};

/** Похоже ли значение на вид каретки. */
export function isCursorStyle(value: unknown): value is CursorStyle {
  return typeof value === 'string' && (CURSOR_STYLES as readonly string[]).includes(value);
}

/** Привести вид каретки к известному: непонятное значение — полоска. */
export function normalizeCursorStyle(value: unknown): CursorStyle {
  return isCursorStyle(value) ? value : 'line';
}

/** Предел высоты строки: выше строки-великаны делают текст нечитаемым. */
export const MAX_LINE_HEIGHT = 64;

/**
 * Привести высоту строки к целому числу пикселей. `0` — «по шрифту» (авто): редактор
 * сам считает её от кегля. Значение вне разумного прижимается к границе.
 */
export function normalizeLineHeight(value: unknown): number {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(number, MAX_LINE_HEIGHT);
}
