/**
 * Пометки, накрывающие позицию — по ним карточка наведения показывает ТЕКСТ ошибки.
 *
 * Волна под словом сама ничего не объясняет: человек видит подчёркивание и не знает,
 * что не так. Текст берётся из пометок языка (`publishDiagnostics`), и найти нужную —
 * это сравнить позицию курсора с участком пометки. Участок задан строкой и столбцами,
 * оба с единицы, конец исключающий — как их видит редактор.
 *
 * Строка обязана совпасть точно: пометка принадлежит одной строке (многострочные мы
 * подчёркиваем до конца первой строки, см. `buildSquiggles`). Столбец — внутри участка;
 * вырожденный участок (`end` равен началу) накрывает хотя бы свой знак, иначе пометка
 * нулевой длины не показалась бы никогда.
 *
 * Модуль чистый: числа и список на входе. Поэтому он проверяется тестами без окна.
 */

import type { LspDiagnostic } from '../../../shared/api';

/** Позиция в документе: строка и столбец, оба с единицы. */
export interface ProblemPosition {
  readonly line: number;
  readonly column: number;
}

/** Пометки, накрывающие позицию. Пусто — объяснять нечего. */
export function problemsAt(markers: readonly LspDiagnostic[], position: ProblemPosition): readonly LspDiagnostic[] {
  if (markers.length === 0) return [];
  return markers.filter(
    (item) =>
      item.line === position.line &&
      position.column >= item.column &&
      position.column < Math.max(item.endColumn, item.column + 1),
  );
}
