/**
 * Заглянуть в определение (peek): какое окно строк показать и как ходить по местам.
 *
 * Переход к определению уводит из файла: чтобы вернуться, надо помнить, откуда ушёл.
 * «Заглянуть» показывает определение НА МЕСТЕ — небольшой копией кода, без ухода.
 * Для этого нужны две вещи, и обе — чистые:
 *
 *   • окно строк вокруг нужной. Показывать файл целиком незачем, а показывать одну
 *     строку — бесполезно: смысл определения виден по окружению (сигнатура, тело).
 *     Окно берёт несколько строк ДО и столько же после, всегда держа нужную внутри
 *     и заполняя себя до предела — у нижнего края файла окно не должно «укорачиваться»;
 *   • ход по местам, когда определение не одно (перегрузки, реализации). Указатель
 *     не заворачивается: у первого и последнего места конец виден по выключенной
 *     стрелке — «круговорот» сбивал бы с толку.
 *
 * Модуль ничего не знает ни о окне, ни о языковом сервере: только числа. Поэтому его
 * видно в тестах, а показ окна и запрос мест живут отдельно (`widgets/peek-widget.ts`,
 * `host/peek-controller.ts`).
 */

/** Сколько строк показываем ДО нужной, чтобы был виден контекст. */
export const PEEK_CONTEXT_LINES = 3;

/** Предел высоты копии: больше строк — это уже не «заглянуть», а открыть файл. */
export const PEEK_MAX_LINES = 26;

/** Окно строк файла: границы включительно, номера строк с единицы. */
export interface PeekWindow {
  readonly first: number;
  readonly last: number;
}

/**
 * Окно строк вокруг нужной. Число строк в окне всегда `maxLines` (если в файле их
 * хватает): у нижнего края начало подтягивается вверх, у верхнего — конец вниз.
 * Нужная строка гарантированно внутри.
 */
export function peekWindow(
  lineCount: number,
  targetLine: number,
  options: { context?: number; maxLines?: number } = {},
): PeekWindow {
  const context = Math.max(0, options.context ?? PEEK_CONTEXT_LINES);
  const maxLines = Math.max(1, options.maxLines ?? PEEK_MAX_LINES);
  const count = Math.max(1, lineCount);
  const target = Math.min(Math.max(1, targetLine), count);

  let first = Math.max(1, target - context);
  const last = Math.min(count, first + maxLines - 1);
  // Окно упёрлось в низ файла и вышло короче — подтягиваем начало вверх.
  first = Math.max(1, last - maxLines + 1);
  return { first, last };
}

/** Указатель на место, приведённый к диапазону списка. Пустой список даёт 0. */
export function clampPeekIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(0, Math.round(index)), total - 1);
}

/** Сдвинуть указатель на место. По краям останавливаемся — конца списка видно. */
export function peekStepIndex(index: number, delta: number, total: number): number {
  return clampPeekIndex(clampPeekIndex(index, total) + delta, total);
}

/** Есть ли куда шагнуть в эту сторону. `false` — стрелка выключена. */
export function peekCanStep(index: number, delta: number, total: number): boolean {
  return peekStepIndex(index, delta, total) !== clampPeekIndex(index, total);
}

/** Подпись счётчика мест: `2 из 5`. Одно место — подписывать нечего, пусто. */
export function peekCounter(index: number, total: number): string {
  if (total <= 1) return '';
  return `${clampPeekIndex(index, total) + 1} из ${total}`;
}
