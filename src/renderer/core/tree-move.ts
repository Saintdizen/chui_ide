/**
 * Перенос файлов и папок дерева в целевую папку: какие шаги имеет смысл делать.
 *
 * Сам перенос — это `workspace.rename` (переименование внутри каталога и перенос
 * между каталогами — одна операция `fs.rename`). Здесь решается, ЧТО переносить:
 * бессмысленные и опасные шаги отсеиваются до запроса, иначе часть из них упала бы
 * уже на диске и человек увидел бы ошибку там, где её не должно быть вовсе.
 */

import { isInsidePath, joinPath, nameOf } from '../../shared/paths';

export interface MoveStep {
  readonly from: string;
  readonly to: string;
}

/**
 * Шаги переноса выбранных путей в `targetDir`.
 *
 * Пропускаем:
 *   • путь, который уже лежит в целевой папке (переезд в никуда);
 *   • папку, переезжающую внутрь себя или своего потомка (путь стал бы цикличным);
 *   • вложенный путь, если вместе с ним едет его предок: он уедет с ним, а
 *     отдельный шаг споткнулся бы о уже несуществующий старый путь.
 */
export function movePlan(paths: readonly string[], targetDir: string): MoveStep[] {
  return planInto(paths, targetDir);
}

/**
 * План копирования: шаги те же, что у переноса, — отсеиваются те же бессмысленные
 * случаи (в ту же папку, внутрь себя, вложенное при едущем предке).
 */
export function copyPlan(paths: readonly string[], targetDir: string): MoveStep[] {
  return planInto(paths, targetDir);
}

/**
 * Почему внутренний перенос в эту папку не даст ни одного шага.
 *
 * Дерево отбрасывает бессмысленные шаги в `planInto`, и это правильно: иначе
 * папка уехала бы внутрь себя. Неправильно было другое — ОНО МОЛЧАЛО. Человек
 * бросает папку на её же подпапку и не видит ни переноса, ни причины: выглядит
 * как сломанное перетаскивание, а не как отказ.
 *
 * Возвращает ключ причины, а не готовый текст: формулировку собирает тот, кто
 * знает, КАКОЙ именно файл назвать.
 */
export type InternalSkip = 'inside-itself' | 'under-selected' | 'same-dir';

export function internalSkip(paths: readonly string[], targetDir: string): { first: string; why: InternalSkip } | null {
  if (paths.length === 0) return null;
  if (planInto(paths, targetDir).length > 0) return null;
  // Порядок проверок здесь обратен `planInto`, и это НЕ ошибка: в плане
  // `same-dir` идёт первым, потому что у него своё дело — не порождать шаг.
  // Здесь же мы объясняем: если файл едет вместе с предком, то он и так уже
  // уезжает, и «уже лежит тут» будет ложью по смыслу. Поэтому вложенный
  // случай проверяется РАНЬШЕ и перебивает безобидный `same-dir`.
  for (const from of paths) {
    const underSelected = paths.some((other) => other !== from && isInsidePath(other, from));
    if (underSelected) return { first: from, why: 'under-selected' };
  }
  for (const from of paths) {
    const to = joinPath(targetDir, nameOf(from));
    if (to === from) return { first: from, why: 'same-dir' };
    if (isInsidePath(from, to)) return { first: from, why: 'inside-itself' };
  }
  return null;
}

function planInto(paths: readonly string[], targetDir: string): MoveStep[] {
  const steps: MoveStep[] = [];
  for (const from of paths) {
    const to = joinPath(targetDir, nameOf(from));
    if (to === from) continue;
    if (isInsidePath(from, to)) continue;
    const underSelected = paths.some((other) => other !== from && isInsidePath(other, from));
    if (underSelected) continue;
    steps.push({ from, to });
  }
  return steps;
}
