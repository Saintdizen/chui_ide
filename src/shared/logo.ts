/**
 * Геометрия знака приложения — «[i_i]» в стиле моноширинного шрифта.
 *
 * Лежит в `shared`, потому что знак нужен в двух местах с разными движками:
 * в интерфейсе его собирает SVG (`renderer/ui/logo.ts`), а в значке окна —
 * растеризатор PNG (`scripts/make-icon.mjs`). Числа в обоих движках берутся
 * отсюда, поэтому интерфейс и ярлык не расходятся.
 *
 * Знак состоит ТОЛЬКО из прямоугольников: ни кривых, ни ломаных, ни стыков.
 * Так его одинаково просто нарисовать и в SVG, и по пикселям, без разницы
 * в сглаживании углов.
 *
 * Решётка — 25×16 единиц: пять знакомест по 5 ([, i, _, i, ]), базовая линия
 * y=13, высота строчной 5.5. Пропорции взяты у JetBrains Mono: ровный штрих
 * одной толщины, квадратная точка и засечки у «i», скобки во всю высоту клетки.
 */

export const LOGO_WIDTH = 25;
export const LOGO_HEIGHT = 16;

/** Толщина штриха: как у Regular JetBrains Mono в этом кегле. */
export const LOGO_STROKE = 1.5;
export const LOGO_BASELINE = 13;
const X_HEIGHT_TOP = 7.5;
/** Точка над «i» — квадрат со скруглением углов, как в шрифте. */
const DOT = 1.6;
const DOT_TOP = 5.4;
/** Скругление углов: у JetBrains Mono контуры мягкие, а не рубленые. */
const ROUNDING = 0.2;
const DOT_ROUNDING = 0.3;
/** Засечка: чуть шире стойки — иначе буква читается как простая палка. */
const SERIF_HALF = 1.15;
const SERIF = 0.8;

/** Центры знакомест: крайние — скобки, среднее — подчёркивание. */
const CENTER = { bracketLeft: 2.5, iLeft: 7.5, middle: 12.5, iRight: 17.5, bracketRight: 22.5 };

/** Пропорции квадратной скобки. */
const BRACKET = {
  /** Высота: скобка заметно выше строчной — так она и выглядит в шрифте. */
  top: 3.6,
  bottom: 14.2,
  /** Полная ширина скобки: стойка и два плеча. */
  width: 2.8,
};

export interface LogoRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Скругление углов. */
  rx?: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * Буква «i»: стойка, квадратная точка над ней, засечки у основания и слева
 * сверху — та самая деталь, по которой буква читается как моноширинная.
 */
function glyphI(centerX: number): readonly LogoRect[] {
  return [
    { x: centerX - LOGO_STROKE / 2, y: X_HEIGHT_TOP, width: LOGO_STROKE, height: LOGO_BASELINE - X_HEIGHT_TOP, rx: ROUNDING },
    { x: centerX - DOT / 2, y: DOT_TOP, width: DOT, height: DOT, rx: DOT_ROUNDING },
    { x: centerX - SERIF_HALF, y: LOGO_BASELINE - SERIF, width: SERIF_HALF * 2, height: SERIF, rx: ROUNDING },
    { x: centerX - SERIF_HALF, y: X_HEIGHT_TOP, width: SERIF_HALF, height: SERIF, rx: ROUNDING },
  ];
}

/**
 * Квадратная скобка: стойка и два плеча. `direction` = 1 для «[» (плечи
 * уходят вправо), −1 для «]». Стойка стоит со своей стороны знакоместа, поэтому
 * скобки обращены к тексту.
 */
function bracket(centerX: number, direction: 1 | -1): readonly LogoRect[] {
  // Стойка стоит с внешней стороны знакоместа, плечи уходят к тексту.
  const stem = direction === 1 ? centerX - BRACKET.width / 2 : centerX + BRACKET.width / 2 - LOGO_STROKE;
  const armX = direction === 1 ? stem : stem + LOGO_STROKE - BRACKET.width;

  return [
    { x: round(stem), y: BRACKET.top, width: LOGO_STROKE, height: BRACKET.bottom - BRACKET.top, rx: ROUNDING },
    { x: round(armX), y: BRACKET.top, width: BRACKET.width, height: LOGO_STROKE, rx: ROUNDING },
    { x: round(armX), y: BRACKET.bottom - LOGO_STROKE, width: BRACKET.width, height: LOGO_STROKE, rx: ROUNDING },
  ];
}

/** Прямоугольники знака: две буквы «i», подчёркивание и две скобки. */
export const LOGO_RECTS: readonly LogoRect[] = [
  ...glyphI(CENTER.iLeft),
  ...glyphI(CENTER.iRight),
  { x: CENTER.middle - 2.1, y: LOGO_BASELINE - 0.4, width: 4.2, height: 1.1, rx: ROUNDING },
  ...bracket(CENTER.bracketLeft, 1),
  ...bracket(CENTER.bracketRight, -1),
];
