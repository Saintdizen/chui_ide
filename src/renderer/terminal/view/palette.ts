/**
 * Палитра консоли для своего терминала и перевод цвета ячейки в значение CSS.
 *
 * Модель экрана хранит цвет РОЛЬЮ (`attrs.ts`): «по умолчанию», «по номеру палитры»
 * или «точный RGB». Здесь роль превращается в значение для отрисовки. Правило чистое
 * (цвет → строка), поэтому проверяется тестами без окна.
 *
 * Шестнадцать базовых цветов отдаём ссылкой на переменную (`var(--own-term-cN)`):
 * их задаёт тема при смене схемы, и разметке не нужно перевыпускаться. Остальные 240
 * номеров и RGB — точные значения (их немного и они одинаковы в обеих схемах).
 */

import type { Color } from '../core/attrs';

/** Палитра консоли: шестнадцать цветов ANSI и служебные цвета полотна. */
export interface TerminalPalette {
  /** Цвета 0–15 в порядке ANSI: обычные, затем яркие. */
  readonly ansi: readonly string[];
  readonly background: string;
  readonly foreground: string;
  readonly cursor: string;
  readonly selection: string;
  /** Подсветка совпадений поиска: обычных и текущего. */
  readonly search: string;
  readonly searchCurrent: string;
}

/** Уровни серого куба 6×6×6 у 256-цветной палитры: 0, 95, 135, 175, 215, 255. */
function cubeLevel(value: number): number {
  return value === 0 ? 0 : 55 + value * 40;
}

function hex(r: number, g: number, b: number): string {
  const part = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * Цвет по номеру 256-цветной палитры (числа 16–255). Первые шестнадцать сюда не
 * приходят: их отдаёт тема переменными, чтобы смена схемы перекрашивала консоль.
 * 16–231 — куб 6×6×6, 232–255 — серая шкала от чёрного к белому.
 */
export function color256(index: number): string {
  if (index < 16) return rgbFallback[index] ?? '#000000';
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return hex(level, level, level);
  }
  const value = index - 16;
  return hex(cubeLevel(Math.floor(value / 36)), cubeLevel(Math.floor(value / 6) % 6), cubeLevel(value % 6));
}

/** Запасной набор 0–15: нужен только на случай, если номер спросят в отрыве от темы. */
const rgbFallback = [
  '#000000',
  '#cd3131',
  '#0dbc79',
  '#e5e510',
  '#2472c8',
  '#bc3fbc',
  '#11a8cd',
  '#e5e5e5',
  '#666666',
  '#f14c4c',
  '#23d18b',
  '#f5f543',
  '#3b8eea',
  '#d670d6',
  '#29b8db',
  '#e5e5e5',
];

/**
 * Значение CSS для цвета ячейки. `null` — цвет по умолчанию: его берут из корня
 * (`color`/`background` представления), чтобы не задавать его заново на каждой ячейке.
 * Базовые 16 цветов — ссылкой на переменную темы, остальное — точным значением.
 */
export function colorToCss(color: Color): string | null {
  switch (color.kind) {
    case 'default':
      return null;
    case 'palette':
      return color.index < 16 ? `var(--own-term-c${color.index})` : color256(color.index);
    case 'rgb':
      return hex(color.r, color.g, color.b);
  }
}
