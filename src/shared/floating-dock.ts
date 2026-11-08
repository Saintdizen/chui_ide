/**
 * Где стоит плавающая панель и какого она размера.
 *
 * Не в CSS и не в DOM: положение окна меняется перетаскиванием с шагом в
 * пиксель, и держать его надо так, чтобы можно было проверить без браузера.
 */
export interface FloatingRect {
  /** Левый край от левого края окна. */
  left: number;
  /** Верхний край от верха окна. */
  top: number;
  width: number;
  height: number;
}

export const FLOATING_MIN_WIDTH = 320;
/** Ниже этого панель не помещает даже строку терминала. */
export const FLOATING_MIN_HEIGHT = 160;
/** Зазор от края окна: окно, прижатое к краю, не отличить от разделителя. */
export const FLOATING_MARGIN = 8;
export const DEFAULT_FLOATING: FloatingRect = { left: 80, top: 80, width: 620, height: 320 };

/**
 * Загнать прямоугольник внутрь окна и не дать ему стать меньше рабочего.
 *
 * Потеряться окно может легко: перетащили почти за край — и заголовка нет,
 * тащить больше не за что. Поэтому верхний край ограничен отдельно: за
 * верхним краем окна он не бывает, иначе окно уехало бы целиком.
 */
export function clampFloating(rect: FloatingRect, viewport: { width: number; height: number }): FloatingRect {
  const width = Math.max(FLOATING_MIN_WIDTH, Math.min(rect.width, Math.max(FLOATING_MIN_WIDTH, viewport.width - FLOATING_MARGIN * 2)));
  const height = Math.max(FLOATING_MIN_HEIGHT, Math.min(rect.height, Math.max(FLOATING_MIN_HEIGHT, viewport.height - FLOATING_MARGIN * 2)));
  const maxLeft = Math.max(FLOATING_MARGIN, viewport.width - width - FLOATING_MARGIN);
  const maxTop = Math.max(FLOATING_MARGIN, viewport.height - height - FLOATING_MARGIN);
  return {
    left: Math.min(Math.max(rect.left, FLOATING_MARGIN), maxLeft),
    top: Math.min(Math.max(rect.top, FLOATING_MARGIN), maxTop),
    width,
    height,
  };
}

/**
 * Перетаскивание за заголовок: новый прямоугольник по смещению курсора.
 *
 * Ограничиваем ЗДЕСЬ же, а не только на отпускании: иначе окно на ходу
 * уезжает под край и возвращается рывком — видно лишнее движение.
 */
export function dragFloating(
  start: FloatingRect,
  delta: { dx: number; dy: number },
  viewport: { width: number; height: number },
): FloatingRect {
  return clampFloating({ ...start, left: start.left + delta.dx, top: start.top + delta.dy }, viewport);
}

/**
 * Изменение размера за угол: тянем правый-нижний угол.
 *
 * Левый-верхний остаётся на месте: "потянул угол — панель выросла вправо-
 * вниз" — единственное поведение, которое не заставляет переучиваться.
 */
export function resizeFloating(
  start: FloatingRect,
  delta: { dx: number; dy: number },
  viewport: { width: number; height: number },
): FloatingRect {
  return clampFloating({ ...start, width: start.width + delta.dx, height: start.height + delta.dy }, viewport);
}

/**
 * Центр по умолчанию: окно, вставшее в угол, перекрывает то, на что смотрят.
 * Чуть выше центра — привычнее: под ним остаётся строка состояния.
 */
export function centeredFloating(viewport: { width: number; height: number }): FloatingRect {
  const width = Math.min(DEFAULT_FLOATING.width, Math.max(FLOATING_MIN_WIDTH, viewport.width - FLOATING_MARGIN * 2));
  const height = Math.min(DEFAULT_FLOATING.height, Math.max(FLOATING_MIN_HEIGHT, viewport.height - FLOATING_MARGIN * 2));
  return clampFloating(
    {
      left: Math.round((viewport.width - width) / 2),
      top: Math.round((viewport.height - height) / 2),
      width,
      height,
    },
    viewport,
  );
}
