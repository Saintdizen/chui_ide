/**
 * Масштаб интерфейса: один множитель на всю оболочку.
 *
 * В `theme.css` уже есть ступени `--font_scale` и `--density`, от которых считаются
 * все кегли и размеры элементов. Здесь — только их значение из настроек: на больших
 * экранах (или при плохом зрении) оболочку делают крупнее, на маленьких — плотнее.
 * Редактор этим не масштабируется: у него свой кегль (`editor.fontSize`).
 *
 * Функция чистая: значение приходит из файла настроек, поэтому его нужно ограничить.
 */

/** Ниже — элементы оболочки перестают помещаться по ширине, выше — теряют смысл. */
export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.4;

/** Шаг ступеней: масштаб выбирают из готовых значений, а не вводят дробью. */
export const UI_SCALE_STEP = 0.1;

/**
 * Привести масштаб к допустимому. `undefined`, мусор и выход за границы дают
 * ближайшее разумное значение; по умолчанию — 1 (как есть).
 */
export function sanitizeUiScale(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  // Округляем до шага: так значение из настроек совпадает с выбранной ступенью.
  const stepped = Math.round(numeric / UI_SCALE_STEP) * UI_SCALE_STEP;
  return Math.min(Math.max(Number(stepped.toFixed(2)), UI_SCALE_MIN), UI_SCALE_MAX);
}

/** Подписи ступеней масштаба для списка выбора: 0.8 → «80 %». */
export function uiScaleOptions(): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [];
  for (let scale = UI_SCALE_MIN; scale <= UI_SCALE_MAX + 1e-9; scale += UI_SCALE_STEP) {
    const rounded = Number(scale.toFixed(2));
    options.push({ value: String(rounded), label: `${Math.round(rounded * 100)} %` });
  }
  return options;
}
