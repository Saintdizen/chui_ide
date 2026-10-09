/**
 * Куда поставить всплывающий слой у якоря.
 *
 * Отдельно от DOM намеренно: позиция попапа — это правило, а не рисование, и
 * ошибиться в нём легко и незаметно (попап уезжает за край окна). Здесь — чистая
 * математика, которую видно в тестах.
 */

export interface Rect {
  top: number;
  // Левый край якоря: нужен попапам с прижатием к началу (start).
  left: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
}

/**
 * Позиция попапа в координатах окна.
 *
 * Обычный случай — над якорем: попапы открывают из нижних панелей (статусбар),
 * и вверх места больше. Если над якорем не влезает, кладём под ним. В любом
 * случае прижимаем к границам окна: попап, вылезший за край, бесполезен —
 * его содержимое просто не видно.
 */
export function placePopup(options: {
  /** Якорь в координатах окна (как `getBoundingClientRect`). */
  anchor: Rect;
  /** Размер попапа: он известен до показа, если содержимое уже отрисовано. */
  size: Size;
  viewport: Size;
  /** Зазор между якорем и попапом. */
  gap: number;
  /** Отступ от краёв окна. */
  margin?: number;
  /**
   * К чему прижимать по горизонтали. `end` — попап растёт влево от правого края
   * якоря (панели у правого края окна). `start` — вправо от левого края якоря:
   * так попап остаётся внутри своей панели, а не уезжает за левый край окна.
   */
  align?: 'start' | 'end';
}): Placement {
  const { anchor, size, viewport, gap } = options;
  const margin = options.margin ?? 8;
  const align = options.align ?? 'end';

  // По горизонтали прижимаем к нужному краю якоря, но не даём вылезти за окно.
  const preferredLeft = align === 'start' ? anchor.left : anchor.right - size.width;
  const left = Math.max(margin, Math.min(preferredLeft, viewport.width - size.width - margin));

  const above = anchor.top - size.height - gap;
  const below = anchor.bottom + gap;
  const preferred = above >= margin ? above : below;

  // Прижатие к границам: снизу — чтобы не уехал за нижний край, сверху — за верхний.
  const top = Math.max(margin, Math.min(preferred, viewport.height - size.height - margin));

  return { left, top };
}
