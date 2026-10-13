/**
 * Атрибуты знака: цвет и начертание — то, что задаёт SGR-последовательность
 * (`\x1b[1;31m`). Здесь только ПРАВИЛО разбора: чистая функция «атрибуты + коды →
 * новые атрибуты», без экрана и DOM. Поэтому оно проверяется тестами без окна.
 *
 * Цвет хранится не готовым CSS-значением, а РОЛЬЮ: «по умолчанию», «из палитры по
 * номеру» или «точный RGB». Так модель экрана не знает про тему — а нужный оттенок
 * подставит вид уже при отрисовке. Иначе смена темы требовала бы пересчёта кадра.
 */

/** Цвет ячейки: как в SGR — либо по умолчанию, либо номер палитры, либо точный RGB. */
export type Color =
  | { readonly kind: 'default' }
  | { readonly kind: 'palette'; readonly index: number }
  | { readonly kind: 'rgb'; readonly r: number; readonly g: number; readonly b: number };

/** Цвет по умолчанию — не «чёрный», а «как в теме»: его подставит вид. */
export const DEFAULT_COLOR: Color = { kind: 'default' };

/** Начертание и цвета знака. Все поля обязательные: так не бывает «атрибут без цвета». */
export interface Attr {
  readonly fg: Color;
  readonly bg: Color;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly blink: boolean;
  /** Обратные цвета: фон и текст меняются местами (SGR 7). */
  readonly inverse: boolean;
  /** Невидимый текст: знак есть, но не рисуется (SGR 8). */
  readonly invisible: boolean;
  readonly strike: boolean;
}

/** Атрибут по умолчанию: без цвета и начертаний — так выглядит чистый экран. */
export const DEFAULT_ATTR: Attr = {
  fg: DEFAULT_COLOR,
  bg: DEFAULT_COLOR,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  blink: false,
  inverse: false,
  invisible: false,
  strike: false,
};

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.floor(value)));
}

function palette(index: number): Color {
  return { kind: 'palette', index: clampByte(index) };
}

function withColor(attr: Attr, code: number, color: Color): Attr {
  return code === 38 ? { ...attr, fg: color } : { ...attr, bg: color };
}

/**
 * Расширенный цвет в виде подпараметров (`38:2:r:g:b`, `38:2::r:g:b`, `38:5:n`).
 * Формат с двоеточиями приходит одним параметром с вложенностью, поэтому разбирается
 * отдельно от формы через точку с запятой. Пустая позиция после `2` — это пропущенный
 * цветовой профиль (`::`): при ней RGB стоят на шаг дальше.
 */
function extendedFromSub(sub: readonly number[]): Color | null {
  const mode = sub[0];
  if (mode === 5) {
    if (sub.length < 2) return null;
    return palette(sub[1] ?? 0);
  }
  if (mode === 2) {
    const rgb = sub.length >= 5 ? sub.slice(2, 5) : sub.slice(1, 4);
    if (rgb.length < 3) return null;
    return { kind: 'rgb', r: clampByte(rgb[0] ?? 0), g: clampByte(rgb[1] ?? 0), b: clampByte(rgb[2] ?? 0) };
  }
  return null;
}

/**
 * Расширенный цвет в виде отдельных параметров (`38;5;n`, `38;2;r;g;b`). Значения
 * лежат в следующих группах, поэтому возвращаем и число групп, которые они заняли:
 * вызывающий сдвигает по ним счётчик.
 */
function extendedFromGroups(
  groups: readonly (readonly number[])[],
  index: number,
): { color: Color; skip: number } | null {
  const mode = groups[index + 1]?.[0];
  if (mode === 5) {
    const value = groups[index + 2]?.[0];
    if (value === undefined) return null;
    return { color: palette(value), skip: 2 };
  }
  if (mode === 2) {
    const r = groups[index + 2]?.[0];
    const g = groups[index + 3]?.[0];
    const b = groups[index + 4]?.[0];
    if (r === undefined || g === undefined || b === undefined) return null;
    return { color: { kind: 'rgb', r: clampByte(r), g: clampByte(g), b: clampByte(b) }, skip: 4 };
  }
  return null;
}

/** Базовые цвета SGR: обычные (30–37/40–47) и яркие (90–97/100–107). */
function basicColor(attr: Attr, code: number): Attr {
  if (code >= 30 && code <= 37) return { ...attr, fg: palette(code - 30) };
  if (code >= 40 && code <= 47) return { ...attr, bg: palette(code - 40) };
  if (code >= 90 && code <= 97) return { ...attr, fg: palette(code - 90 + 8) };
  if (code >= 100 && code <= 107) return { ...attr, bg: palette(code - 100 + 8) };
  return attr;
}

/**
 * Применить SGR-коды к атрибуту. Пустой список — это `\x1b[m`, то есть сброс.
 * Атрибут неизменяемый: возвращается новый объект, старый не портится — так ячейки,
 * уже нарисованные прежним атрибутом, не меняются задним числом.
 */
export function applySgr(attr: Attr, params: readonly (readonly number[])[]): Attr {
  const groups = params.length > 0 ? params : [[0]];
  let next = attr;

  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i] ?? [];
    const code = group[0] ?? 0;

    // Форма с двоеточиями: расширенный цвет уложен в один параметр.
    if (group.length > 1) {
      if (code === 38 || code === 48) {
        const color = extendedFromSub(group.slice(1));
        if (color) next = withColor(next, code, color);
      }
      continue;
    }

    if (code === 38 || code === 48) {
      const extended = extendedFromGroups(groups, i);
      if (extended) {
        next = withColor(next, code, extended.color);
        i += extended.skip;
      }
      continue;
    }

    switch (code) {
      case 0:
        next = DEFAULT_ATTR;
        break;
      case 1:
        next = { ...next, bold: true };
        break;
      case 2:
        next = { ...next, dim: true };
        break;
      case 3:
        next = { ...next, italic: true };
        break;
      // 4 — подчёркивание, 21 — двойное: отдельного поля под «двойное» нет, рисуем как обычное.
      case 4:
      case 21:
        next = { ...next, underline: true };
        break;
      case 5:
      case 6:
        next = { ...next, blink: true };
        break;
      case 7:
        next = { ...next, inverse: true };
        break;
      case 8:
        next = { ...next, invisible: true };
        break;
      case 9:
        next = { ...next, strike: true };
        break;
      case 22:
        next = { ...next, bold: false, dim: false };
        break;
      case 23:
        next = { ...next, italic: false };
        break;
      case 24:
        next = { ...next, underline: false };
        break;
      case 25:
        next = { ...next, blink: false };
        break;
      case 27:
        next = { ...next, inverse: false };
        break;
      case 28:
        next = { ...next, invisible: false };
        break;
      case 29:
        next = { ...next, strike: false };
        break;
      case 39:
        next = { ...next, fg: DEFAULT_COLOR };
        break;
      case 49:
        next = { ...next, bg: DEFAULT_COLOR };
        break;
      default:
        next = basicColor(next, code);
    }
  }

  return next;
}
