/**
 * Куда поставить всплывающий слой у якоря.
 *
 * Отдельно от DOM намеренно: позиция попапа — это правило, а не рисование, и
 * ошибиться в нём легко и незаметно (попап уезжает за край окна). Здесь — чистая
 * математика, которую видно в тестах.
 */

export interface Rect {
  top: number;
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
}): Placement {
  const { anchor, size, viewport, gap } = options;
  const margin = options.margin ?? 8;

  // По горизонтали прижимаем к правому краю якоря, но не даём вылезти за окно.
  const left = Math.max(margin, Math.min(anchor.right - size.width, viewport.width - size.width - margin));

  const above = anchor.top - size.height - gap;
  const below = anchor.bottom + gap;
  const preferred = above >= margin ? above : below;

  // Прижатие к границам: снизу — чтобы не уехал за нижний край, сверху — за верхний.
  const top = Math.max(margin, Math.min(preferred, viewport.height - size.height - margin));

  return { left, top };
}
