/**
 * Размер шрифта редактора: ступени и шаг.
 *
 * Кегль редактора — это `editor.fontSize`, и менять его можно тремя путями: полем в
 * настройках, `Ctrl+колесо` над текстом и `Ctrl+=` / `Ctrl+-`. Все три обязаны давать
 * одно и то же, поэтому правила (границы и шаг) живут здесь, одной чистой функцией,
 * а не в каждом месте по-своему.
 *
 * Редактор этим не масштабируется «от оболочки»: у оболочки свой множитель
 * (`shared/ui-scale.ts`), у текста — свой кегль в пикселях.
 */

/** Ниже — буквы сливаются, выше — строка не помещается даже на широком экране. */
export const EDITOR_FONT_MIN = 6;
export const EDITOR_FONT_MAX = 72;

/** Шаг ступени: кегль меняют на пиксель за нажатие, как в VS Code. */
export const EDITOR_FONT_STEP = 1;

/**
 * Следующая ступень кегля: `direction` — +1 крупнее, -1 мельче.
 *
 * За границей значение не меняется вовсе: иначе `Ctrl+=` на максимуме молча
 * переписывал бы настройку ради «того же самого», а тост врал бы о смене.
 * Мусор и `undefined` считаются текущими по умолчанию — 14.
 */
export function stepEditorFontSize(current: number, direction: -1 | 1): number {
  const base = sanitizeEditorFontSize(current);
  const next = Math.min(Math.max(base + direction * EDITOR_FONT_STEP, EDITOR_FONT_MIN), EDITOR_FONT_MAX);
  return next;
}

/** Привести кегль к допустимому: дробное округляется, мусор — к 14. */
export function sanitizeEditorFontSize(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 14;
  return Math.min(Math.max(Math.round(numeric), EDITOR_FONT_MIN), EDITOR_FONT_MAX);
}

/** Есть ли куда расти или уменьшаться — чтобы не показывать тост о смене, которой нет. */
export function canStepEditorFontSize(current: number, direction: -1 | 1): boolean {
  return stepEditorFontSize(current, direction) !== sanitizeEditorFontSize(current);
}

/** Подпись кегля для тоста: 16 → «Шрифт редактора: 16 px». */
export function editorFontSizeLabel(size: number): string {
  return `Шрифт редактора: ${sanitizeEditorFontSize(size)} px`;
}
