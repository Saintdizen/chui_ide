/**
 * Режим показа невидимых знаков. Живёт в `shared`, потому что его называют обе
 * стороны: настройки (`main/settings.ts`) хранят его, а представление редактора
 * (`renderer/editor/view/whitespace.ts`) по нему рисует. Показ знаков «где рисовать»
 * считает представление — здесь только тип и приведение значения из файла настроек.
 */

/** Что показывать из невидимых знаков. */
export type WhitespaceMode =
  /** Ничего: пробелы и табуляции не видны (поведение по умолчанию). */
  | 'none'
  /** Только хвостовые — те, что не должны пережить сохранение. */
  | 'trailing'
  /** Все пробелы и табуляции. */
  | 'all';

/** Известные режимы: по ним проверяется значение из настроек. */
export const WHITESPACE_MODES: readonly WhitespaceMode[] = ['none', 'trailing', 'all'];

/** Привести значение из настроек/файла к известному режиму; неизвестное — `none`. */
export function normalizeWhitespaceMode(value: unknown): WhitespaceMode {
  return typeof value === 'string' && (WHITESPACE_MODES as readonly string[]).includes(value)
    ? (value as WhitespaceMode)
    : 'none';
}
