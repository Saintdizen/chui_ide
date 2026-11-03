/**
 * Типизированный поиск по дереву (APG `type-ahead`).
 *
 * Набираешь буквы — выделение прыгает на первую строку, начинающуюся с них.
 * Отдельным модулем, потому что главное здесь — не DOM, а СБРОС буфера по
 * времени: без него буквы, набранные в разное время, склеиваются в одно слово
 * и уводят не туда.
 */

/** Сколько помнить набранное, если пауза. */
export const TYPEAHEAD_RESET_MS = 800;

export interface TypeaheadState {
  /** Набранное с последнего сброса. */
  readonly buffer: string;
  /** Когда была последняя буква (мс). */
  readonly at: number;
}

export const EMPTY_TYPEAHEAD: TypeaheadState = { buffer: '', at: 0 };

/**
 * Новая буква — и новое состояние.
 *
 * Сброс по паузе, а не по «слову набрано»: человек, ищущий «index.ts»,
 * набирает его с провалами, и склеивать «in» и «dex» из разных мыслей нельзя.
 * Повтор одной и той же буквы подряд — тоже новое слово (так в VS Code:
 * «ss» ведёт к следующему «s…», а не ищет «ss»).
 */
export function typeaheadPress(state: TypeaheadState, char: string, now: number): TypeaheadState {
  const expired = now - state.at > TYPEAHEAD_RESET_MS;
  const repeated = state.buffer.length > 0 && state.buffer === char.repeat(state.buffer.length);
  const buffer = expired || repeated ? char : state.buffer + char;
  return { buffer, at: now };
}

/**
 * Куда прыгнуть: первая СТРОКА ПОСЛЕ текущей, чьё имя начинается с набранного.
 *
 * «После текущей, а не с начала» — так договор APG: тот же префикс повторно
 * ведёт к следующему совпадению, иначе повторное «нажатие тех же букв» стояло
 * бы на месте. Проход по кругу — обязательно: до последнего совпадения так же
 * дойдёшь, не отпуская клавиши.
 *
 * Ищется по ИМЕНИ, а не по полному пути: набравшие «a.ts» не хотят прыгать в
 * `src/app/a.ts` вместо `a.ts` из-за того, что путь начинается с `src`.
 */
export function typeaheadTarget(
  rows: readonly { readonly path: string; readonly name: string }[],
  current: string | null,
  buffer: string,
): string | null {
  if (buffer.length === 0 || rows.length === 0) return null;
  const needle = buffer.toLowerCase();
  const start = current === null ? -1 : rows.findIndex((row) => row.path === current);
  // Смотрим все строки, начиная со следующей за текущей, и заворачиваем на начало.
  for (let step = 1; step <= rows.length; step += 1) {
    const index = (start + step) % rows.length;
    const row = rows[index]!;
    if (row.name.toLowerCase().startsWith(needle)) return row.path;
  }
  return null;
}
